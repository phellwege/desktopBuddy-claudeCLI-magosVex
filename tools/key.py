"""Turn a solid-background RGB sheet into RGBA by flood-filling the background from the border.

key_background handles a sheet with one uniform background color throughout the whole
image. key_background_bands handles a sheet whose panels each have their own background
fill: every band in rows.json is keyed independently, from its own locally sampled
background color, so a panel-to-panel fill difference never forces a loose global
tolerance (a loose tolerance is what let the border flood fill leak through dark armor
pixels at a figure's silhouette into its own enclosed dark interior - hood openings, eyes).
"""
import argparse, json
import numpy as np
from PIL import Image
from scipy import ndimage

STRUCT3 = np.ones((3, 3), dtype=bool)


def _flood_background(near: np.ndarray) -> np.ndarray:
    """Border-connected component of `near`, with a thin-leak guard.

    A plain border-connected-component test treats any 1px-wide near-background corridor
    (anti-aliasing at a silhouette edge) as a full connection, so an enclosed dark interior
    that is otherwise within color tolerance of the background leaks out and keys transparent
    even though it should stay opaque. Opening `near` with a 3x3 structuring element first
    removes any region that is only reachable through a 1-2px wide gap, then dilating the
    border-connected core by one pixel restores the true near-background boundary (so
    anti-aliased edges still key out) without restoring the thin leak paths themselves.
    """
    eroded = ndimage.binary_erosion(near, structure=STRUCT3, border_value=1)
    core = ndimage.binary_dilation(eroded, structure=STRUCT3, border_value=0)
    labels, _ = ndimage.label(core)
    edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    bgcore = np.isin(labels, edge[edge != 0])
    return near & ndimage.binary_dilation(bgcore, structure=STRUCT3, border_value=0)


def key_background(rgb: np.ndarray, tolerance: int = 36, inset: int = 4) -> np.ndarray:
    im = rgb[..., :3].astype(int)
    h, w = im.shape[:2]
    i = min(inset, h // 2 - 1, w // 2 - 1)
    ring = np.concatenate([im[i, i:w - i], im[h - 1 - i, i:w - i], im[i:h - i, i], im[i:h - i, w - 1 - i]])
    bg = np.median(ring, axis=0)
    near = np.abs(im - bg).sum(-1) <= tolerance
    near[:i, :] = near[h - i:, :] = near[:, :i] = near[:, w - i:] = True
    background = _flood_background(near)
    return np.where(background, 0, 255).astype(np.uint8)


def key_background_bands(rgb: np.ndarray, bands: list[tuple[int, int, int, int]],
                          tolerance: int = 16, inset: int = 2) -> np.ndarray:
    """Key each (x0, y0, x1, y1) pixel-space band rectangle from its own local background.

    Pixels outside every band come back transparent. Where two bands overlap, a pixel is
    background if any band covering it keys it as background (background wins).
    """
    im = rgb[..., :3].astype(int)
    h, w = im.shape[:2]
    alpha = np.zeros((h, w), dtype=np.uint8)
    covered = np.zeros((h, w), dtype=bool)
    for bx0, by0, bx1, by1 in bands:
        bx0, by0 = max(0, bx0), max(0, by0)
        bx1, by1 = min(w, bx1), min(h, by1)
        if bx1 - bx0 < 2 * inset + 1 or by1 - by0 < 2 * inset + 1:
            continue
        sub = im[by0:by1, bx0:bx1]
        bh, bw = sub.shape[:2]
        i = min(inset, bh // 2 - 1, bw // 2 - 1)
        ring = np.concatenate([sub[i, i:bw - i], sub[bh - 1 - i, i:bw - i], sub[i:bh - i, i], sub[i:bh - i, bw - 1 - i]])
        bg = np.median(ring, axis=0)
        near = np.abs(sub - bg).sum(-1) <= tolerance
        near[:i, :] = near[bh - i:, :] = near[:, :i] = near[:, bw - i:] = True
        background = _flood_background(near)
        fg = np.where(background, 0, 255).astype(np.uint8)
        region = alpha[by0:by1, bx0:bx1]
        was_covered = covered[by0:by1, bx0:bx1]
        alpha[by0:by1, bx0:bx1] = np.where(was_covered, np.minimum(region, fg), fg)
        covered[by0:by1, bx0:bx1] = True
    return alpha


def band_rects(bands: list[dict], scale: float = 1.0) -> list[tuple[int, int, int, int]]:
    """Convert rows.json band dicts to (x0, y0, x1, y1) integer pixel rectangles at scale."""
    return [
        (int(round(b["x"][0] * scale)), int(round(b["y"][0] * scale)),
         int(round(b["x"][1] * scale)), int(round(b["y"][1] * scale)))
        for b in bands
    ]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--tolerance", type=int)
    p.add_argument("--inset", type=int)
    p.add_argument("--rows", help="rows.json path; when given, keys each band from its own local background")
    p.add_argument("--scale", type=float, default=1.0)
    a = p.parse_args()
    rgb = np.array(Image.open(a.src).convert("RGB"))
    if a.rows:
        rows = json.load(open(a.rows))
        tolerance = a.tolerance if a.tolerance is not None else rows.get("keyTolerance", 16)
        inset = a.inset if a.inset is not None else 2
        alpha = key_background_bands(rgb, band_rects(rows["bands"], a.scale), tolerance, inset)
    else:
        tolerance = a.tolerance if a.tolerance is not None else 36
        inset = a.inset if a.inset is not None else 4
        alpha = key_background(rgb, tolerance, inset)
    Image.fromarray(np.dstack([rgb, alpha])).save(a.dst)
    print(f"wrote {a.dst}: background {100 * (alpha == 0).mean():.1f}%")


if __name__ == "__main__":
    main()
