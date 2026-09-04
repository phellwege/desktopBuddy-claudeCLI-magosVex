"""Draw band rectangles, frame boxes, and anchors over the keyed sheet for eyeballing rows.json."""
import argparse, json, os, sys
from PIL import Image, ImageDraw
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from slice import group_frames, normalize
from key import key_background_bands, band_rects


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("sheet"); p.add_argument("out")
    p.add_argument("--rows", default=os.path.join(os.path.dirname(__file__), "rows.json"))
    p.add_argument("--overrides", default=os.path.join(os.path.dirname(__file__), "overrides.json"))
    p.add_argument("--scale", type=float, default=1.0)
    p.add_argument("--key", action="store_true", help="sheet is a raw RGB sheet; key it band-by-band before rendering")
    a = p.parse_args()
    rows_data = json.load(open(a.rows))
    if a.key:
        rgb = np.array(Image.open(a.sheet).convert("RGB"))
        tolerance = rows_data.get("keyTolerance", 16)
        alpha_ch = key_background_bands(rgb, band_rects(rows_data["bands"], a.scale), tolerance, margin=int(round(40 * a.scale)))
        im = Image.fromarray(np.dstack([rgb, alpha_ch]))
    else:
        im = Image.open(a.sheet).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 0, 255, 255)); bg.alpha_composite(im)
    draw = ImageDraw.Draw(bg)
    rgba = np.array(im); alpha = rgba[..., 3]
    ov = json.load(open(a.overrides)) if os.path.exists(a.overrides) else {}
    for band in rows_data["bands"]:
        x0, x1 = (v * a.scale for v in band["x"]); y0, y1 = (v * a.scale for v in band["y"])
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(80, 140, 255, 255))
        draw.text((x0 + 3, y0 + 2), band["name"], fill=(80, 140, 255, 255))
        try:
            frames = group_frames(alpha, band, a.scale, ov)
        except ValueError as e:
            draw.text((x0 + 3, y0 + 14), str(e), fill=(255, 60, 60, 255))
            print("!!", e)
            continue
        for i, (box, cx) in enumerate(frames):
            draw.rectangle([box.x0, box.y0, box.x1 - 1, box.y1 - 1], outline=(60, 220, 90, 255))
            _, ax, ay = normalize(rgba, box, cx)
            draw.ellipse([box.x0 + ax - 2, box.y0 + ay - 2, box.x0 + ax + 2, box.y0 + ay + 2], fill=(255, 255, 0, 255))
            draw.text((box.x0 + 2, box.y1 - 12), f"{band['name']}_{i}", fill=(60, 220, 90, 255))
        print(f"{band['name']}: {len(frames)}")
    bg.save(a.out)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
