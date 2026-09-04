"""Load/save hand-corrected mask annotations for one sprite-sheet pack.

An annotation set is two files: `<pack>.json` (per-frame box, click points, approval
state, and a stable integer label) and `<pack>-masks.png` (a same-size-as-the-sheet
label image at 1x; pixel value = a frame's label, 0 = unlabeled). Labels are assigned
once (by tools/annotate.py's seeding step) and never reused, so re-running the annotator
or the slicer against an existing annotation set is stable across edits.

Pure numpy/json/PIL - no torch, transformers, or gradio - so tools/slice.py's
"annotated" split (and this module's own round-trip tests) work in the regular
tools/.venv, without the SAM venv. tools/annotate.py (SAM venv only) uses this module
too, so the two never disagree about the on-disk format.
"""
import json
import os
import numpy as np
from PIL import Image


def paths_for_pack(annotations_dir: str, pack: str) -> tuple[str, str]:
    """(`<pack>.json`, `<pack>-masks.png`) paths inside `annotations_dir`."""
    return (os.path.join(annotations_dir, f"{pack}.json"),
            os.path.join(annotations_dir, f"{pack}-masks.png"))


def masks_path_for(json_path: str) -> str:
    """The sibling `<pack>-masks.png` path for a `<pack>.json` annotations path."""
    base = json_path[:-len(".json")] if json_path.endswith(".json") else json_path
    return base + "-masks.png"


def exists(json_path: str, masks_path: str | None = None) -> bool:
    """True if both the annotations JSON and its masks PNG are present on disk."""
    masks_path = masks_path or masks_path_for(json_path)
    return os.path.exists(json_path) and os.path.exists(masks_path)


def save_annotations(json_path: str, data: dict, labels: np.ndarray, masks_path: str | None = None) -> None:
    """Write `data` to `json_path` and `labels` (int label image, 0 = none, same H,W as
    the sheet at 1x) to its sibling `-masks.png` - 8-bit if every label fits in a byte,
    else 16-bit. `Image.fromarray` picks the PNG bit depth from the array's own dtype
    (uint8 -> "L", uint16 -> "I;16"), so no deprecated explicit `mode=` is needed."""
    masks_path = masks_path or masks_path_for(json_path)
    out_dir = os.path.dirname(json_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(json_path, "w") as f:
        json.dump(data, f, indent=1)
    max_label = int(labels.max()) if labels.size else 0
    dtype = np.uint8 if max_label <= 255 else np.uint16
    Image.fromarray(labels.astype(dtype)).save(masks_path)


def load_annotations(json_path: str, masks_path: str | None = None) -> tuple[dict, np.ndarray]:
    """(data, labels) - the inverse of `save_annotations`. `labels` comes back int32
    regardless of the PNG's own bit depth."""
    masks_path = masks_path or masks_path_for(json_path)
    with open(json_path) as f:
        data = json.load(f)
    im = Image.open(masks_path)
    if im.mode not in ("L", "I", "I;16"):
        im = im.convert("I")
    labels = np.array(im).astype(np.int32)
    return data, labels


def frame_mask(labels: np.ndarray, label: int) -> np.ndarray:
    """Boolean mask of every pixel carrying exactly `label` in a loaded `labels` array."""
    return labels == label


def new_annotations(sheet: str, sheet_size: tuple[int, int]) -> dict:
    """A fresh, empty annotations dict for `sheet` (path as given on the CLI, stored
    verbatim) sized `sheet_size` (w, h)."""
    return {"sheet": sheet, "sheetSize": [int(sheet_size[0]), int(sheet_size[1])], "frames": {}}


def next_label(data: dict) -> int:
    """The next unused label (1-based) for a fresh frame in `data` - one past the
    highest label already assigned, so labels are stable and never reused even if
    frames are added or removed later."""
    labels = [f.get("label", 0) for f in data.get("frames", {}).values()]
    return (max(labels) + 1) if labels else 1
