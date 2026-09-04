"""SAM 2 based object segmentation for one counted band of the sprite sheet.

Model: facebook/sam2.1-hiera-small via transformers' Sam2Model + Sam2Processor
(DEFAULT_MODEL). If mask quality on these chibi figures turns out poor, pass
`--sam-model facebook/sam2.1-hiera-base-plus` (slice.py) or `--model ...` (this file's
own --band CLI) to try the larger checkpoint instead - there is no automatic fallback.

`segment_band()` is the only function that needs torch/transformers; every other
function here is pure numpy/scipy and is unit-tested directly, without a model or
CUDA, from tools/test_pipeline.py. torch and transformers are therefore imported
lazily inside `load_model`/`segment_band`, not at module level, so importing this
module (for its pure helpers) works in the regular tools/.venv too.

Design (see tools/slice.py's `_group_frames_sam` for the full pipeline): a band
rectangle in rows.json is only a prompt region and a label - it names the group, gives
the count, and provides the cell centers for prompts. It never clips a frame: a frame's
extent is exactly the bounding box of its SAM mask plus its attached fragments,
wherever those pixels land on the sheet. SAM runs on a generous margin crop around the
band rectangle (MARGIN_1X, clamped to the sheet) so figures whose companions or effects
extend past the nominal band edges are never cut off; the only intersection anywhere is
with the keyed alpha (never with the band rectangle).

Coordinates: everything here is in the SAME pixel space as the `rgb`/`alpha` arrays
passed in (sheet coordinates at whatever scale the caller is working at - slice.py's
"sam" split always calls this at 1x and rescales the result afterward; see its
module docstring for why).
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(__file__))
from key import key_background_bands, band_rects

DEFAULT_MODEL = "facebook/sam2.1-hiera-small"
MARGIN_1X = 40
CELL_OVERSHOOT_FRAC = 0.15
# An edge cell's prompt box extends toward the crop edge but stops this many px short of
# it, so the crop still has genuine slack beyond the box for a mask that overflows it a
# little (normal) - if the box's own edge coincided with the crop's true edge, any mask
# that filled the box would trivially touch the crop boundary, making the "margin was
# too small" guard fire on essentially every edge figure instead of only real ones.
EDGE_GUARD_BUFFER_1X = 10
MIDDLE_THIRD_FRAC = 1.0 / 3.0

STRUCT8 = np.ones((3, 3), dtype=bool)

_MODEL_CACHE: dict = {}


def load_model(model_name: str = DEFAULT_MODEL, device: str = "cuda"):
    """Load (and process-wide cache) a Sam2Model/Sam2Processor pair. Imports torch and
    transformers lazily so this module stays importable for its pure helpers without
    either installed."""
    cache_key = (model_name, device)
    if cache_key not in _MODEL_CACHE:
        import torch
        from transformers import Sam2Model, Sam2Processor
        model = Sam2Model.from_pretrained(model_name).to(device).eval()
        processor = Sam2Processor.from_pretrained(model_name)
        _MODEL_CACHE[cache_key] = (model, processor)
    return _MODEL_CACHE[cache_key]


def largest_component_centroid(mask: np.ndarray) -> tuple[float, float] | None:
    """Centroid (x, y), in `mask`'s own local coordinates, of its largest 8-connected
    True component - or None if `mask` has no True pixels at all."""
    found = largest_component_centroid_and_base(mask)
    return None if found is None else found[0]


def largest_component_centroid_and_base(mask: np.ndarray) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """(centroid, base) of `mask`'s largest 8-connected True component, both (x, y) in
    `mask`'s own local coordinates - or None if `mask` has no True pixels at all. `base`
    is the centroid of just that component's lowest 15% of rows (its feet, or the
    ground it stands on) - used as an extra negative point for a cell's *neighbors*, to
    push a figure's own mask away from a shared floor shadow or prop at the neighbor's
    base rather than only away from the neighbor's own body center."""
    if mask.size == 0 or not mask.any():
        return None
    labels, n = ndimage.label(mask, structure=STRUCT8)
    if n == 0:
        return None
    sizes = ndimage.sum(mask, labels, index=np.arange(1, n + 1))
    biggest = int(np.argmax(sizes)) + 1
    ys, xs = np.where(labels == biggest)
    centroid = (float(xs.mean()), float(ys.mean()))
    y_min, y_max = int(ys.min()), int(ys.max())
    threshold = y_min + 0.85 * (y_max - y_min)
    base_rows = ys >= threshold
    base = (float(xs[base_rows].mean()), float(ys[base_rows].mean()))
    return centroid, base


