"""Turn a solid-background RGB sheet into RGBA by flood-filling the background from the border."""
import argparse
import numpy as np
from PIL import Image
from scipy import ndimage


def key_background(rgb: np.ndarray, tolerance: int = 36, inset: int = 4) -> np.ndarray:
    im = rgb[..., :3].astype(int)
    h, w = im.shape[:2]
    i = min(inset, h // 2 - 1, w // 2 - 1)
    ring = np.concatenate([im[i, i:w - i], im[h - 1 - i, i:w - i], im[i:h - i, i], im[i:h - i, w - 1 - i]])
    bg = np.median(ring, axis=0)
    near = np.abs(im - bg).sum(-1) <= tolerance
    near[:i, :] = near[h - i:, :] = near[:, :i] = near[:, w - i:] = True
    labels, _ = ndimage.label(near)
    edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    background = np.isin(labels, edge[edge != 0])
    return np.where(background, 0, 255).astype(np.uint8)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--tolerance", type=int, default=36)
    p.add_argument("--inset", type=int, default=4)
    a = p.parse_args()
    rgb = np.array(Image.open(a.src).convert("RGB"))
    alpha = key_background(rgb, a.tolerance, a.inset)
    Image.fromarray(np.dstack([rgb, alpha])).save(a.dst)
    print(f"wrote {a.dst}: background {100 * (alpha == 0).mean():.1f}%")


if __name__ == "__main__":
    main()
