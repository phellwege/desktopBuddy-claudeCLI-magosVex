"""2x upscale. Nearest-neighbor by default - lossless and exactly what slice.py's sam/
annotated split modes require of an upscaled sheet (see their own docstrings: they recover
the exact 1x arrays by subsampling every factor-th pixel, which only round-trips losslessly
for a nearest-neighbor enlargement). Pass --method esrgan or --method lanczos explicitly to
get a smoothed upscale instead, e.g. for a final cosmetic export."""
import argparse, os, shutil, subprocess
from PIL import Image


def find_esrgan(explicit: str | None) -> str | None:
    for cand in [explicit, os.environ.get("REALESRGAN"), shutil.which("realesrgan-ncnn-vulkan")]:
        if cand and os.path.isfile(cand):
            return cand
    return None


def upscale(src: str, dst: str, factor: int = 2, method: str = "nearest", exe: str | None = None) -> str:
    found = find_esrgan(exe) if method == "esrgan" else None
    if method == "esrgan" and not found:
        raise FileNotFoundError("realesrgan-ncnn-vulkan not found; pass --exe or set REALESRGAN")
    if found:
        subprocess.run([found, "-i", src, "-o", dst, "-n", "realesr-animevideov3", "-s", str(factor)], check=True)
        return "esrgan"
    im = Image.open(src).convert("RGBA")
    resample = Image.NEAREST if method == "nearest" else Image.LANCZOS
    im.resize((im.width * factor, im.height * factor), resample).save(dst)
    return method


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--factor", type=int, default=2)
    p.add_argument("--method", choices=["esrgan", "lanczos", "nearest"], default="nearest")
    p.add_argument("--exe")
    a = p.parse_args()
    print("method:", upscale(a.src, a.dst, a.factor, a.method, a.exe))


if __name__ == "__main__":
    main()
