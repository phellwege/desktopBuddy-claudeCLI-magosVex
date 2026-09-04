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