def resolve_ownership(masks: list[np.ndarray], logits: list[np.ndarray]) -> np.ndarray:
    """Assign every pixel claimed by two or more boolean `masks` to whichever mask has
    the higher value at that pixel in the corresponding `logits` array (SAM's continuous
    mask score, same shape as each mask). A pixel claimed by exactly one mask keeps that
    mask regardless of its logit. Returns an int16 array, shape == masks[0].shape,
    1-based index into `masks` (0 = claimed by no mask)."""
    if not masks:
        return np.zeros((0, 0), dtype=np.int16)
    shape = masks[0].shape
    owner = np.zeros(shape, dtype=np.int16)
    best = np.full(shape, -np.inf, dtype=np.float64)
    for i, (m, lg) in enumerate(zip(masks, logits), start=1):
        first_claim = m & (owner == 0)
        owner[first_claim] = i
        best[first_claim] = lg[first_claim]
        contested = m & (owner != 0) & (~first_claim)
        win = contested & (lg > best)
        owner[win] = i
        best[win] = lg[win]
    return owner


def is_hairline(w: int, h: int, max_thickness: float, min_length: float) -> bool:
    """A box is a hairline sliver - a stray keying seam, not real content - if it is at
    most `max_thickness` px thick in one direction and at least `min_length` px long in
    the other, in either orientation."""
    return (w <= max_thickness and h >= min_length) or (h <= max_thickness and w >= min_length)


def in_numeral_strip(y0: int, y1: int, numeral_strip: tuple[float, float] | None) -> bool:
    """True if the vertical span [y0, y1) lies entirely inside `numeral_strip` (a
    sheet-space [strip_y0, strip_y1) band of printed frame numerals) - the fragment is a
    stray digit, not figure content. False (never drop) if `numeral_strip` is None."""
    if numeral_strip is None:
        return False
    s0, s1 = numeral_strip
    return y0 >= s0 and y1 <= s1


def is_text_label(frag_y0: int, frag_y1: int, frag_h: int, topmost_object_row: int,
                   min_gap: float, max_height: float) -> bool:
    """True if a fragment's box lies entirely above the band's topmost object-mask row
    by more than `min_gap` px, and is itself under `max_height` px tall - a panel title
    or label word the crop's wide margin pulled into scope, not figure content. `frag_y1`
    is exclusive (one past the fragment's own lowest row), matching `Box.y1`."""
    gap = topmost_object_row - frag_y1
    return gap > min_gap and frag_h < max_height


def compute_anchor(mask: np.ndarray) -> tuple[int, int]:
    """(ax, ay) for a boolean `mask`, in `mask`'s own local coordinates: ax is the
    centroid x of the mask's lowest 10% of occupied rows (the "feet"), ay is one past the
    mask's lowest occupied row. Raises ValueError if `mask` has no True pixels."""
    ys, xs = np.where(mask)
    if ys.size == 0:
        raise ValueError("compute_anchor: mask has no True pixels")
    y_min, y_max = int(ys.min()), int(ys.max())
    threshold = y_min + 0.9 * (y_max - y_min)
    feet = ys >= threshold
    ax = int(round(float(xs[feet].mean())))
    ay = y_max + 1
    return ax, ay


FLOOR_ROWS_FRAC = 0.12
FLOOR_WIDEN_FRAC = 0.10
FLOOR_LINE_MAX_THICKNESS = 3


