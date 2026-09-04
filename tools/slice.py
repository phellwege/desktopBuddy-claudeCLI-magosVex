"""Slice a labeled sprite sheet into an atlas using rows.json bands."""
import argparse, json, os, sys
from dataclasses import dataclass, field
import numpy as np
from PIL import Image
from scipy import ndimage
from skimage.morphology import disk
from skimage.segmentation import watershed
sys.path.insert(0, os.path.dirname(__file__))
from key import key_background_bands, band_rects
import segment_sam

MIN_BODY_H_1X = 60
MAX_DX_1X = 90
MAX_FRAGMENT_ASPECT = 3.0

# Object-mode (watershed) constants: starting/maximum erosion radius used to find each
# object's "core" seed. Both scale with the sheet's --scale factor like MIN_BODY_H_1X etc.
CORE_ERODE_R0_1X = 3
MAX_ERODE_RADIUS_1X = 20

# SAM-mode (segment_sam) constants: a fragment claimed by no SAM object is a hairline
# sliver - a stray keying seam rather than real content - if it is at most this many
# pixels thick and at least this long, in either orientation.
HAIRLINE_MAX_THICKNESS_1X = 3
HAIRLINE_MIN_LENGTH_1X = 30
# A SAM object's own (pre-fragment) pixel area must fall within this multiple of the
# band's median object area, or something went badly wrong with a prompt (e.g. two
# figures' masks collapsed into one, or a mask leaked into the background).
AREA_MIN_RATIO = 0.3
AREA_MAX_RATIO = 1.6
# A fragment not caught by touching_owner/numeral-strip/aspect/hairline attaches to the
# nearest object by pixel distance, only within this reach; smaller than the legacy
# MAX_DX_1X (used by center-x-based attachment in object/components mode) on purpose -
# this is a last-resort catch for small nearby debris, not a general reach.
FRAGMENT_MAX_DISTANCE_1X = 12
# A non-touching fragment smaller than this (px) is dropped outright rather than
# attached by distance - too small to be worth claiming, likely keying/AA noise.
FRAGMENT_MIN_AREA_1X = 6
# The rectangle a fragment may be attached into is its target object's own cell widened
# by this fraction on every side (same fraction the SAM prompt box itself overshoots a
# cell by) - a fragment outside even that reach is presumed to belong to a neighboring
# figure or panel, not this one.
CELL_EXPAND_FRAC = 0.15
# A component whose whole box sits above the band's topmost object-mask row by more
# than this gap, and is shorter than this height, is a panel title/label word the wide
# SAM crop margin pulled into scope - not figure content.
TEXT_LABEL_MIN_GAP_1X = 4
TEXT_LABEL_MAX_HEIGHT_1X = 18
# An object's own SAM mask must overlap its own cell by at least this fraction of the
# mask's area, or it likely swallowed a neighboring panel's figure through the crop's
# margin.
CELL_OWN_OVERLAP_MIN_FRACTION = 0.6

STRUCT8 = np.ones((3, 3), dtype=bool)  # 8-connectivity for component labeling


@dataclass
class Box:
    x0: int; y0: int; x1: int; y1: int
    # Object-mode extras: per-pixel ownership mask and the core-only feet row, both in
    # crop-local coordinates. None for components/each mode, where normalize() falls back
    # to its original whole-crop behavior. Excluded from repr/eq so Box still prints and
    # compares the way every existing test expects.
    owner_mask: np.ndarray | None = field(default=None, repr=False, compare=False)
    core_last_row: int | None = field(default=None, repr=False, compare=False)
    # SAM-mode extra: a precomputed (ax, ay) anchor, crop-local, that overrides both the
    # core_last_row-based ay and the body_cx-based ax below - SAM's anchor is the feet
    # centroid of the object's own mask (segment_sam.compute_anchor), not a bbox center.
    anchor: tuple[int, int] | None = field(default=None, repr=False, compare=False)
    @property
    def w(self): return self.x1 - self.x0
    @property
    def h(self): return self.y1 - self.y0
    @property
    def cx(self): return (self.x0 + self.x1) / 2
    @property
    def cy(self): return (self.y0 + self.y1) / 2
    def union(self, o: "Box") -> "Box":
        return Box(min(self.x0, o.x0), min(self.y0, o.y0), max(self.x1, o.x1), max(self.y1, o.y1))
    def shifted(self, dx: int, dy: int) -> "Box":
        return Box(self.x0 + dx, self.y0 + dy, self.x1 + dx, self.y1 + dy)


