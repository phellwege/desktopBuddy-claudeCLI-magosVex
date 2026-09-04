"""SAM 2 based object segmentation for one counted band of the sprite sheet.

Model: facebook/sam2.1-hiera-small via transformers' Sam2Model + Sam2Processor
(DEFAULT_MODEL). If mask quality on these chibi figures turns out poor, pass
`--sam-model facebook/sam2.1-hiera-base-plus` (slice.py) or `--model ...` (this file's
own --band CLI) to try the larger checkpoint instead - there is no automatic fallback.

`segment_band()` is the only function that needs torch/transformers; every other
function here (`largest_component_centroid`, `resolve_ownership`, `is_hairline`,
`in_numeral_strip`, `nearest_attachment`, `compute_anchor`, `contact_length`) is pure
numpy/scipy and is unit-tested directly, without a model or CUDA, from
tools/test_pipeline.py. torch and transformers are therefore imported lazily inside
`load_model`/`segment_band`, not at module level, so importing this module (for its pure
helpers) works in the regular tools/.venv too.

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
MARGIN_1X = 24
CELL_OVERSHOOT_FRAC = 0.15
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
    if mask.size == 0 or not mask.any():
        return None
    labels, n = ndimage.label(mask, structure=STRUCT8)
    if n == 0:
        return None
    sizes = ndimage.sum(mask, labels, index=np.arange(1, n + 1))
    biggest = int(np.argmax(sizes)) + 1
    ys, xs = np.where(labels == biggest)
    return float(xs.mean()), float(ys.mean())


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


def nearest_attachment(cx: float, points: list[float], max_dx: float) -> int | None:
    """Index into `points` (each a positive-point x coordinate, one per object) that is
    horizontally nearest to `cx`, if within `max_dx`; None if every point is farther than
    that (or `points` is empty) - the fragment is dropped rather than attached."""
    if not points:
        return None
    nearest = min(range(len(points)), key=lambda i: abs(points[i] - cx))
    return nearest if abs(points[nearest] - cx) <= max_dx else None


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


def touching_owner(frag: np.ndarray, masks: list[np.ndarray]) -> int | None:
    """Index into `masks` of whichever mask has the most 4-neighbor-adjacent pixels
    touching `frag` (a boolean fragment mask), or None if `frag` touches no mask at all.
    A fragment that is physically glued onto an object's own silhouette - a small notch
    SAM's mask missed at a jagged edge (a scalloped hem, a thin staff) - is recovered by
    this check before the numeral-strip/aspect-ratio/hairline drop rules (meant for
    genuinely floating debris - a stray numeral, a disconnected decoration) get a say."""
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


def _cell_boxes_and_points(alpha: np.ndarray, band: dict, x0: int, y0: int, x1: int, y1: int):
    """Per-frame prompt box (sheet coords) and positive point (sheet coords), for every
    frame in a band's `count`. The positive point is the centroid of the largest keyed
    component inside the middle third of the frame's own cell. Raises ValueError naming
    the band and frame index if that middle third has no keyed pixels at all.

    Normally a band is one row of `count` equal-width cells spanning the full band
    height (band_width / count each). A band with a `"grid": [cols, rows]` key (e.g.
    "faces", printed as a cols x rows grid rather than a single row) instead gets a
    cols-wide x rows-tall grid of cells (cols * rows must equal `count`), split
    horizontally into `cols` equal columns and vertically at `"rowSplit"` (a single y
    cut for 2 rows; a list of `rows - 1` cuts for more) - cells are numbered row-major
    (row 0 left-to-right, then row 1, ...).
    """
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
        cells = [(r * cols + c, x0 + c * cw, x0 + (c + 1) * cw, row_ys[r], row_ys[r + 1])
                 for r in range(grid_rows) for c in range(cols)]
    else:
        band_w = x1 - x0
        cw = band_w / n
        cells = [(i, x0 + i * cw, x0 + (i + 1) * cw, y0, y1) for i in range(n)]

    boxes: list = [None] * n
    points: list = [None] * n
    for idx, cell_x0, cell_x1, cell_y0, cell_y1 in cells:
        cell_w = cell_x1 - cell_x0
        box = (cell_x0 - CELL_OVERSHOOT_FRAC * cell_w, float(cell_y0),
               cell_x1 + CELL_OVERSHOOT_FRAC * cell_w, float(cell_y1))
        mid_x0 = cell_x0 + cell_w * MIDDLE_THIRD_FRAC
        mid_x1 = cell_x1 - cell_w * MIDDLE_THIRD_FRAC
        lx0, lx1 = max(0, int(round(mid_x0))), min(alpha.shape[1], int(round(mid_x1)))
        ly0, ly1 = max(0, int(round(cell_y0))), min(alpha.shape[0], int(round(cell_y1)))
        region = alpha[ly0:ly1, lx0:lx1] > 0
        centroid = largest_component_centroid(region)
        if centroid is None:
            raise ValueError(
                f"band {band['name']}: no positive point found for frame {idx} "
                f"(middle third x[{mid_x0:.1f},{mid_x1:.1f}] y[{cell_y0},{cell_y1}] has no keyed pixels)")
        px, py = centroid[0] + lx0, centroid[1] + ly0
        boxes[idx] = box
        points[idx] = (px, py)
    return boxes, points


def segment_band(rgb: np.ndarray, alpha: np.ndarray, band: dict, scale: float = 1.0,
                  model=None, processor=None, device: str = "cuda") -> dict:
    """Run SAM 2 on one counted band's figures, one box+point prompt per frame, sharing a
    single band-plus-margin crop as the model's input image (better resolution per figure
    than the whole sheet). Returns:

        {"boxes": [(x0,y0,x1,y1), ...],       # per-frame prompt box, sheet coords
         "points": [(x, y), ...],              # per-frame positive point, sheet coords
         "masks": [bool array, ...],            # per-frame SAM mask AND alpha>0, full
                                                  sheet shape (same as `alpha`)
         "logits": [float array, ...]}          # per-frame raw mask logits, full sheet
                                                  shape, for resolve_ownership()

    Order matches the band's printed frame order (left to right). Raises ValueError
    (naming the band and frame index) if a frame's positive point cannot be found.
    """
    if model is None or processor is None:
        model, processor = load_model()
    import torch

    x0, x1 = (int(round(v * scale)) for v in band["x"])
    y0, y1 = (int(round(v * scale)) for v in band["y"])
    margin = int(round(MARGIN_1X * scale))
    h, w = alpha.shape
    cx0, cy0 = max(0, x0 - margin), max(0, y0 - margin)
    cx1, cy1 = min(w, x1 + margin), min(h, y1 + margin)

    boxes, points = _cell_boxes_and_points(alpha, band, x0, y0, x1, y1)

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
        if i > 0:
            pts.append([points[i - 1][0] - cx0, points[i - 1][1] - cy0]); labels.append(0)
        if i < n - 1:
            pts.append([points[i + 1][0] - cx0, points[i + 1][1] - cy0]); labels.append(0)

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

    return {"boxes": boxes, "points": points, "masks": masks_full, "logits": logits_full}


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
