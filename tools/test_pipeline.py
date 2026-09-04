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
    # "components" split explicitly: this fixture's wide fragment is only 8px thick,
    # which is thick enough to survive object mode's core-finding erosion (it has no
    # height-threshold concept for cores, only for the legacy body/fragment split), so
    # this specific mismatch only fires on the legacy path. Object mode's own count-can't
    # -be-found case is covered by test_group_frames_objects_raises_when_cores_not_found.
    band = {"name": "t", "x": [0, 120], "y": [0, 120], "count": 3, "split": "components"}
    with pytest.raises(ValueError):
        group_frames(synthetic_sheet(), band, 1.0, {})


def test_group_frames_merge_override():
    # "components" split explicitly: "merge" is a components-mode-only override (object
    # mode has no merge concept - see the module docstring on _group_frames_objects), so
    # this test needs the legacy path to actually exercise it.
    band = {"name": "t", "x": [0, 120], "y": [0, 120], "count": 1, "split": "components"}
    frames = group_frames(synthetic_sheet(), band, 1.0, {"t": {"merge": [[0, 1]]}})
    assert len(frames) == 1
    assert frames[0][0].x0 == 10 and frames[0][0].x1 == 80


def test_group_frames_objects_raises_when_cores_not_found():
    # A single 40x40 blob can never split into 2 cores by erosion alone (there is no thin
    # bridge to sever), so object mode must give up and raise, naming the band.
    a = np.zeros((60, 60), dtype=np.uint8)
    a[10:50, 10:50] = 255
    band = {"name": "solo", "x": [0, 60], "y": [0, 60], "count": 2}
    with pytest.raises(ValueError, match="solo"):
        group_frames(a, band, 1.0, {})


def _rgba_from_alpha(a: np.ndarray) -> np.ndarray:
    return np.dstack([np.full_like(a, 200)] * 3 + [a])


def _scatter_ownership(rgba: np.ndarray, frames) -> tuple[np.ndarray, list]:
    """Paint each frame's owned pixels back onto a full-sheet-shaped array (1-based frame
    index, 0 = unowned), asserting no pixel is ever claimed by two frames. Returns the
    ownership array and the list of (box, ax, ay, crop) per frame in original order."""
    owned_by = np.zeros(rgba.shape[:2], dtype=np.int16)
    out = []
    for idx, (box, cx) in enumerate(frames, start=1):
        crop, ax, ay = normalize(rgba, box, cx)
        owned_here = crop[..., 3] > 0
        region = owned_by[box.y0:box.y1, box.x0:box.x1]
        assert not np.any((region != 0) & owned_here), f"frame {idx} overlaps an earlier frame"
        region[owned_here] = idx
        out.append((box, ax, ay, crop))
    return owned_by, out


def test_object_mode_splits_touching_figures_exactly():
    """Two 30x80 rectangles, far enough apart not to touch on their own, joined by a 2px
    -tall bridge across the gap - a synthetic stand-in for a staff crossing into a
    neighbor's panel, or two hoods pinched together by a shared prop."""
    a = np.zeros((100, 120), dtype=np.uint8)
    a[10:90, 10:40] = 255
    a[10:90, 60:90] = 255
    a[48:50, 40:60] = 255
    mask = a > 0
    total_mask_px = int(mask.sum())
    band = {"name": "pair", "x": [0, 120], "y": [0, 100], "count": 2}
    frames = group_frames(a, band, 1.0, {})
    assert len(frames) == 2
    rgba = _rgba_from_alpha(a)
    owned_by, per_frame = _scatter_ownership(rgba, frames)

    # every mask pixel (including the bridge) is claimed by exactly one frame
    assert int((owned_by != 0).sum()) == total_mask_px
    assert not np.any(mask & (owned_by == 0))

    # each frame's crop excludes the other rectangle's own interior point
    box_a, _, _, crop_a = min(per_frame, key=lambda f: f[0].cx)
    box_b, _, _, crop_b = max(per_frame, key=lambda f: f[0].cx)
    by, bx = 50, 75  # deep inside figure B's own rectangle
    if box_a.y0 <= by < box_a.y1 and box_a.x0 <= bx < box_a.x1:
        assert crop_a[by - box_a.y0, bx - box_a.x0, 3] == 0
    ay_, ax_ = 50, 25  # deep inside figure A's own rectangle
    if box_b.y0 <= ay_ < box_b.y1 and box_b.x0 <= ax_ < box_b.x1:
        assert crop_b[ay_ - box_b.y0, ax_ - box_b.x0, 3] == 0