def components(alpha: np.ndarray, thr: int = 128, min_px: int = 4) -> list[Box]:
    labels, n = ndimage.label(alpha > thr)
    out = []
    for sl in ndimage.find_objects(labels):
        if sl is None:
            continue
        ys, xs = sl
        if (ys.stop - ys.start) * (xs.stop - xs.start) < min_px:
            continue
        out.append(Box(xs.start, ys.start, xs.stop, ys.stop))
    return out


def group_frames(alpha: np.ndarray, band: dict, scale: float, overrides: dict, *,
                  rgb: np.ndarray | None = None, model=None, processor=None,
                  diagnostics: dict | None = None,
                  default_split: str = "objects",
                  all_bands: list[dict] | None = None) -> list[tuple[Box, float]]:
    x0, x1 = (int(round(v * scale)) for v in band["x"])
    y0, y1 = (int(round(v * scale)) for v in band["y"])
    ov = overrides.get(band["name"], {})
    sub = alpha[y0:y1, x0:x1]
    erased = sub
    if ov.get("erase"):
        erased = sub.copy()
        for ex0, ey0, ex1, ey1 in ov["erase"]:
            ex0, ey0, ex1, ey1 = (int(round(v * scale)) for v in (ex0, ey0, ex1, ey1))
            erased[max(0, ey0 - y0):ey1 - y0, max(0, ex0 - x0):ex1 - x0] = 0

    if band.get("each"):
        min_px = max(4, int(round(4 * scale * scale)))
        boxes = [b.shifted(x0, y0) for b in components(erased, min_px=min_px)]
        boxes.sort(key=lambda b: (b.x0, b.y0))
        return [(b, b.cx) for b in boxes]

    split = band.get("split", default_split)
    if split == "components":
        return _group_frames_components(erased, band, scale, ov, x0, y0)
    if split == "objects":
        return _group_frames_objects(erased, band, scale, x0, y0)
    if split == "sam":
        if rgb is None:
            raise ValueError(f"band {band['name']}: sam split needs the original rgb sheet")
        return _group_frames_sam(rgb, alpha, band, scale, model=model, processor=processor,
                                  diagnostics=diagnostics, all_bands=all_bands)
    raise ValueError(f"band {band['name']}: unknown split mode {split!r}")


def _group_frames_components(erased: np.ndarray, band: dict, scale: float, ov: dict,
                              x0: int, y0: int) -> list[tuple[Box, float]]:
    """Legacy grouping: raw connected components classified as "body" (>= MIN_BODY_H_1X
    tall) or "fragment", fragments unioned by nearest body center, bodies merged/dropped
    per `overrides.json`. Kept for backwards compatibility via `"split": "components"`."""
    min_px = max(4, int(round(4 * scale * scale)))
    boxes = [b.shifted(x0, y0) for b in components(erased, min_px=min_px)]
    min_body_h = MIN_BODY_H_1X * scale
    max_dx = MAX_DX_1X * scale
    bodies = sorted([b for b in boxes if b.h >= min_body_h], key=lambda b: b.cx)
    fragments = [b for b in boxes if b.h < min_body_h and b.w / max(b.h, 1) <= MAX_FRAGMENT_ASPECT]
    keep = [i for i in range(len(bodies)) if i not in set(ov.get("drop", []))]
    groups: list[list[int]] = [[i] for i in keep]
    for merge in ov.get("merge", []):
        merged = [g for g in groups if any(i in merge for i in g)]
        rest = [g for g in groups if g not in merged]
        groups = rest + [sorted(sum(merged, []))]
    groups.sort(key=lambda g: min(bodies[i].cx for i in g))
    frames = []
    for g in groups:
        box = bodies[g[0]]
        for i in g[1:]:
            box = box.union(bodies[i])
        body_cx = sum(bodies[i].cx for i in g) / len(g)
        frames.append([box, body_cx])
    for f in fragments:
        if not frames:
            break
        j = min(range(len(frames)), key=lambda k: abs(frames[k][1] - f.cx))
        if abs(frames[j][1] - f.cx) <= max_dx:
            frames[j][0] = frames[j][0].union(f)
    expected = band["count"]
    if len(frames) != expected:
        raise ValueError(f"band {band['name']}: found {len(frames)} frames, expected {expected}")
    return [(b, cx) for b, cx in frames]


