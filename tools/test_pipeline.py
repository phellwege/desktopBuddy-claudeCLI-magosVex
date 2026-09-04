import json, os, sys
import numpy as np
import pytest
sys.path.insert(0, os.path.dirname(__file__))
from clean import clean_alpha
from slice import Box, components, group_frames, normalize, pack_atlas, build
import slice as slice_mod
import segment_sam
from segment_sam import (
    resolve_ownership, is_hairline, in_numeral_strip, is_text_label,
    compute_anchor, contact_length, largest_component_centroid,
    fragment_pixel_distance, nearest_by_distance, expand_rect, rect_contains,
    rects_intersect, mask_bbox, mask_overlap_fraction,
)


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


# ---------------------------------------------------------------------------------
# SAM-mode (tools/segment_sam.py): pure helper functions, none of which need the model
# or CUDA. The model-dependent segment_band() itself is only exercised by the skipif
# integration test at the bottom of this file.
# ---------------------------------------------------------------------------------

def test_resolve_ownership_picks_higher_logit_on_overlap():
    mask_a = np.zeros((10, 10), dtype=bool); mask_a[:, :6] = True
    mask_b = np.zeros((10, 10), dtype=bool); mask_b[:, 4:] = True  # overlaps cols 4-5 with a
    logits_a = np.full((10, 10), 1.0)
    logits_b = np.full((10, 10), 1.0)
    logits_b[:, 4:6] = 5.0  # b wins the contested columns
    owner = resolve_ownership([mask_a, mask_b], [logits_a, logits_b])
    assert (owner[:, :4] == 1).all()   # a-only region
    assert (owner[:, 4:6] == 2).all()  # contested region: b's higher logit wins
    assert (owner[:, 6:] == 2).all()   # b-only region


def test_resolve_ownership_three_way_overlap_finds_true_max():
    # all three masks claim the same single pixel; ownership must reflect the global max
    # logit, not just a pairwise comparison against whichever mask was applied first.
    shape = (5, 5)
    masks = [np.zeros(shape, dtype=bool) for _ in range(3)]
    for m in masks:
        m[2, 2] = True
    logits = [np.full(shape, v) for v in (1.0, 9.0, 4.0)]
    owner = resolve_ownership(masks, logits)
    assert owner[2, 2] == 2  # the middle mask (index 1) has the highest logit, 1-based id 2


def test_resolve_ownership_no_masks_returns_empty():
    assert resolve_ownership([], []).shape == (0, 0)


def test_is_hairline_thin_and_long_either_orientation():
    assert is_hairline(w=2, h=40, max_thickness=3, min_length=30)
    assert is_hairline(w=40, h=2, max_thickness=3, min_length=30)  # transpose
    assert not is_hairline(w=10, h=40, max_thickness=3, min_length=30)  # too thick
    assert not is_hairline(w=2, h=10, max_thickness=3, min_length=30)   # too short


def test_in_numeral_strip_only_when_fully_inside():
    assert in_numeral_strip(50, 60, (48, 63))
    assert not in_numeral_strip(50, 70, (48, 63))   # pokes out the bottom
    assert not in_numeral_strip(40, 60, (48, 63))   # pokes out the top
    assert not in_numeral_strip(50, 60, None)       # no strip configured: never drop


def test_fragment_pixel_distance_measures_gap_not_point_x():
    mask = np.zeros((30, 30), dtype=bool); mask[10:20, 10:20] = True
    frag = np.zeros((30, 30), dtype=bool); frag[10:20, 25:27] = True  # nearest cols 19 vs 25
    assert fragment_pixel_distance(frag, mask) == pytest.approx(6.0)
    touching = np.zeros((30, 30), dtype=bool); touching[10:20, 20:21] = True
    assert fragment_pixel_distance(touching, mask) == pytest.approx(1.0)


def test_fragment_pixel_distance_inf_when_either_empty():
    a = np.zeros((10, 10), dtype=bool); a[2:4, 2:4] = True
    empty = np.zeros((10, 10), dtype=bool)
    assert fragment_pixel_distance(a, empty) == float("inf")
    assert fragment_pixel_distance(empty, a) == float("inf")


