"""Remove the soft haze matte: alpha below threshold becomes 0, alpha at or above `full` becomes 255."""
import argparse
import numpy as np
from PIL import Image


def clean_alpha(a: np.ndarray, threshold: int = 100, full: int = 230) -> np.ndarray:
    a = a.astype(np.int32)
    stretched = np.clip((a - threshold) * 255 // (full - threshold), 0, 255)
    return np.where(a < threshold, 0, stretched).astype(np.uint8)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--threshold", type=int, default=100)
    p.add_argument("--full", type=int, default=230)
    args = p.parse_args()
    arr = np.array(Image.open(args.src).convert("RGBA"))
    arr[..., 3] = clean_alpha(arr[..., 3], args.threshold, args.full)
    Image.fromarray(arr).save(args.dst)
    print(f"wrote {args.dst} {arr.shape[1]}x{arr.shape[0]}")


if __name__ == "__main__":
    main()
