import json, os, sys
import numpy as np
import pytest
sys.path.insert(0, os.path.dirname(__file__))
from clean import clean_alpha
from slice import Box, components, group_frames, normalize, pack_atlas, build


def test_clean_alpha_thresholds_and_stretches():
    a = np.array([0, 20, 99, 100, 165, 230, 254, 255], dtype=np.uint8)
    out = clean_alpha(a, threshold=100, full=230)
    assert out.tolist() == [0, 0, 0, 0, 127, 255, 255, 255]
    assert out.dtype == np.uint8


def synthetic_sheet():
    """Two 20x70 bodies at x=10 and x=60 on the same baseline, a 6x6 fragment above the first,
    a wide 40x8 label-like fragment above the second (must be dropped)."""
    a = np.zeros((120, 120), dtype=np.uint8)
    a[40:110, 10:30] = 255
    a[40:110, 60:80] = 255
    a[20:26, 15:21] = 255      # fragment for body 0
    a[10:18, 55:95] = 255      # wide fragment: aspect 5, dropped
    return a


def test_components_finds_four_boxes():
    boxes = components(synthetic_sheet())
    assert len(boxes) == 4
    assert all(isinstance(b, Box) for b in boxes)


def test_group_frames_attaches_fragments_and_drops_labels():
    band = {"name": "t", "x": [0, 120], "y": [0, 120], "count": 2}
    frames = group_frames(synthetic_sheet(), band, 1.0, {})
    assert len(frames) == 2
    (box0, cx0), (box1, cx1) = frames
    assert box0.y0 == 20 and box0.y1 == 110 and box0.x0 == 10 and box0.x1 == 30
    assert cx0 == pytest.approx(20)
    assert box1.y0 == 40 and box1.x0 == 60 and box1.x1 == 80


def test_group_frames_count_mismatch_raises():
    band = {"name": "t", "x": [0, 120], "y": [0, 120], "count": 3}
    with pytest.raises(ValueError):
        group_frames(synthetic_sheet(), band, 1.0, {})


def test_group_frames_merge_override():
    band = {"name": "t", "x": [0, 120], "y": [0, 120], "count": 1}
    frames = group_frames(synthetic_sheet(), band, 1.0, {"t": {"merge": [[0, 1]]}})
    assert len(frames) == 1
    assert frames[0][0].x0 == 10 and frames[0][0].x1 == 80


def test_normalize_anchor_is_feet_center():
    a = synthetic_sheet()
    rgba = np.dstack([np.full_like(a, 200)] * 3 + [a])
    crop, ax, ay = normalize(rgba, Box(10, 20, 30, 110), 20.0)
    assert crop.shape == (90, 20, 4)
    assert ax == 10 and ay == 90


def test_pack_atlas_no_overlap_and_anchors():
    f1 = np.zeros((30, 20, 4), dtype=np.uint8); f1[..., 3] = 255
    f2 = np.zeros((50, 10, 4), dtype=np.uint8); f2[..., 3] = 255
    img, meta = pack_atlas([("a", f1, 10, 30), ("b", f2, 5, 50)], max_width=64, pad=2)
    fa, fb = meta["frames"]["a"], meta["frames"]["b"]
    assert fa["ax"] == 10 and fa["ay"] == 30 and fb["ax"] == 5 and fb["ay"] == 50
    ra = (fa["x"], fa["y"], fa["x"] + fa["w"], fa["y"] + fa["h"])
    rb = (fb["x"], fb["y"], fb["x"] + fb["w"], fb["y"] + fb["h"])
    assert ra[2] <= rb[0] or rb[2] <= ra[0] or ra[3] <= rb[1] or rb[3] <= ra[1]
    assert meta["maxFrameSize"] == [20, 50]
    assert img.shape[1] <= 64


def test_build_on_synthetic(tmp_path):
    from PIL import Image
    a = synthetic_sheet()
    rgba = np.dstack([np.full_like(a, 200)] * 3 + [a])
    sheet = tmp_path / "sheet.png"; Image.fromarray(rgba).save(sheet)
    rows = tmp_path / "rows.json"
    rows.write_text(json.dumps({"bands": [{"name": "idle", "x": [0, 120], "y": [0, 120], "count": 2}]}))
    ov = tmp_path / "ov.json"; ov.write_text("{}")
    out = tmp_path / "out"
    counts = build(str(sheet), str(rows), str(ov), str(out), 1.0)
    assert counts == {"idle": 2}
    atlas = json.loads((out / "atlas.json").read_text())
    assert set(atlas["frames"]) == {"idle_0", "idle_1"}
    draft = json.loads((out / "animations.draft.json").read_text())
    assert draft["idle"] == {"frames": ["idle_0", "idle_1"]}


def test_group_frames_each_mode():
    band = {"name": "props", "x": [0, 120], "y": [0, 120], "count": 0, "each": True}
    frames = group_frames(synthetic_sheet(), band, 1.0, {})
    assert len(frames) == 4
    boxes = [b for b, _ in frames]
    assert [(b.x0, b.y0) for b in boxes] == sorted((b.x0, b.y0) for b in boxes)
    for b, cx in frames:
        assert cx == pytest.approx(b.cx)
    # the wide label-like fragment is kept as its own frame in each mode, not dropped
    assert any(b.x0 == 55 and b.y0 == 10 and b.x1 == 95 and b.y1 == 18 for b in boxes)