def test_object_mode_attaches_floating_fragment_to_nearest_object_only():
    """A small disconnected fragment (a floating skull companion) sits above figure A,
    far closer to A than to B; it must be unioned into A's crop and never appear in B's."""
    a = np.zeros((140, 120), dtype=np.uint8)
    a[50:130, 10:40] = 255       # figure A
    a[50:130, 80:110] = 255      # figure B
    a[10:20, 18:28] = 255        # floating fragment near A's center x (25)
    band = {"name": "pair", "x": [0, 120], "y": [0, 140], "count": 2}
    frames = group_frames(a, band, 1.0, {})
    assert len(frames) == 2
    rgba = _rgba_from_alpha(a)
    _scatter_ownership(rgba, frames)
    box_a, cx_a = min(frames, key=lambda f: f[0].cx)
    box_b, cx_b = max(frames, key=lambda f: f[0].cx)
    crop_a, _, _ = normalize(rgba, box_a, cx_a)
    crop_b, _, _ = normalize(rgba, box_b, cx_b)
    fy, fx = 15, 23
    assert box_a.y0 <= fy < box_a.y1 and box_a.x0 <= fx < box_a.x1
    assert crop_a[fy - box_a.y0, fx - box_a.x0, 3] > 0
    if box_b.y0 <= fy < box_b.y1 and box_b.x0 <= fx < box_b.x1:
        assert crop_b[fy - box_b.y0, fx - box_b.x0, 3] == 0
    else:
        assert box_b.y0 > 10  # B's box simply never reaches that far up


def test_object_mode_staff_keeps_whole_bar_neighbor_crop_zero_there():
    """Figure A holds a thin 3px-wide vertical staff, connected to A via a thin arm, that
    lands inside figure B's bounding box (B's own box is stretched up by its own small
    disconnected fragment, far sideways from the staff). No pixel of A ever touches a
    pixel of B - this mirrors the real jump_2/jump_3 bug, where two genuinely separate
    poses' bounding boxes overlapped but their real content never did."""
    a = np.zeros((140, 120), dtype=np.uint8)
    a[40:110, 10:40] = 255      # A body
    a[42:45, 40:96] = 255       # A arm, connects body to staff
    a[15:45, 93:96] = 255       # A staff (3px wide), pokes up into B's bbox
    a[60:130, 70:100] = 255     # B body
    a[15:23, 83:91] = 255       # B's own floating fragment, stretches B's bbox up
    staff_px = int((a[15:45, 93:96] > 0).sum())
    band = {"name": "pair", "x": [0, 120], "y": [0, 140], "count": 2}
    frames = group_frames(a, band, 1.0, {})
    assert len(frames) == 2
    rgba = _rgba_from_alpha(a)
    _scatter_ownership(rgba, frames)
    box_a, cx_a = frames[0]
    box_b, cx_b = frames[1]
    crop_a, _, _ = normalize(rgba, box_a, cx_a)
    crop_b, _, _ = normalize(rgba, box_b, cx_b)

    # A's crop keeps the entire staff
    sy0, sy1, sx0, sx1 = 15, 45, 93, 96
    staff_in_a = crop_a[sy0 - box_a.y0:sy1 - box_a.y0, sx0 - box_a.x0:sx1 - box_a.x0, 3]
    assert int((staff_in_a > 0).sum()) == staff_px

    # the boxes genuinely overlap (this is the case the exclusion mechanism exists for)
    assert box_a.x1 > box_b.x0 and box_a.y1 > box_b.y0

    # B's crop reads alpha 0 everywhere A's arm or staff falls inside B's own box
    for y0, y1, x0, x1 in [(42, 45, 40, 96), (15, 45, 93, 96)]:
        oy0, oy1 = max(y0, box_b.y0), min(y1, box_b.y1)
        ox0, ox1 = max(x0, box_b.x0), min(x1, box_b.x1)
        if oy0 < oy1 and ox0 < ox1:
            region = crop_b[oy0 - box_b.y0:oy1 - box_b.y0, ox0 - box_b.x0:ox1 - box_b.x0, 3]
            assert int((region > 0).sum()) == 0


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