def test_nearest_by_distance_picks_closest_within_reach():
    near = np.zeros((30, 60), dtype=bool); near[10:20, 0:10] = True
    far = np.zeros((30, 60), dtype=bool); far[10:20, 40:50] = True
    frag_close = np.zeros((30, 60), dtype=bool); frag_close[10:20, 15:17] = True  # 5px from `near`
    frag_between = np.zeros((30, 60), dtype=bool); frag_between[10:20, 25:27] = True  # far from both
    assert nearest_by_distance(frag_close, [near, far], max_distance=12) == 0
    assert nearest_by_distance(frag_between, [near, far], max_distance=12) is None
    assert nearest_by_distance(frag_close, [], max_distance=12) is None


def test_is_text_label_position_and_height_gate():
    # entirely above the topmost object row by more than the gap, and short: a label
    assert is_text_label(frag_y0=5, frag_y1=15, frag_h=10, topmost_object_row=50,
                          min_gap=4, max_height=18)
    # too tall to be a label word (a skull/effect that just happens to sit high)
    assert not is_text_label(frag_y0=5, frag_y1=25, frag_h=20, topmost_object_row=50,
                              min_gap=4, max_height=18)
    # not far enough above the object row (within the gap tolerance)
    assert not is_text_label(frag_y0=5, frag_y1=48, frag_h=43, topmost_object_row=50,
                              min_gap=4, max_height=18)


def test_expand_rect_widens_each_side_proportionally():
    assert expand_rect((10, 20, 30, 40), 0.15) == pytest.approx((7.0, 17.0, 33.0, 43.0))


def test_rect_contains_and_rects_intersect():
    outer = (0, 0, 100, 100)
    assert rect_contains(outer, (10, 10, 90, 90))
    assert not rect_contains(outer, (-5, 10, 90, 90))   # pokes out the left
    assert not rect_contains(outer, (10, 10, 105, 90))  # pokes out the right
    assert rects_intersect((0, 0, 10, 10), (5, 5, 15, 15))
    assert not rects_intersect((0, 0, 10, 10), (10, 0, 20, 10))  # edge-adjacent, no area


def test_mask_bbox_and_overlap_fraction():
    mask = np.zeros((50, 50), dtype=bool)
    mask[10:30, 10:20] = True  # 20x10 = 200px, all inside cell below
    assert mask_bbox(mask) == (10, 10, 20, 30)
    assert mask_bbox(np.zeros((5, 5), dtype=bool)) is None
    assert mask_overlap_fraction(mask, (0, 0, 50, 50)) == pytest.approx(1.0)
    assert mask_overlap_fraction(mask, (0, 0, 15, 50)) == pytest.approx(0.5)  # half the cols
    assert mask_overlap_fraction(np.zeros((5, 5), dtype=bool), (0, 0, 5, 5)) == 1.0


def test_compute_anchor_is_feet_centroid():
    mask = np.zeros((100, 60), dtype=bool)
    mask[0:90, 20:30] = True   # tall narrow body, rows 0-89
    mask[81:90, 0:49] = True   # feet: widen just the lowest ~10% of rows, off-center
    ax, ay = compute_anchor(mask)
    assert ay == 90            # one past the lowest occupied row
    assert ax == 24            # centroid x of rows >= 81 only (0..48 -> mean 24), not the
                                # narrow upper-body columns 20-29


def test_compute_anchor_raises_on_empty_mask():
    with pytest.raises(ValueError):
        compute_anchor(np.zeros((10, 10), dtype=bool))


def test_contact_length_counts_touching_pixel_pairs():
    a = np.zeros((10, 10), dtype=bool); a[:, :5] = True
    b = np.zeros((10, 10), dtype=bool); b[:, 5:] = True
    assert contact_length(a, b) == 10  # one shared vertical seam, 10 rows tall
    c = np.zeros((10, 10), dtype=bool); c[:, 7:] = True  # never touches a
    assert contact_length(a, c) == 0


