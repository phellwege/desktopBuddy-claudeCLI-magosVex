"""2x upscale. Uses realesrgan-ncnn-vulkan when available (no PyTorch needed), else Lanczos."""
import argparse, os, shutil, subprocess
from PIL import Image


def find_esrgan(explicit: str | None) -> str | None:
    for cand in [explicit, os.environ.get("REALESRGAN"), shutil.which("realesrgan-ncnn-vulkan")]:
        if cand and os.path.isfile(cand):
            return cand
    return None


def upscale(src: str, dst: str, factor: int = 2, method: str = "auto", exe: str | None = None) -> str:
    found = find_esrgan(exe) if method in ("auto", "esrgan") else None
    if method == "esrgan" and not found:
        raise FileNotFoundError("realesrgan-ncnn-vulkan not found; pass --exe or set REALESRGAN")
    if found:
        subprocess.run([found, "-i", src, "-o", dst, "-n", "realesr-animevideov3", "-s", str(factor)], check=True)
        return "esrgan"
    im = Image.open(src).convert("RGBA")
    resample = Image.NEAREST if method in ("nearest", "auto") else Image.LANCZOS
    im.resize((im.width * factor, im.height * factor), resample).save(dst)
    return "nearest" if method in ("nearest", "auto") else "lanczos"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--factor", type=int, default=2)
    p.add_argument("--method", choices=["auto", "esrgan", "lanczos", "nearest"], default="auto")
    p.add_argument("--exe")
    a = p.parse_args()
    print("method:", upscale(a.src, a.dst, a.factor, a.method, a.exe))


if __name__ == "__main__":
    main()
