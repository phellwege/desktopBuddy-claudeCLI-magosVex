"""Gradio mask-correction tool for the sprite pipeline. Seeds every counted band from
the masks the SAM pipeline already produces (segment_sam.segment_band +
resolve_ownership at 1x), then lets the user fix a frame by hand: add positive/negative
SAM point prompts, re-segment just that frame, accept it, and save. tools/slice.py's
"annotated" split rebuilds the atlas from the saved masks exactly - see
tools/annotations_io.py for the shared on-disk format.

    tools/.venv-sam/Scripts/python.exe tools/annotate.py raw/sheet.png --pack mechanicus

Needs the SAM venv (torch/transformers/gradio) - see tools/setup-sam.ps1 and
tools/requirements-sam.txt.
"""
import argparse
import json
import os
import sys

import gradio as gr
import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(__file__))
from key import key_background_bands, band_rects
import annotations_io
import segment_sam

HOST = "127.0.0.1"
PORT = 7861
UPSCALE = 3
MARGIN = segment_sam.MARGIN_1X  # 40px - same margin used for the viewer crop and re-segment
VIEW_MARGIN = 28  # px around the selected frame in the viewer crop; neighbors only show at the edges
BOX_GROW = 24  # px of room around each positive point when growing the prompt box

COLORS = [(255, 80, 80), (80, 200, 255), (120, 255, 120), (255, 220, 80),
          (200, 120, 255), (255, 150, 60), (100, 255, 220), (255, 100, 200)]
OUTLINE_COLOR = (255, 255, 255)
POSITIVE_COLOR = (40, 220, 40)
NEGATIVE_COLOR = (230, 30, 30)