def test_largest_component_centroid_picks_biggest_blob():
    mask = np.zeros((20, 20), dtype=bool)
    mask[1:3, 1:3] = True       # small blob, 4px
    mask[10:16, 10:16] = True   # bigger blob, 36px, centered at (12.5, 12.5)
    assert largest_component_centroid(mask) == pytest.approx((12.5, 12.5))


def test_largest_component_centroid_none_when_empty():
    assert largest_component_centroid(np.zeros((5, 5), dtype=bool)) is None


def test_touching_owner_picks_the_mask_with_most_contact():
    a = np.zeros((20, 20), dtype=bool); a[:, :5] = True
    b = np.zeros((20, 20), dtype=bool); b[:, 15:] = True
    frag = np.zeros((20, 20), dtype=bool); frag[2:6, 5:6] = True  # touches a on 4 rows, b on none
    assert segment_sam.touching_owner(frag, [a, b]) == 0


def test_touching_owner_none_when_isolated():
    a = np.zeros((20, 20), dtype=bool); a[:, :5] = True
    frag = np.zeros((20, 20), dtype=bool); frag[2:6, 10:11] = True  # nowhere near a
    assert segment_sam.touching_owner(frag, [a]) is None
    assert segment_sam.touching_owner(frag, []) is None


def test_group_frames_sam_fragment_pipeline_end_to_end(monkeypatch):
    """End-to-end exercise of _group_frames_sam's full fragment pipeline, without a real
    model: segment_sam.segment_band is monkeypatched to return two fixed SAM objects
    plus their cells/crop_box. Covers, in the order the pipeline applies them:
    numeral-strip drop, text-label drop (a title/label word the wide crop margin pulled
    into scope), touching-owner reattachment of a notch that would otherwise match the
    hairline rule, aspect/hairline drop of a genuinely isolated sliver, and the tightened
    distance-based attach/drop (a fragment 8px from an object attaches; one 28px away -
    which the old, wider point-proximity rule would have attached - is now dropped)."""
    h, w = 150, 220
    alpha = np.zeros((h, w), dtype=np.uint8)
    obj0 = np.zeros((h, w), dtype=bool); obj0[50:110, 20:50] = True       # 60x30 = 1800px
    obj1 = np.zeros((h, w), dtype=bool); obj1[50:110, 130:160] = True     # 60x30 = 1800px
    notch = np.zeros((h, w), dtype=bool); notch[65:100, 50:51] = True    # 1x35, touches obj0's right edge
    close = np.zeros((h, w), dtype=bool); close[70:78, 8:16] = True      # 8x8, 5px left of obj0 - within reach
    far = np.zeros((h, w), dtype=bool); far[15:23, 25:33] = True         # 8x8, 28px above obj0 - out of reach
    numeral = np.zeros((h, w), dtype=bool); numeral[0:4, 60:64] = True   # 4x4, inside numeralStrip [0,8)
    text = np.zeros((h, w), dtype=bool); text[5:15, 90:150] = True       # 10x60, well above and short: a label
    hairline = np.zeros((h, w), dtype=bool); hairline[20:60, 170:172] = True  # 2px wide, 40 tall, touches nothing

    alpha[obj0 | obj1 | notch | close | far | numeral | text | hairline] = 255
    rgb = np.zeros((h, w, 3), dtype=np.uint8)

    fake_points = [(35.0, 80.0), (145.0, 80.0)]
    fake_cells = [(10.0, 10.0, 110.0, 130.0), (110.0, 10.0, 210.0, 130.0)]
    fake_crop_box = (0, 0, w, h)
    fake_masks = [obj0, obj1]
    fake_logits = [np.where(obj0, 1.0, -1.0), np.where(obj1, 1.0, -1.0)]

    def fake_segment_band(rgb_, alpha_, band, scale, model, processor, other_bands=None):
        return {"boxes": [(0, 0, 0, 0), (0, 0, 0, 0)], "points": fake_points,
                "cells": fake_cells, "crop_box": fake_crop_box,
                "masks": fake_masks, "logits": fake_logits}

    monkeypatch.setattr(slice_mod.segment_sam, "segment_band", fake_segment_band)

    band = {"name": "t", "x": [10, 210], "y": [10, 130], "count": 2, "numeralStrip": [0, 8]}
    diagnostics = {}
    frames = slice_mod._group_frames_sam(rgb, alpha, band, 1.0, diagnostics=diagnostics)
    assert len(frames) == 2
    box0, cx0 = frames[0]
    box1, cx1 = frames[1]
    assert cx0 == 35.0 and cx1 == 145.0

    def owns(box, gy, gx):
        return box.y0 <= gy < box.y1 and box.x0 <= gx < box.x1 and \
            box.owner_mask[gy - box.y0, gx - box.x0]

    # notch (touching) and close (5px, within the 12px reach) both join frame 0
    assert owns(box0, 80, 50)   # inside `notch`
    assert owns(box0, 74, 12)   # inside `close`
    assert int(box0.owner_mask.sum()) == 1800 + 35 + 64
    assert int(box1.owner_mask.sum()) == 1800  # frame 1 is untouched

    # numeral, text label, far (28px - outside the tightened 12px reach), and the
    # isolated hairline are all dropped: owned by neither frame
    assert not owns(box0, 2, 62) and not owns(box1, 2, 62)      # numeral
    assert not owns(box0, 10, 120) and not owns(box1, 10, 120)  # text label
    assert not owns(box0, 18, 29) and not owns(box1, 18, 29)    # far
    assert not owns(box0, 30, 170) and not owns(box1, 30, 170)  # hairline

    assert diagnostics["t"]["areas"] == [1800, 1800]
    attached = diagnostics["t"]["attached_fragments"]
    assert len(attached) == 2
    assert [0, [50, 65, 51, 100]] in attached  # notch, attached by touching obj0
    assert [0, [8, 70, 16, 78]] in attached    # close, attached by distance
    dropped = diagnostics["t"]["dropped_fragments"]
    assert len(dropped) == 4
    assert [60, 0, 64, 4] in dropped     # numeral strip
    assert [90, 5, 150, 15] in dropped   # text label
    assert [25, 15, 33, 23] in dropped   # far: out of the tightened reach
    assert [170, 20, 172, 60] in dropped  # isolated hairline
    assert diagnostics["t"]["contact"] == [{"pair": [0, 1], "contact": 0}]