def test_build_each_mode_band(tmp_path):
    from PIL import Image
    a = synthetic_sheet()
    rgba = np.dstack([np.full_like(a, 200)] * 3 + [a])
    sheet = tmp_path / "sheet.png"; Image.fromarray(rgba).save(sheet)
    rows = tmp_path / "rows.json"
    rows.write_text(json.dumps({"bands": [
        {"name": "props", "x": [0, 120], "y": [0, 120], "count": 0, "each": True}
    ]}))
    ov = tmp_path / "ov.json"; ov.write_text("{}")
    out = tmp_path / "out"
    counts = build(str(sheet), str(rows), str(ov), str(out), 1.0)
    assert counts == {"props": 4}
    atlas = json.loads((out / "atlas.json").read_text())
    assert set(atlas["frames"]) == {"props_0", "props_1", "props_2", "props_3"}
    draft = json.loads((out / "animations.draft.json").read_text())
    assert "props" not in draft


from key import key_background
from upscale import upscale


def test_key_background_removes_connected_background_only():
    # 60x60 RGB: 1px black frame, gray interior, a red 20x20 block in the middle,
    # and a gray 4x4 "hole" inside the block that must stay opaque.
    im = np.full((60, 60, 3), (50, 48, 46), dtype=np.uint8)
    im[0, :] = im[-1, :] = im[:, 0] = im[:, -1] = (4, 3, 3)
    im[20:40, 20:40] = (180, 30, 30)
    im[28:32, 28:32] = (50, 48, 46)
    alpha = key_background(im, tolerance=36, inset=4)
    assert alpha.dtype == np.uint8 and alpha.shape == (60, 60)
    assert alpha[5, 5] == 0 and alpha[0, 0] == 0
    assert alpha[25, 25] == 255
    assert alpha[30, 30] == 255          # enclosed gray is not connected to the border


def test_key_background_tolerance_bounds():
    im = np.full((20, 20, 3), (50, 48, 46), dtype=np.uint8)
    im[8:12, 8:12] = (70, 48, 46)        # differs by 20: background at tolerance 36, foreground at 10
    assert key_background(im, tolerance=36, inset=2)[10, 10] == 0
    assert key_background(im, tolerance=10, inset=2)[10, 10] == 255


def test_facing_band_emits_flipped_frames(tmp_path):
    from PIL import Image
    a = synthetic_sheet()
    rgba = np.dstack([np.full_like(a, 200)] * 3 + [a])
    rgba[40:110, 10:15, 0] = 255         # a red stripe on the left edge of body 0 to detect flipping
    sheet = tmp_path / "sheet.png"; Image.fromarray(rgba).save(sheet)
    rows = tmp_path / "rows.json"
    rows.write_text(json.dumps({"bands": [{"name": "walk", "x": [0, 120], "y": [0, 120], "count": 2, "facing": "left"}]}))
    ov = tmp_path / "ov.json"; ov.write_text("{}")
    out = tmp_path / "out"
    counts = build(str(sheet), str(rows), str(ov), str(out), 1.0)
    assert counts == {"walk": 2}
    atlas = json.loads((out / "atlas.json").read_text())
    assert set(atlas["frames"]) == {"walk_left_0", "walk_left_1", "walk_right_0", "walk_right_1"}
    l, r = atlas["frames"]["walk_left_0"], atlas["frames"]["walk_right_0"]
    assert (l["w"], l["h"], l["ay"]) == (r["w"], r["h"], r["ay"])
    assert r["ax"] == l["w"] - l["ax"]
    img = np.array(Image.open(out / "atlas.png"))
    left_px = img[l["y"] + l["h"] - 1, l["x"] + 2]
    right_px = img[r["y"] + r["h"] - 1, r["x"] + r["w"] - 3]
    assert left_px[0] == 255 and right_px[0] == 255      # the red stripe moved to the other side
    draft = json.loads((out / "animations.draft.json").read_text())
    assert draft["walk"] == {"right": ["walk_right_0", "walk_right_1"], "left": ["walk_left_0", "walk_left_1"]}


def test_upscale_nearest_doubles_size(tmp_path):
    from PIL import Image
    src = tmp_path / "s.png"; dst = tmp_path / "d.png"
    Image.fromarray(np.zeros((3, 5, 4), dtype=np.uint8)).save(src)
    assert upscale(str(src), str(dst), 2, "nearest") == "nearest"
    assert Image.open(dst).size == (10, 6)


RAW = os.path.join(os.path.dirname(__file__), "..", "raw", "sheet.png")


@pytest.mark.skipif(not os.path.exists(RAW), reason="raw sheet not present")
def test_real_sheet_bands_match_rows(tmp_path):
    from PIL import Image
    rgb = np.array(Image.open(RAW).convert("RGB"))
    alpha = key_background(rgb)
    keyed = tmp_path / "keyed.png"; Image.fromarray(np.dstack([rgb, alpha])).save(keyed)
    rows_path = os.path.join(os.path.dirname(__file__), "rows.json")
    ov_path = os.path.join(os.path.dirname(__file__), "overrides.json")
    counts = build(str(keyed), rows_path, ov_path, str(tmp_path / "out"), 1.0)
    expected = {b["name"]: b["count"] for b in json.load(open(rows_path))["bands"] if not b.get("each")}
    assert {k: counts[k] for k in expected} == expected
    assert counts["faces"] == 8
    atlas = json.loads((tmp_path / "out" / "atlas.json").read_text())
    for name, f in atlas["frames"].items():
        assert 0 < f["ay"] <= f["h"] and 0 <= f["ax"] <= f["w"], name
    assert "walk_right_0" in atlas["frames"] and "run_left_2" in atlas["frames"]