class App:
    """All mutable state for one annotation session, held module-side since this is a
    single-user local tool (see main()) - no need for gradio's per-session gr.State
    machinery just to shuttle large numpy arrays around."""

    def __init__(self, sheet_arg: str, pack: str, rows_path: str, annotations_dir: str,
                 device: str, sam_model: str):
        self.sheet_arg = sheet_arg
        self.pack = pack
        self.device = device
        self.sam_model = sam_model
        self.rows = json.load(open(rows_path))
        self.rgb = np.array(Image.open(sheet_arg).convert("RGB"))
        tolerance = self.rows.get("keyTolerance", 16)
        self.alpha = key_background_bands(self.rgb, band_rects(self.rows["bands"], 1.0), tolerance, margin=MARGIN)

        # "each" bands (props) are not annotated - only counted bands get seeded/edited.
        self.bands = [b for b in self.rows["bands"] if not b.get("each")]
        self.frame_band: dict[str, dict] = {}
        self.frame_index: dict[str, int] = {}
        self.frame_names: list[str] = []
        for band in self.bands:
            for i in range(band["count"]):
                name = f"{band['name']}_{i}"
                self.frame_band[name] = band
                self.frame_index[name] = i
                self.frame_names.append(name)

        self.json_path, self.masks_path = annotations_io.paths_for_pack(annotations_dir, pack)
        self._model = None
        self._processor = None

        if annotations_io.exists(self.json_path, self.masks_path):
            self.data, self.labels = annotations_io.load_annotations(self.json_path, self.masks_path)
        else:
            self.data, self.labels = self._seed()
            annotations_io.save_annotations(self.json_path, self.data, self.labels, self.masks_path)

    # -- SAM -------------------------------------------------------------------------

    def model(self):
        if self._model is None:
            self._model, self._processor = segment_sam.load_model(self.sam_model, self.device)
        return self._model, self._processor

    def _seed(self) -> tuple[dict, np.ndarray]:
        """Run the existing SAM path (segment_band + resolve_ownership) at 1x for every
        counted band and store the resulting per-frame masks, positive points, and
        boxes - one SAM object per <band>_<index> frame, in the band's own frame order."""
        h, w = self.alpha.shape
        data = annotations_io.new_annotations(self.sheet_arg, (w, h))
        labels = np.zeros((h, w), dtype=np.int32)
        model, processor = self.model()
        label = 1
        for band in self.bands:
            result = segment_sam.segment_band(self.rgb, self.alpha, band, 1.0, model, processor,
                                               other_bands=self.bands)
            owner = segment_sam.resolve_ownership(result["masks"], result["logits"])
            for i in range(band["count"]):
                mask = owner == (i + 1)
                name = f"{band['name']}_{i}"
                labels[mask] = label
                px, py = result["points"][i]
                data["frames"][name] = {
                    "box": [float(v) for v in result["boxes"][i]],
                    "points": [[float(px), float(py), 1]],
                    "approved": False,
                    "label": label,
                }
                label += 1
        return data, labels

    # -- mask storage ------------------------------------------------------------------

    def frame_mask(self, name: str) -> np.ndarray:
        return annotations_io.frame_mask(self.labels, self.data["frames"][name]["label"])

    def set_frame_mask(self, name: str, mask: np.ndarray) -> None:
        label = self.data["frames"][name]["label"]
        self.labels[self.labels == label] = 0
        self.labels[mask] = label

    def approved_count(self) -> int:
        return sum(1 for f in self.data["frames"].values() if f.get("approved"))

    # -- geometry ------------------------------------------------------------------

    def band_crop_rect(self, band: dict) -> tuple[int, int, int, int]:
        """Band rect plus MARGIN px, clamped to the sheet - the same rectangle used for
        both the viewer crop and the SAM re-segment crop."""
        h, w = self.alpha.shape
        x0, x1 = band["x"]
        y0, y1 = band["y"]
        return (max(0, int(x0) - MARGIN), max(0, int(y0) - MARGIN),
                min(w, int(x1) + MARGIN), min(h, int(y1) + MARGIN))

    def view_rect(self, name: str) -> tuple[int, int, int, int]:
        """The viewer's crop for one frame: its current mask's bounding box (or its prompt
        box if the mask is empty) plus VIEW_MARGIN px, clamped to the sheet. Tight enough
        that the selected frame fills the view and neighbors only appear at the edges."""
        h, w = self.alpha.shape
        mask = self.frame_mask(name)
        ys, xs = np.where(mask)
        if ys.size:
            x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
        else:
            x0, y0, x1, y1 = (int(round(v)) for v in self.data["frames"][name]["box"])
        return (max(0, x0 - VIEW_MARGIN), max(0, y0 - VIEW_MARGIN),
                min(w, x1 + VIEW_MARGIN), min(h, y1 + VIEW_MARGIN))

    # -- SAM re-segment ----------------------------------------------------------------

    def prompt_box(self, name: str) -> list[float]:
        """The stored box grown to cover every positive point with BOX_GROW px of room,
        so SAM is never told to stay inside a box the user has clicked outside of."""
        meta = self.data["frames"][name]
        bx0, by0, bx1, by1 = meta["box"]
        for px, py, lbl in meta["points"]:
            if lbl == 1:
                bx0, by0 = min(bx0, px - BOX_GROW), min(by0, py - BOX_GROW)
                bx1, by1 = max(bx1, px + BOX_GROW), max(by1, py + BOX_GROW)
        return [float(bx0), float(by0), float(bx1), float(by1)]

    def resegment(self, name: str, use_box: bool = True) -> None:
        import torch
        band = self.frame_band[name]
        model, processor = self.model()
        meta = self.data["frames"][name]
        bx0, by0, bx1, by1 = self.prompt_box(name)
        # The SAM crop is the band crop grown to cover the prompt box and every point,
        # plus MARGIN, so a figure hugging a panel edge (or a click past it) is never
        # cut off by the crop itself.
        h, w = self.alpha.shape
        cx0, cy0, cx1, cy1 = self.band_crop_rect(band)
        ex0, ey0, ex1, ey1 = bx0, by0, bx1, by1
        for px, py, _ in meta["points"]:
            ex0, ey0, ex1, ey1 = min(ex0, px), min(ey0, py), max(ex1, px), max(ey1, py)
        cx0, cy0 = min(cx0, max(0, int(ex0) - MARGIN)), min(cy0, max(0, int(ey0) - MARGIN))
        cx1, cy1 = max(cx1, min(w, int(ex1) + MARGIN)), max(cy1, min(h, int(ey1) + MARGIN))
        crop_rgb = self.rgb[cy0:cy1, cx0:cx1]
        crop_h, crop_w = crop_rgb.shape[:2]
        local_box = [max(0.0, bx0 - cx0), max(0.0, by0 - cy0),
                     min(float(crop_w), bx1 - cx0), min(float(crop_h), by1 - cy0)]
        pts = [[p[0] - cx0, p[1] - cy0] for p in meta["points"]]
        lbls = [int(p[2]) for p in meta["points"]]
        if not pts:
            # No points left (the user cleared them and didn't add new ones) - fall
            # back to the box's own center as a single positive point so the model
            # always gets at least one prompt.
            pts = [[(local_box[0] + local_box[2]) / 2.0, (local_box[1] + local_box[3]) / 2.0]]
            lbls = [1]

        image = Image.fromarray(crop_rgb)
        prompt_kwargs = {"input_boxes": [[local_box]]} if use_box else {}
        inputs = processor(image, input_points=[[pts]], input_labels=[[lbls]],
                            return_tensors="pt", **prompt_kwargs).to(self.device)
        with torch.no_grad():
            outputs = model(**inputs, multimask_output=False)
        resized = processor.post_process_masks(
            outputs.pred_masks.cpu(), inputs["original_sizes"].cpu(), binarize=False)[0]
        crop_logits = resized.reshape(resized.shape[-2], resized.shape[-1]).numpy()
        crop_mask = crop_logits > 0.0

        full_mask = np.zeros(self.alpha.shape, dtype=bool)
        full_mask[cy0:cy1, cx0:cx1] = crop_mask & (self.alpha[cy0:cy1, cx0:cx1] > 0)
        self.set_frame_mask(name, full_mask)
        meta["approved"] = False

    def reset_to_auto(self, name: str) -> None:
        """Re-run the original SAM auto seed for this frame's whole band and pull just
        this frame's box/point/mask back out, discarding any manual edits to it -
        sibling frames in the band keep whatever masks they currently have."""
        band = self.frame_band[name]
        i = self.frame_index[name]
        model, processor = self.model()
        result = segment_sam.segment_band(self.rgb, self.alpha, band, 1.0, model, processor,
                                           other_bands=self.bands)
        owner = segment_sam.resolve_ownership(result["masks"], result["logits"])
        mask = owner == (i + 1)
        self.set_frame_mask(name, mask)
        px, py = result["points"][i]
        meta = self.data["frames"][name]
        meta["box"] = [float(v) for v in result["boxes"][i]]
        meta["points"] = [[float(px), float(py), 1]]
        meta["approved"] = False