def test_group_frames_sam_raises_on_area_outlier(monkeypatch):
    """One object far smaller than the other must raise a ValueError naming the band and
    the offending area, before any fragment/anchor work happens."""
    h, w = 100, 200
    alpha = np.zeros((h, w), dtype=np.uint8)
    obj0 = np.zeros((h, w), dtype=bool); obj0[10:90, 10:40] = True    # 80x30 = 2400px
    obj1 = np.zeros((h, w), dtype=bool); obj1[10:20, 100:110] = True  # 10x10 = 100px, far smaller
    alpha[obj0 | obj1] = 255
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    fake_points = [(25.0, 50.0), (105.0, 15.0)]
    fake_cells = [(0.0, 0.0, 100.0, 100.0), (100.0, 0.0, 200.0, 100.0)]

    def fake_segment_band(rgb_, alpha_, band, scale, model, processor, other_bands=None):
        return {"boxes": [(0, 0, 0, 0), (0, 0, 0, 0)], "points": fake_points,
                "cells": fake_cells, "crop_box": (0, 0, w, h),
                "masks": [obj0, obj1],
                "logits": [np.where(obj0, 1.0, -1.0), np.where(obj1, 1.0, -1.0)]}

    monkeypatch.setattr(slice_mod.segment_sam, "segment_band", fake_segment_band)
    band = {"name": "outlier", "x": [0, w], "y": [0, h], "count": 2}
    with pytest.raises(ValueError, match="outlier"):
        slice_mod._group_frames_sam(rgb, alpha, band, 1.0)