def test_group_frames_each_mode_erase_override_splits_touching_icons():
    """Two 20x20 icons touching via a 1px-wide, 2px-tall bridge look like one component
    by default; an "erase" override that blanks the bridge in the labeling copy (not the
    source pixels) must split them back into two, since "each" mode has no merge/drop path."""
    a = np.zeros((40, 60), dtype=np.uint8)
    a[10:30, 5:25] = 255
    a[10:30, 26:46] = 255
    a[19:21, 25:26] = 255
    band = {"name": "icons", "x": [0, 60], "y": [0, 40], "count": 0, "each": True}
    frames = group_frames(a, band, 1.0, {})
    assert len(frames) == 1
    frames_erased = group_frames(a, band, 1.0, {"icons": {"erase": [[24, 18, 27, 22]]}})
    assert len(frames_erased) == 2
    # erase only affects the labeling copy: the source array is untouched
    assert a[19, 25] == 255


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


def test_each_mode_ignores_specks_at_scale():
    # Three isolated single-pixel specks (antialiasing/glow artifacts) on top of the
    # normal synthetic sheet. At 1x they are 1 px, well under the min_px=4 floor.
    # Nearest-upscaled 2x they become 2x2=4 px blocks; the floor must scale too
    # (to max(4, round(4*scale*scale)) = 16 at scale 2) or they get miscounted as frames.
    a = synthetic_sheet()
    a[5, 100] = 255
    a[100, 5] = 255
    a[115, 115] = 255
    band = {"name": "props", "x": [0, 120], "y": [0, 120], "count": 0, "each": True}
    frames_1x = group_frames(a, band, 1.0, {})
    assert len(frames_1x) == 4
    a2x = np.kron(a, np.ones((2, 2), dtype=np.uint8)).astype(np.uint8)
    band_2x = {"name": "props", "x": [0, 120], "y": [0, 120], "count": 0, "each": True}
    frames_2x = group_frames(a2x, band_2x, 2.0, {})
    assert len(frames_2x) == 4


from key import key_background, key_background_bands, band_rects
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


def test_key_background_thin_leak_guard_keeps_interior_opaque():
    # 30x30: background gray everywhere, a 20x20 dark "hood" ring (3px thick walls) with a
    # background-colored interior cavity, and a single dark-gap-sized (1 row tall) corridor
    # punched through the ring's left wall connecting the cavity straight to the exterior.
    # Without the thin-leak guard the corridor lets the border flood fill reach the cavity
    # and the whole interior wrongly keys transparent, exactly the v4 hood/eye leak bug.
    bg, dark = (50, 48, 46), (10, 10, 10)
    im = np.full((30, 30, 3), bg, dtype=np.uint8)
    im[5:25, 5:25] = dark
    im[8:22, 8:22] = bg              # enclosed cavity, same color as background
    im[14:15, 5:8] = bg              # one-row-tall gap cutting straight through the left wall
    alpha = key_background(im, tolerance=16, inset=2)
    assert alpha[1, 1] == 0          # exterior still keys out normally
    assert alpha[15, 15] == 255      # cavity interior stays opaque despite the thin leak path


def test_key_background_bands_different_fills():
    # Two side-by-side panels with different uniform fill colors, each with its own figure,
    # plus a strip that belongs to neither band.
    im = np.zeros((40, 90, 3), dtype=np.uint8)
    im[:, :40] = (200, 200, 200)
    im[:, 40:50] = (255, 0, 255)          # outside every band; must key transparent regardless
    im[:, 50:90] = (30, 30, 30)
    im[10:30, 10:30] = (200, 30, 30)      # figure in band 1, far outside band 1's tolerance
    im[10:30, 60:80] = (30, 200, 30)      # figure in band 2, far outside band 2's tolerance
    bands = [(0, 0, 40, 40), (50, 0, 90, 40)]
    alpha = key_background_bands(im, bands, tolerance=16, inset=2)
    assert alpha[5, 5] == 0 and alpha[5, 65] == 0        # each panel's own fill keys transparent
    assert alpha[15, 15] == 255 and alpha[15, 70] == 255  # each panel's figure stays opaque
    assert alpha[5, 45] == 0                              # outside every band: transparent