APP: App | None = None


# -- rendering -----------------------------------------------------------------------

def _tint(crop: np.ndarray, mask: np.ndarray, color: tuple[int, int, int], amount: float = 0.45) -> None:
    if not mask.any():
        return
    c = np.array(color, dtype=np.float32)
    crop[mask] = (crop[mask].astype(np.float32) * (1 - amount) + c * amount).astype(np.uint8)


def render_band_crop(app: App, name: str) -> np.ndarray:
    band = app.frame_band[name]
    cx0, cy0, cx1, cy1 = app.view_rect(name)
    crop = app.rgb[cy0:cy1, cx0:cx1].copy()
    for i in range(band["count"]):
        fname = f"{band['name']}_{i}"
        mask = app.frame_mask(fname)[cy0:cy1, cx0:cx1]
        _tint(crop, mask, COLORS[i % len(COLORS)])
    sel_mask = app.frame_mask(name)[cy0:cy1, cx0:cx1]
    if sel_mask.any():
        eroded = ndimage.binary_erosion(sel_mask, border_value=0)
        crop[sel_mask & ~eroded] = OUTLINE_COLOR

    im = Image.fromarray(crop).resize((crop.shape[1] * UPSCALE, crop.shape[0] * UPSCALE), Image.NEAREST)
    out = np.array(im)
    r = max(2, UPSCALE)
    for px, py, lbl in app.data["frames"][name]["points"]:
        dx = int(round((px - cx0) * UPSCALE))
        dy = int(round((py - cy0) * UPSCALE))
        color = POSITIVE_COLOR if lbl == 1 else NEGATIVE_COLOR
        x0, x1 = max(0, dx - r), min(out.shape[1], dx + r + 1)
        y0, y1 = max(0, dy - r), min(out.shape[0], dy + r + 1)
        out[y0:y1, x0:x1] = color
    return out


