"""Lay out atlas frames on magenta for eyeballing: one row of eight per line, each frame
with a 1 px green outline, a yellow anchor dot at the feet, and its name above.

    python tools/render_frames.py packs/mechanicus out.png            # every frame, 1x
    python tools/render_frames.py packs/mechanicus out.png --anim     # only frames animations.json uses
    python tools/render_frames.py packs/mechanicus out.png --names run_right_0 sit_2
"""
import argparse
import json
import os

from PIL import Image, ImageDraw

MAGENTA = (255, 0, 255, 255)
GREEN = (0, 255, 0, 255)
YELLOW = (255, 255, 0, 255)
WHITE = (255, 255, 255, 255)
CYAN = (40, 220, 255, 255)


def animation_frame_names(animations: dict) -> list[str]:
    order: list[str] = []
    for spec in animations.values():
        names = spec.get("frames") or (spec.get("right", []) + spec.get("left", []))
        for name in names:
            if name not in order:
                order.append(name)
    return order


def render(pack_dir: str, out: str, names: list[str] | None, downscale: int, cols: int = 8, gap: int = 12) -> tuple[int, int]:
    atlas = json.load(open(os.path.join(pack_dir, "atlas.json")))
    sheet = Image.open(os.path.join(pack_dir, atlas["image"])).convert("RGBA")
    frames = atlas["frames"]
    if names is None:
        names = list(frames)
    crops = []
    for name in names:
        f = frames[name]
        im = sheet.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))
        if downscale > 1:
            im = im.resize((max(1, im.width // downscale), max(1, im.height // downscale)), Image.NEAREST)
        origin = f.get("origin")
        crops.append((name, im, f["ax"] // downscale, f["ay"] // downscale, origin))
    cell_w = max(im.width for _, im, _, _, _ in crops) + gap
    cell_h = max(im.height for _, im, _, _, _ in crops) + gap + 14
    rows = (len(crops) + cols - 1) // cols
    canvas = Image.new("RGBA", (cols * cell_w + gap, rows * cell_h + gap), MAGENTA)
    draw = ImageDraw.Draw(canvas)
    for i, (name, im, ax, ay, origin) in enumerate(crops):
        x = gap + (i % cols) * cell_w
        y = gap + (i // cols) * cell_h + 14
        canvas.alpha_composite(im, (x, y))
        draw.rectangle([x - 1, y - 1, x + im.width, y + im.height], outline=GREEN)
        draw.ellipse([x + ax - 2, y + ay - 2, x + ax + 2, y + ay + 2], fill=YELLOW)
        if origin is not None:
            ox, oy = origin[0] // downscale, origin[1] // downscale
            draw.ellipse([x + ox - 2, y + oy - 2, x + ox + 2, y + oy + 2], fill=CYAN)
        draw.text((x, y - 13), name, fill=WHITE)
    canvas.save(out)
    return canvas.size


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("pack_dir")
    p.add_argument("out")
    p.add_argument("--anim", action="store_true", help="only frames referenced by animations.json")
    p.add_argument("--names", nargs="*", help="explicit frame names")
    p.add_argument("--downscale", type=int, default=2, help="integer downscale for viewing (atlas is 2x)")
    a = p.parse_args()
    names = a.names
    if a.anim and not names:
        names = animation_frame_names(json.load(open(os.path.join(a.pack_dir, "animations.json"))))
    size = render(a.pack_dir, a.out, names, a.downscale)
    print(f"wrote {a.out} {size[0]}x{size[1]}")


if __name__ == "__main__":
    main()