def trim_floor_rows(mask: np.ndarray, rows_frac: float = FLOOR_ROWS_FRAC,
                    widen_frac: float = FLOOR_WIDEN_FRAC) -> np.ndarray:
    """Clip the bottom rows of an object mask to the body's horizontal extent.

    Seated and fallen poses on the sheet rest on a drawn ground line that runs across
    the panel. SAM includes that line with the figure, and since a band never clips a
    frame, the line would drag the crop across the sheet. Rows in the bottom
    `rows_frac` of the mask's height may not extend past the extent of the rows above
    them by more than `widen_frac` of that extent's width on either side. A flared hem
    or a shadow under the feet survives; a long floor line does not.
    """
    rows = np.where(mask.any(axis=1))[0]
    if rows.size == 0:
        return mask
    y0, y1 = int(rows[0]), int(rows[-1])
    cut = y1 - max(1, int(round((y1 - y0 + 1) * rows_frac)))
    if cut <= y0:
        return mask
    body_cols = np.where(mask[y0:cut + 1].any(axis=0))[0]
    if body_cols.size == 0:
        return mask
    bx0, bx1 = int(body_cols[0]), int(body_cols[-1])
    margin = int(round((bx1 - bx0 + 1) * widen_frac))
    # Only thin columns get cleared: a ground line is 1 to 3 px tall where it leaves
    # the body, while a flared hem or a prop base outside the margin is thick.
    bottom = mask[cut + 1:y1 + 1]
    col_height = bottom.sum(axis=0)
    outside = np.ones(mask.shape[1], dtype=bool)
    outside[max(0, bx0 - margin):bx1 + margin + 1] = False
    clear = outside & (col_height <= FLOOR_LINE_MAX_THICKNESS)
    out = mask.copy()
    out[cut + 1:y1 + 1, clear] = False
    return out


def touching_owner(frag: np.ndarray, masks: list[np.ndarray]) -> int | None:
    """Index into `masks` of whichever mask has the most 4-neighbor-adjacent pixels
    touching `frag` (a boolean fragment mask), or None if `frag` touches no mask at all.
    A fragment that is physically glued onto an object's own silhouette - a small notch
    SAM's mask missed at a jagged edge (a scalloped hem, a thin staff), or a piece of a
    floating companion that only touches another already-attached piece of itself - is
    recovered by this check before the numeral-strip/aspect-ratio/hairline/distance drop
    rules (meant for genuinely floating debris) get a say. Callers should apply this
    repeatedly to a fixed point (passing the growing `masks` back in) so a chain of
    touching fragments - a skull's cheek touching its own jaw touching its neck cable
    touching the body - all resolve to the same object in one pass over the band."""
    best_i, best_count = None, 0
    for i, m in enumerate(masks):
        c = contact_length(frag, m)
        if c > best_count:
            best_i, best_count = i, c
    return best_i


def contact_length(mask_a: np.ndarray, mask_b: np.ndarray) -> int:
    """Number of 4-neighbor pixel pairs where one pixel belongs to `mask_a` and its
    neighbor belongs to `mask_b` - an informational measure of how much two adjacent
    objects visually touch (SAM's exact per-pixel ownership makes this fine either way;
    it is reported, not enforced)."""
    total = 0
    total += int((mask_a[:, :-1] & mask_b[:, 1:]).sum())
    total += int((mask_b[:, :-1] & mask_a[:, 1:]).sum())
    total += int((mask_a[:-1, :] & mask_b[1:, :]).sum())
    total += int((mask_b[:-1, :] & mask_a[1:, :]).sum())
    return total


def fragment_pixel_distance(frag: np.ndarray, mask: np.ndarray) -> float:
    """Minimum pixel distance (Euclidean) between any True pixel of `frag` and any True
    pixel of `mask`. inf if either is empty."""
    if not frag.any() or not mask.any():
        return float("inf")
    dist = ndimage.distance_transform_edt(~mask)
    return float(dist[frag].min())