def render_full_sheet(app: App, max_width: int = 1000) -> np.ndarray:
    vis = app.rgb.copy()
    for name, meta in app.data["frames"].items():
        mask = app.labels == meta["label"]
        _tint(vis, mask, COLORS[meta["label"] % len(COLORS)], amount=0.4)
    im = Image.fromarray(vis)
    if im.width > max_width:
        scale = max_width / im.width
        im = im.resize((max_width, max(1, int(round(im.height * scale)))), Image.NEAREST)
    return np.array(im)


def points_table(app: App, name: str) -> list[list]:
    return [[round(x, 1), round(y, 1), "positive" if lbl == 1 else "negative"]
            for x, y, lbl in app.data["frames"][name]["points"]]


def approved_text(app: App, name: str) -> str:
    approved = app.data["frames"][name].get("approved", False)
    return f"**{name}**: {'APPROVED' if approved else 'not approved'}"


def status_text(app: App) -> str:
    return f"{app.approved_count()}/{len(app.frame_names)} frames approved"


# -- gradio callbacks (bound to the module-level APP set up in main()) ---------------

def refresh_frame(name: str):
    app = APP
    return render_band_crop(app, name), points_table(app, name), approved_text(app, name), status_text(app)


def on_prev(name: str) -> str:
    idx = APP.frame_names.index(name)
    return APP.frame_names[(idx - 1) % len(APP.frame_names)]


def on_next(name: str) -> str:
    idx = APP.frame_names.index(name)
    return APP.frame_names[(idx + 1) % len(APP.frame_names)]


def on_image_click(name: str, click_type: str, evt: gr.SelectData):
    app = APP
    cx0, cy0, cx1, cy1 = app.view_rect(name)
    dx, dy = evt.index
    sx = cx0 + dx / UPSCALE
    sy = cy0 + dy / UPSCALE
    label = 1 if click_type == "positive" else 0
    app.data["frames"][name]["points"].append([round(float(sx), 1), round(float(sy), 1), label])
    return render_band_crop(app, name), points_table(app, name)


def on_resegment(name: str, use_box: bool = True):
    app = APP
    app.resegment(name, use_box=bool(use_box))
    return (render_band_crop(app, name), points_table(app, name), approved_text(app, name),
            status_text(app), render_full_sheet(app))


def on_clear_points(name: str):
    app = APP
    app.data["frames"][name]["points"] = []
    return render_band_crop(app, name), points_table(app, name)


def on_reset_auto(name: str):
    app = APP
    app.reset_to_auto(name)
    return (render_band_crop(app, name), points_table(app, name), approved_text(app, name),
            status_text(app), render_full_sheet(app))


def on_accept(name: str):
    app = APP
    app.data["frames"][name]["approved"] = True
    return approved_text(app, name), status_text(app), render_full_sheet(app)