def test_group_frames_sam_raises_when_mask_mostly_outside_own_cell(monkeypatch):
    """An object mask that mostly falls outside its own cell (as if the crop's margin
    let it swallow a neighboring panel's figure) must raise, naming the band."""
    h, w = 100, 200
    alpha = np.zeros((h, w), dtype=np.uint8)
    # obj0's own cell is x[0,100); this mask sits almost entirely in x[100,200) instead
    obj0 = np.zeros((h, w), dtype=bool); obj0[10:90, 110:140] = True
    obj1 = np.zeros((h, w), dtype=bool); obj1[10:90, 150:180] = True
    alpha[obj0 | obj1] = 255
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    fake_points = [(125.0, 50.0), (165.0, 50.0)]
    fake_cells = [(0.0, 0.0, 100.0, 100.0), (100.0, 0.0, 200.0, 100.0)]

    def fake_segment_band(rgb_, alpha_, band, scale, model, processor, other_bands=None):
        return {"boxes": [(0, 0, 0, 0), (0, 0, 0, 0)], "points": fake_points,
                "cells": fake_cells, "crop_box": (0, 0, w, h),
                "masks": [obj0, obj1],
                "logits": [np.where(obj0, 1.0, -1.0), np.where(obj1, 1.0, -1.0)]}

    monkeypatch.setattr(slice_mod.segment_sam, "segment_band", fake_segment_band)
    band = {"name": "swallowed", "x": [0, w], "y": [0, h], "count": 2}
    with pytest.raises(ValueError, match="swallowed"):
        slice_mod._group_frames_sam(rgb, alpha, band, 1.0)


def test_group_frames_sam_raises_when_object_touches_crop_boundary(monkeypatch):
    """An object whose final mask reaches the SAM crop's own boundary means the margin
    was too small to contain the whole figure - must raise, naming the band, rather than
    silently shipping a clipped frame."""
    h, w = 100, 200
    alpha = np.zeros((h, w), dtype=np.uint8)
    obj0 = np.zeros((h, w), dtype=bool); obj0[10:90, 0:40] = True  # touches crop's left edge (x=0)
    obj1 = np.zeros((h, w), dtype=bool); obj1[10:90, 100:140] = True
    alpha[obj0 | obj1] = 255
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    fake_points = [(20.0, 50.0), (120.0, 50.0)]
    fake_cells = [(0.0, 0.0, 100.0, 100.0), (100.0, 0.0, 200.0, 100.0)]

    def fake_segment_band(rgb_, alpha_, band, scale, model, processor, other_bands=None):
        return {"boxes": [(0, 0, 0, 0), (0, 0, 0, 0)], "points": fake_points,
                "cells": fake_cells, "crop_box": (0, 0, w, h),
                "masks": [obj0, obj1],
                "logits": [np.where(obj0, 1.0, -1.0), np.where(obj1, 1.0, -1.0)]}

    monkeypatch.setattr(slice_mod.segment_sam, "segment_band", fake_segment_band)
    band = {"name": "clipped", "x": [0, w], "y": [0, h], "count": 2}
    with pytest.raises(ValueError, match="clipped"):
        slice_mod._group_frames_sam(rgb, alpha, band, 1.0)


def test_group_frames_sam_scale_2x_reuses_1x_masks_via_nearest(monkeypatch):
    """At scale=2 the sam split must recover the exact 1x arrays (by subsampling the
    caller's already-nearest-upscaled rgb/alpha) and run segment_band exactly once, at
    1x - never on the 2x image - then scale the result back up by nearest-neighbor pixel
    repetition."""
    h, w = 60, 100
    alpha_1x = np.zeros((h, w), dtype=np.uint8)
    obj0 = np.zeros((h, w), dtype=bool); obj0[10:50, 10:30] = True
    obj1 = np.zeros((h, w), dtype=bool); obj1[10:50, 60:80] = True
    alpha_1x[obj0 | obj1] = 255
    rgb_1x = np.zeros((h, w, 3), dtype=np.uint8)
    alpha_2x = np.kron(alpha_1x, np.ones((2, 2), dtype=np.uint8))
    rgb_2x = np.kron(rgb_1x, np.ones((2, 2, 1), dtype=np.uint8))

    fake_points = [(20.0, 30.0), (70.0, 30.0)]
    fake_cells = [(0.0, 0.0, 50.0, 60.0), (50.0, 0.0, 100.0, 60.0)]
    calls = []

    def fake_segment_band(rgb_, alpha_, band, scale, model, processor, other_bands=None):
        calls.append((rgb_.shape, scale))
        assert scale == 1.0
        assert rgb_.shape[:2] == (h, w)
        return {"boxes": [(0, 0, 0, 0), (0, 0, 0, 0)], "points": fake_points,
                "cells": fake_cells, "crop_box": (0, 0, w, h),
                "masks": [obj0, obj1],
                "logits": [np.where(obj0, 1.0, -1.0), np.where(obj1, 1.0, -1.0)]}

    monkeypatch.setattr(slice_mod.segment_sam, "segment_band", fake_segment_band)
    band = {"name": "pair2x", "x": [0, w], "y": [0, h], "count": 2}
    frames = slice_mod._group_frames_sam(rgb_2x, alpha_2x, band, 2.0)
    assert len(calls) == 1  # segment_band ran exactly once, at 1x
    assert len(frames) == 2
    box0, cx0 = frames[0]
    assert (box0.x0, box0.y0, box0.x1, box0.y1) == (20, 20, 60, 100)  # obj0's 1x box * 2
    assert box0.owner_mask.shape == (80, 40)
    assert cx0 == 40.0  # 1x point x (20.0) * 2