def nearest_by_distance(frag: np.ndarray, masks: list[np.ndarray], max_distance: float) -> int | None:
    """Index into `masks` of whichever mask is nearest to `frag` by pixel distance
    (`fragment_pixel_distance`), if that distance is at most `max_distance`; None if
    every mask is farther than that (or `masks` is empty) - the fragment is dropped
    rather than attached. Distance, not a shared point's x-coordinate, so a fragment
    tucked close to one figure is never stolen by a farther figure just because its
    prompt point happens to sit at a similar x."""
    if not masks:
        return None
    dists = [fragment_pixel_distance(frag, m) for m in masks]
    best = int(np.argmin(dists))
    return best if dists[best] <= max_distance else None


def expand_rect(rect: tuple[float, float, float, float], frac: float) -> tuple[float, float, float, float]:
    """`rect` (x0, y0, x1, y1) widened by `frac` of its own width on each side
    horizontally and `frac` of its own height on each side vertically."""
    x0, y0, x1, y1 = rect
    w, h = x1 - x0, y1 - y0
    return (x0 - frac * w, y0 - frac * h, x1 + frac * w, y1 + frac * h)


def rect_contains(outer: tuple[float, float, float, float], inner: tuple[float, float, float, float]) -> bool:
    """True if `inner` (x0, y0, x1, y1) lies entirely within `outer`."""
    ox0, oy0, ox1, oy1 = outer
    ix0, iy0, ix1, iy1 = inner
    return ix0 >= ox0 and iy0 >= oy0 and ix1 <= ox1 and iy1 <= oy1