def on_save() -> str:
    app = APP
    # Refresh each frame's stored prompt box from its final mask so later re-segments
    # start from the shape the user approved rather than the pipeline's original cell.
    for name, meta in app.data["frames"].items():
        ys, xs = np.where(app.frame_mask(name))
        if ys.size:
            meta["box"] = [float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)]
    annotations_io.save_annotations(app.json_path, app.data, app.labels, app.masks_path)
    return f"Saved {app.json_path} and {app.masks_path}"


def build_ui(app: App) -> gr.Blocks:
    with gr.Blocks(title=f"Mask annotator - {app.pack}") as demo:
        gr.Markdown(f"# Mask annotator - {app.pack}\n{app.sheet_arg}")
        with gr.Row():
            frame_dd = gr.Dropdown(choices=app.frame_names, value=app.frame_names[0], label="Frame")
            prev_btn = gr.Button("Prev")
            next_btn = gr.Button("Next")
        with gr.Row():
            with gr.Column(scale=3):
                band_image = gr.Image(type="numpy", interactive=False,
                                       label="Band crop - click to add a point")
            with gr.Column(scale=1):
                click_type = gr.Radio(["positive", "negative"], value="positive", label="Click type")
                use_box = gr.Checkbox(value=True, label="Use box prompt (box grows to your positive points; uncheck to segment from points only)")
                points_df = gr.Dataframe(headers=["x", "y", "type"], interactive=False, label="Points")
                approved_md = gr.Markdown()
                status_md = gr.Markdown()
                resegment_btn = gr.Button("Re-segment")
                clear_btn = gr.Button("Clear points")
                reset_btn = gr.Button("Reset to auto")
                accept_btn = gr.Button("Accept")
                save_btn = gr.Button("Save", variant="primary")
                save_status = gr.Markdown()
        gr.Markdown("### Full sheet overview")
        sheet_image = gr.Image(type="numpy", interactive=False, label="Full sheet (all masks)")

        frame_dd.change(refresh_frame, inputs=frame_dd,
                         outputs=[band_image, points_df, approved_md, status_md])
        prev_btn.click(on_prev, inputs=frame_dd, outputs=frame_dd)
        next_btn.click(on_next, inputs=frame_dd, outputs=frame_dd)
        band_image.select(on_image_click, inputs=[frame_dd, click_type], outputs=[band_image, points_df])
        resegment_btn.click(on_resegment, inputs=[frame_dd, use_box],
                             outputs=[band_image, points_df, approved_md, status_md, sheet_image])
        clear_btn.click(on_clear_points, inputs=frame_dd, outputs=[band_image, points_df])
        reset_btn.click(on_reset_auto, inputs=frame_dd,
                         outputs=[band_image, points_df, approved_md, status_md, sheet_image])
        accept_btn.click(on_accept, inputs=frame_dd, outputs=[approved_md, status_md, sheet_image])
        save_btn.click(on_save, outputs=save_status)

        demo.load(refresh_frame, inputs=frame_dd,
                  outputs=[band_image, points_df, approved_md, status_md])
        demo.load(lambda: render_full_sheet(app), outputs=sheet_image)
    return demo


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("sheet")
    p.add_argument("--pack", required=True)
    p.add_argument("--rows", default=os.path.join(os.path.dirname(__file__), "rows.json"))
    p.add_argument("--annotations-dir", default=os.path.join(os.path.dirname(__file__), "annotations"))
    p.add_argument("--sam-model", default=segment_sam.DEFAULT_MODEL)
    p.add_argument("--device", default="cuda")
    p.add_argument("--no-browser", action="store_true",
                    help="do not auto-open a browser tab (debugging/smoke checks only)")
    a = p.parse_args()

    global APP
    APP = App(a.sheet, a.pack, a.rows, a.annotations_dir, a.device, a.sam_model)
    demo = build_ui(APP)
    demo.launch(server_name=HOST, server_port=PORT, inbrowser=not a.no_browser)


if __name__ == "__main__":
    main()