RAW = os.path.join(os.path.dirname(__file__), "..", "raw", "sheet.png")


def _sam_ready() -> bool:
    try:
        import torch
    except ImportError:
        return False
    try:
        return bool(torch.cuda.is_available())
    except Exception:
        return False


SAM_READY = _sam_ready()


@pytest.mark.skipif(not SAM_READY or not os.path.exists(RAW),
                     reason="SAM venv/CUDA or raw sheet not present")
def test_real_sheet_sam_mode_matches_counts_and_areas():
    """Runs the real sheet through sam mode for every counted band (each-mode bands stay
    on component mode, unaffected) and asserts every band's frame count matches
    rows.json's `count`, and every object's own area lands in the accepted range -
    _group_frames_sam raises ValueError itself if not, so a clean pass here is the
    assertion. Only runs with a working SAM venv (CUDA available) - this repo's regular
    tools/.venv has no torch/transformers installed at all."""
    from key import key_background_bands, band_rects
    from PIL import Image
    rows_path = os.path.join(os.path.dirname(__file__), "rows.json")
    rows = json.load(open(rows_path))
    tolerance = rows.get("keyTolerance", 16)
    rgb = np.array(Image.open(RAW).convert("RGB"))
    alpha = key_background_bands(rgb, band_rects(rows["bands"], 1.0), tolerance)

    counts = {}
    diagnostics = {}
    for band in rows["bands"]:
        if band.get("each"):
            frames = group_frames(alpha, band, 1.0, {})
        else:
            frames = group_frames(alpha, band, 1.0, {}, rgb=rgb, diagnostics=diagnostics,
                                   default_split="sam", all_bands=rows["bands"])
        counts[band["name"]] = len(frames)

    expected = {b["name"]: b["count"] for b in rows["bands"] if not b.get("each")}
    assert {k: counts[k] for k in expected} == expected

    for name, diag in diagnostics.items():
        areas = diag["areas"]
        median = float(np.median(areas))
        for a in areas:
            assert 0.3 * median <= a <= 1.6 * median, (name, a, median)


def test_trim_floor_rows_clips_ground_line_but_keeps_hem():
    from segment_sam import trim_floor_rows
    m = np.zeros((100, 400), dtype=bool)
    m[10:90, 150:250] = True            # body, 100 px wide
    m[86:90, 130:270] = True            # flared hem, 20 percent wider each side
    m[88:90, 20:380] = True             # ground line spanning the panel
    out = trim_floor_rows(m, rows_frac=0.12, widen_frac=0.4)
    assert out[87, 135] and out[87, 265]          # hem survives (within 40 percent widen)
    assert not out[88, 25] and not out[89, 375]   # floor line clipped
    assert out[88, 200]                           # shadow under the feet survives
    assert out[50, 150] and out[50, 249]          # body untouched
    assert trim_floor_rows(np.zeros((5, 5), dtype=bool)).sum() == 0