def _find_cores(mask: np.ndarray, n: int, scale: float, band_name: str) -> np.ndarray:
    """Erode `mask` with a growing disk until >= n components survive, then keep the n
    largest by area. Returns a marker array (0 = no marker, else the original label id of
    a kept core) suitable for `watershed`'s `markers` argument."""
    r0 = max(1, int(round(CORE_ERODE_R0_1X * scale)))
    max_r = max(r0, int(round(MAX_ERODE_RADIUS_1X * scale)))
    r = r0
    while r <= max_r:
        eroded = ndimage.binary_erosion(mask, structure=disk(r).astype(bool), border_value=0)
        labels, num = ndimage.label(eroded, structure=STRUCT8)
        if num >= n:
            sizes = ndimage.sum(eroded, labels, index=np.arange(1, num + 1))
            keep_ids = (np.argsort(sizes)[::-1][:n] + 1).tolist()
            return np.where(np.isin(labels, keep_ids), labels, 0)
        r += 1
    raise ValueError(f"band {band_name}: could not find {n} object cores (erosion radius up to {max_r}px)")


def _group_frames_objects(erased: np.ndarray, band: dict, scale: float,
                           x0: int, y0: int) -> list[tuple[Box, float]]:
    """Object-mode grouping: every opaque pixel is assigned to exactly one of `count`
    objects via marker-controlled watershed, so touching/overlapping neighbors on the
    sheet no longer bleed into each other's crop.

    1. mask = keyed alpha > 0, inside the band (after any `erase` override).
    2. Erode `mask` with a growing disk to find `count` "core" seeds (the n largest
       eroded components) - thin touching bridges between neighbors erode away first,
       leaving one seed per real object.
    3. Grow the seeds back over the un-eroded `mask` with watershed on the negative
       distance transform, so every mask pixel reachable from a seed is assigned to
       the geodesically nearest one. Pixels in a mask component with no seed at all
       (fully disconnected, e.g. a floating skull) come back unassigned (label 0).
    4. Each disconnected "floating fragment" is unioned into whichever object's core
       center is horizontally nearest (within MAX_DX_1X * scale); a fragment wider than
       MAX_FRAGMENT_ASPECT times its height, or outside every object's reach, is dropped
       (owned by nobody, so it never appears in any frame).
    5. Each object's crop is the bounding box of its owned pixels; within that box, every
       pixel not owned by this object (another object's, or a dropped fragment's) is
       zeroed, so the exclusion between neighbors is exact rather than a straight cut.
    """
    name = band["name"]
    n = band["count"]
    mask = erased > 0

    markers = _find_cores(mask, n, scale, name)
    obj_ids = [int(i) for i in np.unique(markers) if i != 0]

    distance = ndimage.distance_transform_edt(mask)
    ws_labels = watershed(-distance, markers=markers, mask=mask, connectivity=2)

    owner: dict[int, np.ndarray] = {}
    core_box: dict[int, Box] = {}
    core_last_row: dict[int, int] = {}
    for i in obj_ids:
        core_pixels = ws_labels == i
        ys, xs = np.where(core_pixels)
        if ys.size == 0:
            raise ValueError(f"band {name}: object core {i} has no pixels after watershed")
        core_box[i] = Box(int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        core_last_row[i] = int(ys.max())
        owner[i] = core_pixels.copy()

    max_dx = MAX_DX_1X * scale
    floating = mask & (ws_labels == 0)
    frag_labels, num_frag = ndimage.label(floating, structure=STRUCT8)
    for f in range(1, num_frag + 1):
        frag_pixels = frag_labels == f
        ys, xs = np.where(frag_pixels)
        fbox = Box(int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        if fbox.w / max(fbox.h, 1) > MAX_FRAGMENT_ASPECT:
            continue  # dropped: label-like sliver, owned by nobody
        nearest = min(obj_ids, key=lambda i: abs(core_box[i].cx - fbox.cx))
        if abs(core_box[nearest].cx - fbox.cx) <= max_dx:
            owner[nearest] |= frag_pixels
        # else: dropped, outside every object's reach

    order = sorted(obj_ids, key=lambda i: core_box[i].cx)
    frames = []
    for i in order:
        om = owner[i]
        ys, xs = np.where(om)
        box_local = Box(int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        box = box_local.shifted(x0, y0)
        box.owner_mask = om[box_local.y0:box_local.y1, box_local.x0:box_local.x1].copy()
        box.core_last_row = core_last_row[i] - box_local.y0
        frames.append((box, core_box[i].cx + x0))
    return frames


def upscale_frames_nearest(frames: list[tuple[Box, float]], factor: int) -> list[tuple[Box, float]]:
    """Scale a list of (Box, cx) frames up by an integer `factor` via nearest-neighbor
    pixel repetition: every coordinate and the `owner_mask`/`anchor` extras all multiply
    or repeat cleanly, exactly matching what a nearest-upscaled image's own alpha would
    produce at that resolution. Used by `_group_frames_sam` to scale its 1x result up
    without ever running SAM on an enlarged image, and reusable by any caller that
    already has 1x sam-mode frames and wants the matching Nx frames without redoing the
    model work."""
    out = []
    for box, cx in frames:
        sb = Box(box.x0 * factor, box.y0 * factor, box.x1 * factor, box.y1 * factor)
        if box.owner_mask is not None:
            sb.owner_mask = np.kron(box.owner_mask, np.ones((factor, factor), dtype=bool))
        if box.anchor is not None:
            sb.anchor = (box.anchor[0] * factor, box.anchor[1] * factor)
        if box.core_last_row is not None:
            sb.core_last_row = box.core_last_row * factor + (factor - 1)
        out.append((sb, cx * factor))
    return out


def _group_frames_sam(rgb: np.ndarray, alpha: np.ndarray, band: dict, scale: float,
                       model=None, processor=None,
                       diagnostics: dict | None = None,
                       all_bands: list[dict] | None = None) -> list[tuple[Box, float]]:
    """SAM-mode grouping. A band rectangle is only a prompt region and a label - it
    names the group, gives the count, and provides the cell centers for prompts. It
    never clips a frame: a frame's extent is exactly the bounding box of its SAM mask
    plus its attached fragments, wherever those pixels land on the sheet.
    `segment_sam.segment_band()` runs SAM on a crop of the band rectangle widened by a
    generous margin (clamped to the sheet), giving one box+point-prompted mask per frame
    (already intersected with the keyed alpha, never with the band rectangle) plus its
    raw logits, its positive point, and its own (unwidened) cell rectangle;
    `segment_sam.resolve_ownership()` settles pixels two masks both claim by higher
    logit. Each object's own mask must overlap its own cell by at least
    CELL_OWN_OVERLAP_MIN_FRACTION of its area, or it likely swallowed a neighboring
    panel's figure through the crop's margin (`ValueError`, names the object).

    Every keyed pixel in the crop that no object claims is a "fragment". In order:
    1. Entirely inside the band's `numeralStrip`, or a text label (entirely above the
       band's topmost object-mask row by more than TEXT_LABEL_MIN_GAP_1X px and shorter
       than TEXT_LABEL_MAX_HEIGHT_1X px - a panel title/label word the wide crop margin
       pulled into scope) -> dropped unconditionally.
    2. Physically touching an object's mask, or a fragment already attached to one
       (`segment_sam.touching_owner`, applied to a fixed point so a chain of touching
       pieces all resolve together) -> reattached directly. This is the common case: a
       notch SAM's mask missed at a jagged silhouette edge, a companion split across an
       antialiasing seam, a staff glued to the hand that holds it.
    3. Wider than MAX_FRAGMENT_ASPECT times its height, or a hairline sliver
       (`segment_sam.is_hairline`) -> dropped (an obviously non-figure shape that
       touched nothing).
    4. Smaller than FRAGMENT_MIN_AREA_1X px -> dropped (too small to be worth claiming).
       Otherwise, attached to the object nearest by pixel distance
       (`segment_sam.nearest_by_distance`, never by a shared point's x-coordinate) if
       and only if that distance is at most FRAGMENT_MAX_DISTANCE_1X px, the fragment's
       box lies entirely within that object's own cell expanded by CELL_EXPAND_FRAC, and
       it does not also reach into any other object's own extent - otherwise dropped.
       Anything dropped here is never shipped in any frame.

    Each frame's anchor comes from `segment_sam.compute_anchor` on its own SAM object
    alone (before fragments are unioned in), matching the object-mode convention that
    attached fragments (a floating skull, an effect) never move the feet anchor.

    Guard: if an object's final mask touches the SAM crop boundary on any side, the
    margin was too small to contain the whole figure - raises `ValueError` naming the
    band and object rather than silently shipping a clipped frame.

    Always runs SAM at 1x. At scale != 1 the caller's `rgb`/`alpha` are guaranteed (by
    the pipeline's own upscale step) to be a lossless nearest-neighbor enlargement of the
    1x sheet, so this recovers the exact 1x arrays by subsampling every `factor`-th pixel,
    runs the whole algorithm once there, then scales every box/mask/anchor back up by
    nearest-neighbor pixel repetition - the model itself never sees the enlarged image.
    """
    factor = int(round(scale))
    if abs(factor - scale) > 1e-6 or factor < 1:
        raise ValueError(f"band {band['name']}: sam split needs an integer scale, got {scale}")
    if factor != 1:
        rgb_1x, alpha_1x = rgb[::factor, ::factor], alpha[::factor, ::factor]
        frames_1x = _group_frames_sam(rgb_1x, alpha_1x, band, 1.0, model, processor, diagnostics, all_bands)
        return upscale_frames_nearest(frames_1x, factor)

    name = band["name"]
    n = band["count"]

    result = segment_sam.segment_band(rgb, alpha, band, 1.0, model, processor, other_bands=all_bands)
    masks, logits, points, cells = result["masks"], result["logits"], result["points"], result["cells"]
    cx0, cy0, cx1, cy1 = result["crop_box"]

    owner = segment_sam.resolve_ownership(masks, logits)
    obj_masks = [(owner == (i + 1)) for i in range(n)]
    obj_areas = [int(m.sum()) for m in obj_masks]
    median_area = float(np.median(obj_areas)) if obj_areas else 0.0
    lo, hi = AREA_MIN_RATIO * median_area, AREA_MAX_RATIO * median_area
    for i, a in enumerate(obj_areas):
        if not (lo <= a <= hi):
            raise ValueError(
                f"band {name}: object {i} area {a}px outside [{lo:.0f}, {hi:.0f}]px "
                f"({AREA_MIN_RATIO}x-{AREA_MAX_RATIO}x of median {median_area:.0f}px)")

    for i in range(n):
        frac = segment_sam.mask_overlap_fraction(obj_masks[i], cells[i])
        if frac < CELL_OWN_OVERLAP_MIN_FRACTION:
            raise ValueError(
                f"band {name}: object {i} mask overlaps its own cell by only {frac:.2f} "
                f"(< {CELL_OWN_OVERLAP_MIN_FRACTION}) - it may have swallowed a "
                f"neighboring panel's figure through the crop margin")

    # Fragments: any keyed pixel inside the SAM crop that no object claims. Scoped to
    # the crop, never to the band rectangle, so a frame's extent is never limited by the
    # band rectangle - only by how much of the crop margin the figure actually needed.
    crop_region = np.zeros(alpha.shape, dtype=bool)
    crop_region[cy0:cy1, cx0:cx1] = True
    unclaimed = (alpha > 0) & crop_region & (owner == 0)
    frag_labels, num_frag = ndimage.label(unclaimed, structure=STRUCT8)

    numeral_strip = band.get("numeralStrip")
    owner_masks = [m.copy() for m in obj_masks]
    dropped_boxes: list[tuple[int, int, int, int]] = []
    attached_boxes: list[tuple[int, tuple[int, int, int, int]]] = []

    frag_pixels_by_id: dict[int, np.ndarray] = {}
    frag_box_by_id: dict[int, Box] = {}
    pending: set[int] = set()
    topmost_object_row = min(int(np.where(m)[0].min()) for m in obj_masks if m.any())
    for f in range(1, num_frag + 1):
        fp = frag_labels == f
        ys, xs = np.where(fp)
        fb = Box(int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        frag_pixels_by_id[f] = fp
        frag_box_by_id[f] = fb
        if segment_sam.in_numeral_strip(fb.y0, fb.y1, numeral_strip):
            dropped_boxes.append((fb.x0, fb.y0, fb.x1, fb.y1))
            continue
        if segment_sam.is_text_label(fb.y0, fb.y1, fb.h, topmost_object_row,
                                      TEXT_LABEL_MIN_GAP_1X, TEXT_LABEL_MAX_HEIGHT_1X):
            dropped_boxes.append((fb.x0, fb.y0, fb.x1, fb.y1))
            continue
        pending.add(f)

    # Chain-attach anything physically touching an object, or a fragment already
    # attached to one, to a fixed point - so a chain of touching pieces (a skull's
    # cheek touching its jaw touching its neck cable touching the body) all resolve
    # together in one pass regardless of the order ndimage.label happened to number them.
    changed = True
    while changed:
        changed = False
        for f in sorted(pending):
            touching = segment_sam.touching_owner(frag_pixels_by_id[f], owner_masks)
            if touching is not None:
                owner_masks[touching] |= frag_pixels_by_id[f]
                fb = frag_box_by_id[f]
                attached_boxes.append((touching, (fb.x0, fb.y0, fb.x1, fb.y1)))
                pending.discard(f)
                changed = True

    still_pending: set[int] = set()
    for f in pending:
        fb = frag_box_by_id[f]
        if (fb.w / max(fb.h, 1) > MAX_FRAGMENT_ASPECT
                or segment_sam.is_hairline(fb.w, fb.h, HAIRLINE_MAX_THICKNESS_1X, HAIRLINE_MIN_LENGTH_1X)):
            dropped_boxes.append((fb.x0, fb.y0, fb.x1, fb.y1))
            continue
        still_pending.add(f)

    # Last resort: nearest by pixel distance, gated by a small reach, a size floor, and
    # confinement to the target's own (widened) cell with no reach into another
    # object's own extent - a snapshot of each object's current bbox, taken once before
    # this loop, is enough for that "another object" check (this loop only ever
    # attaches small, isolated debris; the objects' own extents are already settled).
    owner_bboxes = [segment_sam.mask_bbox(m) for m in owner_masks]
    for f in sorted(still_pending):
        fp = frag_pixels_by_id[f]
        fb = frag_box_by_id[f]
        if int(fp.sum()) < FRAGMENT_MIN_AREA_1X:
            dropped_boxes.append((fb.x0, fb.y0, fb.x1, fb.y1))
            continue
        target = segment_sam.nearest_by_distance(fp, obj_masks, FRAGMENT_MAX_DISTANCE_1X)
        if target is None:
            dropped_boxes.append((fb.x0, fb.y0, fb.x1, fb.y1))
            continue
        frag_rect = (fb.x0, fb.y0, fb.x1, fb.y1)
        expanded_cell = segment_sam.expand_rect(cells[target], CELL_EXPAND_FRAC)
        if not segment_sam.rect_contains(expanded_cell, frag_rect):
            dropped_boxes.append((fb.x0, fb.y0, fb.x1, fb.y1))
            continue
        overlaps_other = any(j != target and owner_bboxes[j] is not None
                              and segment_sam.rects_intersect(frag_rect, owner_bboxes[j])
                              for j in range(n))
        if overlaps_other:
            dropped_boxes.append((fb.x0, fb.y0, fb.x1, fb.y1))
            continue
        owner_masks[target] |= fp
        attached_boxes.append((target, (fb.x0, fb.y0, fb.x1, fb.y1)))

    point_xs = [p[0] for p in points]
    order = sorted(range(n), key=lambda i: point_xs[i])
    frames = []
    for i in order:
        om = owner_masks[i]
        ys, xs = np.where(om)
        if ys.size == 0:
            raise ValueError(f"band {name}: object {i} has no owned pixels")
        box = Box(int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        if box.x0 <= cx0 or box.x1 >= cx1 or box.y0 <= cy0 or box.y1 >= cy1:
            raise ValueError(
                f"band {name}: object {i} touches the SAM crop boundary "
                f"(object=({box.x0},{box.y0},{box.x1},{box.y1}), crop=({cx0},{cy0},{cx1},{cy1})) "
                f"- the margin was too small for this band")
        box.owner_mask = om[box.y0:box.y1, box.x0:box.x1].copy()
        ax_obj, ay_obj = segment_sam.compute_anchor(obj_masks[i])
        box.anchor = (ax_obj - box.x0, ay_obj - box.y0)
        frames.append((box, point_xs[i]))

    if diagnostics is not None:
        contacts = [{"pair": [a, b], "contact": segment_sam.contact_length(owner_masks[a], owner_masks[b])}
                    for a, b in zip(order, order[1:])]
        diagnostics[name] = {
            "boxes": [list(map(float, b)) for b in result["boxes"]],
            "points": [list(map(float, p)) for p in points],
            "cells": [list(map(float, c)) for c in cells],
            "crop_box": [cx0, cy0, cx1, cy1],
            "areas": obj_areas,
            "dropped_fragments": [list(b) for b in dropped_boxes],
            "attached_fragments": [[t, list(b)] for t, b in attached_boxes],
            "contact": contacts,
        }
    return frames


def normalize(rgba: np.ndarray, box: Box, body_cx: float) -> tuple[np.ndarray, int, int]:
    """Crop `box` out of `rgba` and compute its (ax, ay) anchor. All three slicing modes
    go through this single path: object mode stamps `box.owner_mask` (crop-local, True
    for pixels this object owns) and `box.core_last_row` (crop-local feet row of the
    core, excluding attached fragments) onto the Box; sam mode stamps `owner_mask` the
    same way plus a precomputed `box.anchor` (crop-local (ax, ay), from
    segment_sam.compute_anchor on the object alone) that overrides the body_cx/
    core_last_row calculation entirely; components/each mode leaves all three None and
    gets the original whole-crop behavior (every opaque pixel kept, ay = lowest opaque
    row of the whole crop)."""
    crop = rgba[box.y0:box.y1, box.x0:box.x1].copy()
    if box.owner_mask is not None:
        crop[..., 3] = np.where(box.owner_mask, crop[..., 3], 0)
    if box.anchor is not None:
        ax, ay = box.anchor
        return crop, ax, ay
    if box.core_last_row is not None:
        ay = box.core_last_row + 1
    else:
        rows = np.where(crop[..., 3] > 0)[0]
        ay = int(rows.max()) + 1 if rows.size else crop.shape[0]
    ax = int(round(body_cx - box.x0))
    return crop, ax, ay


def pack_atlas(frames: list[tuple[str, np.ndarray, int, int]], max_width: int = 4096, pad: int = 2) -> tuple[np.ndarray, dict]:
    order = sorted(frames, key=lambda f: -f[1].shape[0])
    placements, x, y, shelf_h, width = {}, pad, pad, 0, 0
    for name, img, ax, ay in order:
        h, w = img.shape[:2]
        if x + w + pad > max_width:
            x, y, shelf_h = pad, y + shelf_h + pad, 0
        placements[name] = (x, y)
        x += w + pad
        shelf_h = max(shelf_h, h)
        width = max(width, x)
    height = y + shelf_h + pad
    atlas = np.zeros((height, width, 4), dtype=np.uint8)
    meta = {"image": "atlas.png", "maxFrameSize": [0, 0], "frames": {}}
    for name, img, ax, ay in frames:
        px, py = placements[name]
        h, w = img.shape[:2]
        atlas[py:py + h, px:px + w] = img
        meta["frames"][name] = {"x": px, "y": py, "w": w, "h": h, "ax": ax, "ay": ay}
        meta["maxFrameSize"] = [max(meta["maxFrameSize"][0], w), max(meta["maxFrameSize"][1], h)]
    return atlas, meta


DIRECTIONAL = {"walk": ("walk_right", "walk_left"), "run": ("run_right", "run_left")}


def draft_animations(names_by_band: dict[str, list[str]]) -> dict:
    draft = {}
    used = set()
    for key, (r, l) in DIRECTIONAL.items():
        if r in names_by_band and l in names_by_band:
            draft[key] = {"right": names_by_band[r], "left": names_by_band[l]}
            used.update({r, l})
    for band, names in names_by_band.items():
        if band not in used and band != "props":
            draft[band] = {"frames": names}
    return draft


def build(sheet: str, rows: str, overrides: str, out_dir: str, scale: float, key: bool = False,
          split: str = "objects", model=None, processor=None,
          diagnostics_path: str | None = None) -> dict:
    rows_data = json.load(open(rows))
    bands = rows_data["bands"]
    if key:
        rgb = np.array(Image.open(sheet).convert("RGB"))
        tolerance = rows_data.get("keyTolerance", 16)
        alpha_ch = key_background_bands(rgb, band_rects(bands, scale), tolerance)
        rgba = np.dstack([rgb, alpha_ch])
    else:
        rgba = np.array(Image.open(sheet).convert("RGBA"))
        rgb = rgba[..., :3]
    alpha = rgba[..., 3]
    ov = json.load(open(overrides)) if os.path.exists(overrides) else {}
    os.makedirs(out_dir, exist_ok=True)
    uses_sam = split == "sam" or any(b.get("split") == "sam" for b in bands)
    diagnostics: dict | None = {} if uses_sam else None
    all_frames, names_by_band, counts = [], {}, {}
    for band in bands:
        frames = group_frames(alpha, band, scale, ov, rgb=rgb, model=model, processor=processor,
                               diagnostics=diagnostics, default_split=split, all_bands=bands)
        facing = band.get("facing")
        other = {"left": "right", "right": "left"}.get(facing)
        names = []
        for i, (box, cx) in enumerate(frames):
            crop, ax, ay = normalize(rgba, box, cx)
            if facing:
                own = f"{band['name']}_{facing}_{i}"
                flipped = f"{band['name']}_{other}_{i}"
                all_frames.append((own, crop, ax, ay))
                all_frames.append((flipped, crop[:, ::-1].copy(), crop.shape[1] - ax, ay))
                names_by_band.setdefault(f"{band['name']}_{facing}", []).append(own)
                names_by_band.setdefault(f"{band['name']}_{other}", []).append(flipped)
            else:
                name = f"{band['name']}_{i}"
                all_frames.append((name, crop, ax, ay))
                names.append(name)
        if not facing:
            names_by_band[band["name"]] = names
        counts[band["name"]] = len(frames)
    atlas, meta = pack_atlas(all_frames)
    Image.fromarray(atlas).save(os.path.join(out_dir, "atlas.png"))
    json.dump(meta, open(os.path.join(out_dir, "atlas.json"), "w"), indent=1)
    json.dump(draft_animations(names_by_band), open(os.path.join(out_dir, "animations.draft.json"), "w"), indent=1)
    if diagnostics is not None:
        json.dump(diagnostics, open(diagnostics_path or os.path.join(out_dir, "diagnostics.json"), "w"), indent=1)
    return counts


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("sheet"); p.add_argument("out_dir")
    p.add_argument("--rows", default=os.path.join(os.path.dirname(__file__), "rows.json"))
    p.add_argument("--overrides", default=os.path.join(os.path.dirname(__file__), "overrides.json"))
    p.add_argument("--scale", type=float, default=1.0)
    p.add_argument("--key", action="store_true", help="sheet is a raw RGB sheet; key it band-by-band before slicing")
    p.add_argument("--split", choices=["objects", "components", "sam"], default="objects",
                    help="default split mode for counted bands without their own \"split\" key in rows.json")
    p.add_argument("--sam-model", default=segment_sam.DEFAULT_MODEL, help="SAM 2 model name (sam split only)")
    p.add_argument("--device", default="cuda", help="torch device for SAM inference (sam split only)")
    a = p.parse_args()
    model = processor = None
    if a.split == "sam":
        model, processor = segment_sam.load_model(a.sam_model, a.device)
    for band, n in build(a.sheet, a.rows, a.overrides, a.out_dir, a.scale, a.key,
                          split=a.split, model=model, processor=processor).items():
        print(f"{band}: {n}")


if __name__ == "__main__":
    main()
