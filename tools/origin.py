"""Projection origin for a frame: where the hologram cone starts. On these sheets that is
the floating servo skull, the highest bone-colored blob in the frame (the staff finial is
also bone but sits at hood height). Returns crop-local (x, y) or None."""
import numpy as np
from scipy import ndimage

BONE_MIN = 165          # every channel at least this bright
BONE_SPREAD = 45        # max minus min channel at most this (ivory, not colored)
STRUCT8 = np.ones((3, 3), dtype=bool)


def bone_mask(crop_rgba: np.ndarray) -> np.ndarray:
    rgb = crop_rgba[..., :3].astype(int)
    alpha = crop_rgba[..., 3] if crop_rgba.shape[-1] == 4 else np.full(rgb.shape[:2], 255)
    bright = rgb.min(axis=-1) >= BONE_MIN
    flat = (rgb.max(axis=-1) - rgb.min(axis=-1)) <= BONE_SPREAD
    return bright & flat & (alpha > 0)


def detect_origin(crop_rgba: np.ndarray, min_area: int = 30) -> tuple[int, int] | None:
    labels, n = ndimage.label(bone_mask(crop_rgba), structure=STRUCT8)
    if n == 0:
        return None
    best = None
    for i in range(1, n + 1):
        ys, xs = np.where(labels == i)
        if ys.size < min_area:
            continue
        cy, cx = float(ys.mean()), float(xs.mean())
        if best is None or cy < best[1]:
            best = (int(round(cx)), int(round(cy)))
    return best