def rects_intersect(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    """True if rectangles `a` and `b` (each x0, y0, x1, y1) overlap by a nonzero area."""
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1


def mask_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    """(x0, y0, x1, y1) bounding box of a boolean mask's True pixels, x1/y1 exclusive.
    None if `mask` has no True pixels."""
    ys, xs = np.where(mask)
    if ys.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def mask_overlap_fraction(mask: np.ndarray, rect: tuple[float, float, float, float]) -> float:
    """Fraction of `mask`'s own True pixels that fall inside `rect` (x0, y0, x1, y1),
    i.e. |mask AND rect| / |mask|. 1.0 if `mask` is empty (nothing to fail the check)."""
    total = int(mask.sum())
    if total == 0:
        return 1.0
    x0, y0, x1, y1 = (int(round(v)) for v in rect)
    h, w = mask.shape
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inside = int(mask[y0:y1, x0:x1].sum())
    return inside / total


def _cell_layout(band: dict, x0: int, y0: int, x1: int, y1: int):
    """Per-frame (idx, cell_x0, cell_x1, cell_y0, cell_y1, is_first_col, is_last_col)
    tuples, in the band's printed frame order. See `_cell_boxes_and_points` for the
    single-row vs `"grid"` layout rules; this only computes the raw (unwidened) cell
    rectangles and which cells sit at the left/right edge of the band (so their SAM
    prompt box can be extended all the way to the crop edge instead of just 15% past the
    cell, per `_cell_boxes_and_points`)."""
    n = band["count"]
    grid = band.get("grid")
    if grid:
        cols, grid_rows = grid
        if cols * grid_rows != n:
            raise ValueError(f"band {band['name']}: grid {grid} does not multiply to count {n}")
        row_split = band.get("rowSplit")
        if row_split is None:
            row_ys = [y0 + round((y1 - y0) * r / grid_rows) for r in range(grid_rows + 1)]
        else:
            cuts = row_split if isinstance(row_split, list) else [row_split]
            row_ys = [y0] + list(cuts) + [y1]
        band_w = x1 - x0
        cw = band_w / cols
        return [(r * cols + c, x0 + c * cw, x0 + (c + 1) * cw, row_ys[r], row_ys[r + 1], c == 0, c == cols - 1)
                for r in range(grid_rows) for c in range(cols)]
    cw = (x1 - x0) / n
    return [(i, x0 + i * cw, x0 + (i + 1) * cw, y0, y1, i == 0, i == n - 1) for i in range(n)]


def _cell_boxes_and_points(alpha: np.ndarray, band: dict, x0: int, y0: int, x1: int, y1: int,
                            cx0: int, cy0: int, cx1: int, cy1: int, edge_buffer: int):
    """Per-frame prompt box (sheet coords), positive point (sheet coords), and raw
    (unwidened) cell rectangle, for every frame in a band's `count`. The positive point
    is the centroid of the largest keyed component inside the middle third of the
    frame's own cell. Raises ValueError naming the band and frame index if that middle
    third has no keyed pixels at all.

    Normally a band is one row of `count` equal-width cells spanning the full band
    height (band_width / count each). A band with a `"grid": [cols, rows]` key (e.g.
    "faces", printed as a cols x rows grid rather than a single row) instead gets a
    cols-wide x rows-tall grid of cells, split horizontally into `cols` equal columns
    and vertically at `"rowSplit"` - cells are numbered row-major.

    A cell's SAM prompt box normally overshoots its own cell by `CELL_OVERSHOOT_FRAC` on
    each side; the leftmost column's box instead extends most of the way to the crop's
    own left edge (`cx0 + edge_buffer`), and the rightmost column's box to most of the
    way to the crop's own right edge (`cx1 - edge_buffer`) - band edges are not a hard
    boundary (a band is only a prompt region), so the outermost figures get almost the
    full available crop width to be found in, the same way an inner figure already gets
    its neighbor's cell as headroom. `edge_buffer` keeps the box itself from ever
    touching the crop's true edge, so the crop-boundary guard in `_group_frames_sam`
    (which fires when a mask reaches that true edge) still has real slack to check
    against, rather than firing on essentially every edge figure by construction.
    """
    boxes: list = [None] * band["count"]
    points: list = [None] * band["count"]
    bases: list = [None] * band["count"]
    raw_cells: list = [None] * band["count"]
    for idx, cell_x0, cell_x1, cell_y0, cell_y1, is_first, is_last in _cell_layout(band, x0, y0, x1, y1):
        cell_w = cell_x1 - cell_x0
        box_x0 = float(cx0 + edge_buffer) if is_first else cell_x0 - CELL_OVERSHOOT_FRAC * cell_w
        box_x1 = float(cx1 - edge_buffer) if is_last else cell_x1 + CELL_OVERSHOOT_FRAC * cell_w
        box = (box_x0, float(cell_y0), box_x1, float(cell_y1))
        mid_x0 = cell_x0 + cell_w * MIDDLE_THIRD_FRAC
        mid_x1 = cell_x1 - cell_w * MIDDLE_THIRD_FRAC
        lx0, lx1 = max(0, int(round(mid_x0))), min(alpha.shape[1], int(round(mid_x1)))
        ly0, ly1 = max(0, int(round(cell_y0))), min(alpha.shape[0], int(round(cell_y1)))
        region = alpha[ly0:ly1, lx0:lx1] > 0
        found = largest_component_centroid_and_base(region)
        if found is None:
            raise ValueError(
                f"band {band['name']}: no positive point found for frame {idx} "
                f"(middle third x[{mid_x0:.1f},{mid_x1:.1f}] y[{cell_y0},{cell_y1}] has no keyed pixels)")
        centroid, base = found
        boxes[idx] = box
        points[idx] = (centroid[0] + lx0, centroid[1] + ly0)
        bases[idx] = (base[0] + lx0, base[1] + ly0)
        raw_cells[idx] = (cell_x0, cell_y0, cell_x1, cell_y1)
    return boxes, points, bases, raw_cells


def _safe_crop_bounds(band: dict, other_bands: list[dict] | None, x0: int, y0: int, x1: int, y1: int,
                       margin: int, shape: tuple[int, int]) -> tuple[int, int, int, int]:
    """Crop bounds for `band`: its rectangle widened by `margin` on every side, clamped
    to the sheet - and, if `other_bands` is given, ALSO clamped to never cross the
    midpoint between this band and a plausible horizontal or vertical neighbor (one
    whose rectangle overlaps this band's own extent on the perpendicular axis). Two
    panels can sit as little as ~10px apart, far less than a margin generous enough to
    contain a figure's own effects - without this, that margin reaches past the gap
    into the neighboring panel, and its content can be pulled in as an "unclaimed"
    fragment (or even directly swallowed by touching_owner)."""
    h, w = shape
    cx0, cy0 = max(0, x0 - margin), max(0, y0 - margin)
    cx1, cy1 = min(w, x1 + margin), min(h, y1 + margin)
    for other in other_bands or []:
        if other is band or other.get("name") == band.get("name"):
            continue
        ox0, ox1 = other["x"]
        oy0, oy1 = other["y"]
        if oy0 < y1 and y0 < oy1:  # shares a horizontal edge with this band's own extent
            if ox0 >= x1:
                cx1 = min(cx1, (x1 + ox0) / 2)
            if ox1 <= x0:
                cx0 = max(cx0, (x0 + ox1) / 2)
        if ox0 < x1 and x0 < ox1:  # shares a vertical edge with this band's own extent
            if oy0 >= y1:
                cy1 = min(cy1, (y1 + oy0) / 2)
            if oy1 <= y0:
                cy0 = max(cy0, (y0 + oy1) / 2)
    return int(round(cx0)), int(round(cy0)), int(round(cx1)), int(round(cy1))


def segment_band(rgb: np.ndarray, alpha: np.ndarray, band: dict, scale: float = 1.0,
                  model=None, processor=None, device: str = "cuda",
                  other_bands: list[dict] | None = None) -> dict:
    """Run SAM 2 on one counted band's figures, one box+point prompt per frame, sharing a
    single crop as the model's input image: the band rectangle widened by `MARGIN_1X`
    px on every side (clamped to the sheet) - never the band rectangle alone, so a
    figure's companion or effect landing outside the nominal band never gets cut off at
    the source. Returns:

        {"boxes": [(x0,y0,x1,y1), ...],   # per-frame prompt box, sheet coords
         "points": [(x, y), ...],          # per-frame positive point, sheet coords
         "cells": [(x0,y0,x1,y1), ...],    # per-frame raw (unwidened) cell rect, sheet coords
         "masks": [bool array, ...],        # per-frame SAM mask AND alpha>0, full sheet shape
         "logits": [float array, ...],      # per-frame raw mask logits, full sheet shape
         "crop_box": (cx0, cy0, cx1, cy1)}  # the shared SAM input crop, sheet coords

    Order matches the band's printed frame order (left to right, or row-major for a
    `"grid"` band). Raises ValueError (naming the band and frame index) if a frame's
    positive point cannot be found.
    """
    if model is None or processor is None:
        model, processor = load_model()
    import torch

    x0, x1 = (int(round(v * scale)) for v in band["x"])
    y0, y1 = (int(round(v * scale)) for v in band["y"])
    margin = int(round(MARGIN_1X * scale))
    edge_buffer = min(margin, int(round(EDGE_GUARD_BUFFER_1X * scale)))
    cx0, cy0, cx1, cy1 = _safe_crop_bounds(band, other_bands, x0, y0, x1, y1, margin, alpha.shape)

    boxes, points, bases, cells = _cell_boxes_and_points(
        alpha, band, x0, y0, x1, y1, cx0, cy0, cx1, cy1, edge_buffer)

    crop_rgb = rgb[cy0:cy1, cx0:cx1]
    image = Image.fromarray(crop_rgb)
    n = band["count"]

    crop_h, crop_w = crop_rgb.shape[:2]
    masks_full, logits_full = [], []
    for i in range(n):
        bx0, by0, bx1, by1 = boxes[i]
        local_box = [max(0.0, bx0 - cx0), max(0.0, by0 - cy0),
                     min(float(crop_w), bx1 - cx0), min(float(crop_h), by1 - cy0)]
        pos = [points[i][0] - cx0, points[i][1] - cy0]
        pts = [pos]
        labels = [1]
        # A neighbor gets two negative points: its own center (pushes the mask away
        # from the neighbor's body) and its base - the centroid of its lowest rows,
        # where a shared floor shadow or prop is most likely to sit (pushes the mask
        # away from swallowing that shared ground area too).
        if i > 0:
            pts.append([points[i - 1][0] - cx0, points[i - 1][1] - cy0]); labels.append(0)
            pts.append([bases[i - 1][0] - cx0, bases[i - 1][1] - cy0]); labels.append(0)
        if i < n - 1:
            pts.append([points[i + 1][0] - cx0, points[i + 1][1] - cy0]); labels.append(0)
            pts.append([bases[i + 1][0] - cx0, bases[i + 1][1] - cy0]); labels.append(0)

        inputs = processor(image, input_boxes=[[local_box]], input_points=[[pts]],
                            input_labels=[[labels]], return_tensors="pt").to(device)
        with torch.no_grad():
            outputs = model(**inputs, multimask_output=False)
        # SAM pads/resizes the crop to a square model input (e.g. 1024x1024) before
        # encoding, so upscaling pred_masks (256x256 model-resolution logits) back to the
        # crop's own (possibly non-square) size has to undo that padding correctly -
        # processor.post_process_masks does this properly (unlike a naive resize of the
        # raw logits, which would stretch across the padding). binarize=False keeps it
        # continuous so resolve_ownership() has real logit values to compare on overlaps.
        resized = processor.post_process_masks(
            outputs.pred_masks.cpu(), inputs["original_sizes"].cpu(), binarize=False)[0]
        crop_logits = resized.reshape(resized.shape[-2], resized.shape[-1]).numpy()
        crop_mask = crop_logits > 0.0

        full_mask = np.zeros(alpha.shape, dtype=bool)
        full_logits = np.full(alpha.shape, -np.inf, dtype=np.float64)
        full_mask[cy0:cy1, cx0:cx1] = crop_mask & (alpha[cy0:cy1, cx0:cx1] > 0)
        full_logits[cy0:cy1, cx0:cx1] = crop_logits
        masks_full.append(full_mask)
        logits_full.append(full_logits)

    return {"boxes": boxes, "points": points, "cells": cells, "masks": masks_full,
            "logits": logits_full, "crop_box": (cx0, cy0, cx1, cy1)}


def main() -> None:
    p = argparse.ArgumentParser(description="Run SAM 2 on one band, for experimentation.")
    p.add_argument("sheet")
    p.add_argument("--band", required=True, help="band name from rows.json")
    p.add_argument("--rows", default=os.path.join(os.path.dirname(__file__), "rows.json"))
    p.add_argument("--out", default=None, help="write a diagnostic PNG here (tinted masks)")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--device", default="cuda")
    a = p.parse_args()

    rows_data = json.load(open(a.rows))
    band = next(b for b in rows_data["bands"] if b["name"] == a.band)
    rgb = np.array(Image.open(a.sheet).convert("RGB"))
    tolerance = rows_data.get("keyTolerance", 16)
    alpha = key_background_bands(rgb, band_rects(rows_data["bands"], 1.0), tolerance)

    model, processor = load_model(a.model, a.device)
    result = segment_band(rgb, alpha, band, 1.0, model, processor, a.device)
    owner = resolve_ownership(result["masks"], result["logits"])
    for i, m in enumerate(result["masks"]):
        area = int((owner == i + 1).sum())
        print(f"frame {i}: point={result['points'][i]} area={area}px")

    if a.out:
        colors = [(255, 80, 80), (80, 200, 255), (120, 255, 120), (255, 220, 80),
                  (200, 120, 255), (255, 150, 60), (100, 255, 220), (255, 100, 200)]
        vis = rgb.copy()
        for i in range(len(result["masks"])):
            m = owner == (i + 1)
            color = np.array(colors[i % len(colors)])
            vis[m] = (vis[m].astype(int) * 0.6 + color * 0.4).astype(np.uint8)
        Image.fromarray(vis).save(a.out)
        print("wrote", a.out)


if __name__ == "__main__":
    main()