def test_key_background_bands_overlap_background_wins():
    # Band B covers the whole image (its ring samples the true background, so it correctly
    # keys the figure opaque). Band A's rect is exactly the figure's own footprint, so its
    # ring samples the figure's own color and keys that whole rect as "background". Where
    # they overlap, background must win.
    im = np.full((30, 30, 3), (40, 40, 40), dtype=np.uint8)
    im[10:20, 10:20] = (200, 30, 30)
    bands = [(0, 0, 30, 30), (10, 10, 20, 20)]
    alpha = key_background_bands(im, bands, tolerance=16, inset=2)
    assert alpha[5, 5] == 0
    assert alpha[15, 15] == 0


def test_band_rects_scales_and_rounds():
    bands = [{"name": "a", "x": [10, 20], "y": [5, 15]}]
    assert band_rects(bands, 1.0) == [(10, 5, 20, 15)]
    assert band_rects(bands, 2.0) == [(20, 10, 40, 30)]


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
    rows_path = os.path.join(os.path.dirname(__file__), "rows.json")
    ov_path = os.path.join(os.path.dirname(__file__), "overrides.json")
    rows = json.load(open(rows_path))
    tolerance = rows.get("keyTolerance", 16)
    rgb = np.array(Image.open(RAW).convert("RGB"))
    alpha = key_background_bands(rgb, band_rects(rows["bands"], 1.0), tolerance)
    keyed = tmp_path / "keyed.png"; Image.fromarray(np.dstack([rgb, alpha])).save(keyed)
    counts = build(str(keyed), rows_path, ov_path, str(tmp_path / "out"), 1.0)
    expected = {b["name"]: b["count"] for b in rows["bands"] if not b.get("each")}
    assert {k: counts[k] for k in expected} == expected
    assert counts["faces"] == 10
    atlas = json.loads((tmp_path / "out" / "atlas.json").read_text())
    for name, f in atlas["frames"].items():
        assert 0 < f["ay"] <= f["h"] and 0 <= f["ax"] <= f["w"], name
    assert "walk_right_0" in atlas["frames"] and "run_left_2" in atlas["frames"] and "run_left_3" in atlas["frames"]
    assert "rest_3" in atlas["frames"]

    # every pair of adjacent frames within these touching-content bands must never both be
    # opaque at the same sheet coordinate - object mode's exclusion has to be exact, not
    # just frame-count-correct.
    ov = json.load(open(ov_path))
    rgba_full = np.dstack([rgb, alpha])
    for bname in ("walk", "run", "sit", "rest", "usetech"):
        band = next(b for b in rows["bands"] if b["name"] == bname)
        band_frames = group_frames(alpha, band, 1.0, ov)
        crops = [normalize(rgba_full, box, cx) for box, cx in band_frames]
        for i in range(len(band_frames) - 1):
            b1, b2 = band_frames[i][0], band_frames[i + 1][0]
            c1, c2 = crops[i][0], crops[i + 1][0]
            ox0, oy0 = max(b1.x0, b2.x0), max(b1.y0, b2.y0)
            ox1, oy1 = min(b1.x1, b2.x1), min(b1.y1, b2.y1)
            if ox0 >= ox1 or oy0 >= oy1:
                continue  # boxes don't even overlap, trivially disjoint
            r1 = c1[oy0 - b1.y0:oy1 - b1.y0, ox0 - b1.x0:ox1 - b1.x0, 3] > 0
            r2 = c2[oy0 - b2.y0:oy1 - b2.y0, ox0 - b2.x0:ox1 - b2.x0, 3] > 0
            assert not np.any(r1 & r2), f"{bname} frames {i}/{i + 1} share an opaque sheet pixel"

    # at 2x nearest-upscale, the "each" mode bands (faces, props) must not pick up
    # antialiasing/glow specks that only clear the min_px floor because of the upscale.
    keyed_2x = tmp_path / "keyed@2x.png"
    assert upscale(str(keyed), str(keyed_2x), 2, "nearest") == "nearest"
    counts_2x = build(str(keyed_2x), rows_path, ov_path, str(tmp_path / "out2x"), 2.0)
    assert counts_2x["faces"] == 10
    assert counts_2x["props"] == counts["props"]
