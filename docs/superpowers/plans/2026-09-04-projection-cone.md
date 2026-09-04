# Projection Cone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hologram panel is visibly projected from the character's servo skull: a canvas cone of jittered light lines from the skull to the panel, ported from the user's portfolio `ProjectionOverlay.js`, with the skull's position known per frame.

**Architecture:** The pipeline records a per-frame projection origin in `atlas.json` (auto-detected as the highest bone-colored blob, overridable by a click in the annotator). The overlay renderer reports the origin's screen position while the panel is open; main converts it to hologram-window coordinates. The hologram window grows to reach down to the skull, stays click-through outside the panel, and draws the cone on a canvas behind the panel in the pack's accent color.

**Tech Stack:** Python 3.12 (numpy, scipy, Pillow) for the pipeline; Electron + TypeScript, vitest, Playwright for the app.

## Global Constraints

- Application code never names the Mechanicus; the pack supplies colors and art.
- Renderers have no Node access; new IPC goes through `src/shared/ipc.ts`'s `CH` table and the preload bridge, and every `on*` bridge method returns an unsubscribe function.
- The overlay stays click-through except over the character; the hologram must be click-through except over `#panel`.
- Atlas frames keep `x, y, w, h, ax, ay`; the new field is `origin: [ox, oy]`, crop-local pixels at the atlas scale, optional.
- Sprite pipeline recipe stays: `python tools/upscale.py raw/sheet.png build/raw@2x.png`, then `python tools/slice.py build/raw@2x.png build/pack --key --split annotated --scale 2 --annotations tools/annotations/mechanicus.json`, copy `atlas.png` and `atlas.json` into `packs/mechanicus/`, then `python tools/render_frames.py packs/mechanicus build/frames.png`.
- No em dashes in code, comments, or docs. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Test commands: `python -m pytest tools/test_pipeline.py -q`, `npx vitest run`, `npm run typecheck`, `npm run build`, `npm run test:e2e`.

---

## File Structure

| File | Responsibility |
|---|---|
| `tools/origin.py` (new) | `detect_origin(crop_rgba) -> (ox, oy) or None`: highest bone-colored blob in a frame crop |
| `tools/slice.py` | after `normalize`, attach an origin to each frame (detected, or overridden from annotations, mirrored for flipped copies); `pack_atlas` writes `origin` |
| `tools/annotations_io.py` | frames may carry `origin: [x, y]` (1x sheet coordinates) |
| `tools/annotate.py` | third click type `origin` sets the frame's origin; drawn as a cyan dot |
| `tools/render_frames.py` | draws the origin as a cyan dot when present |
| `src/shared/types.ts` | `AtlasFrame.origin?: [number, number]` |
| `src/main/pack.ts` | zod: optional `origin` tuple on frames |
| `src/renderer/overlay/origin.ts` (new) | pure `originScreenPosition(...)` |
| `src/renderer/overlay/main.ts` | reports the origin's screen position while the panel is open |
| `src/shared/ipc.ts`, `src/preload/index.ts`, `src/preload/bridge.ts` | channels `overlay:origin`, `hologram:origin`, `hologram:hover` and bridge methods |
| `src/main/geometry.ts` | `hologramBounds` reaches down to the skull region; `originToWindow` |
| `src/main/windows.ts` | hologram window created ignoring mouse with forwarding; `setHologramInteractive` |
| `src/main/ipc.ts`, `src/main/index.ts` | forward origin to the hologram, hover toggling, re-send on placement |
| `src/renderer/hologram/cone.ts` (new) | `ProjectionCone` class, the canvas port |
| `src/renderer/hologram/main.ts`, `index.html`, `styles.css` | canvas behind the panel, hover reporting, theme color |

---

### Task 1: Projection origin in the pipeline, the annotator, and the pack loader

**Files:**
- Create: `tools/origin.py`
- Modify: `tools/slice.py` (`build()` frame loop, `pack_atlas`), `tools/annotations_io.py`, `tools/annotate.py`, `tools/render_frames.py`, `src/shared/types.ts`, `src/main/pack.ts`
- Test: `tools/test_pipeline.py`, `src/main/pack.test.ts`

**Interfaces:**
- Produces: `detect_origin(crop_rgba: np.ndarray, min_area: int = 30) -> tuple[int, int] | None` (crop-local pixel centroid of the chosen blob). `pack_atlas(frames: list[tuple[str, np.ndarray, int, int, tuple[int, int] | None]], ...)` writes `"origin": [ox, oy]` only when present. Annotations JSON frames may carry `"origin": [x, y]` in 1x sheet coordinates. `AtlasFrame.origin?: [number, number]` in TypeScript.

- [ ] **Step 1: Write the failing pipeline tests** (append to `tools/test_pipeline.py`)

```python
from origin import detect_origin, BONE_MIN, BONE_SPREAD


def _bone_blob(a, y0, x0, h, w):
    a[y0:y0 + h, x0:x0 + w, :3] = (225, 215, 200)
    a[y0:y0 + h, x0:x0 + w, 3] = 255


def test_detect_origin_picks_the_highest_bone_blob():
    a = np.zeros((120, 100, 4), dtype=np.uint8)
    a[40:110, 30:70, :3] = (180, 30, 30); a[40:110, 30:70, 3] = 255     # red body
    _bone_blob(a, 10, 10, 14, 14)                                        # servo skull, high left
    _bone_blob(a, 34, 72, 10, 10)                                        # staff finial, lower right
    ox, oy = detect_origin(a)
    assert 10 <= ox <= 24 and 10 <= oy <= 24


def test_detect_origin_ignores_tiny_and_transparent_blobs():
    a = np.zeros((60, 60, 4), dtype=np.uint8)
    _bone_blob(a, 5, 5, 3, 3)                                            # 9 px, below min_area
    a[30:50, 20:40, :3] = (225, 215, 200)                                # bone colored but alpha 0
    assert detect_origin(a) is None


def test_pack_atlas_writes_origin_only_when_present():
    crop = np.zeros((10, 10, 4), dtype=np.uint8); crop[..., 3] = 255
    _img, meta = pack_atlas([("a", crop, 5, 10, (2, 3)), ("b", crop, 5, 10, None)], max_width=64)
    assert meta["frames"]["a"]["origin"] == [2, 3]
    assert "origin" not in meta["frames"]["b"]


def test_build_mirrors_origin_on_flipped_frames_and_applies_overrides(tmp_path):
    from PIL import Image
    a = synthetic_sheet()
    rgba = np.dstack([np.full_like(a, 200)] * 3 + [a])
    rgba[10:16, 20:26, :3] = (225, 215, 200)          # a bone blob on body 0 (its top left)
    sheet = tmp_path / "sheet.png"; Image.fromarray(rgba).save(sheet)
    rows = tmp_path / "rows.json"
    rows.write_text(json.dumps({"bands": [{"name": "walk", "x": [0, 120], "y": [0, 120], "count": 2,
                                           "facing": "left", "split": "components"}]}))
    ov = tmp_path / "ov.json"; ov.write_text("{}")
    out = tmp_path / "out"
    build(str(sheet), str(rows), str(ov), str(out), 1.0)
    atlas = json.loads((out / "atlas.json").read_text())
    l, r = atlas["frames"]["walk_left_0"], atlas["frames"]["walk_right_0"]
    assert "origin" in l and r["origin"][0] == l["w"] - 1 - l["origin"][0] and r["origin"][1] == l["origin"][1]
    # override: annotations JSON with an origin at sheet (60, 12) for walk_left_1
    ann = tmp_path / "ann.json"
    ann.write_text(json.dumps({"frames": {"walk_1": {"origin": [60, 12]}}}))
    build(str(sheet), str(rows), str(ov), str(out), 1.0, origins_path=str(ann))
    atlas = json.loads((out / "atlas.json").read_text())
    f = atlas["frames"]["walk_left_1"]
    assert f["origin"] == [60 - f_box_x0(atlas, "walk_left_1"), 12 - f_box_y0(atlas, "walk_left_1")] or True
```

Replace the last assertion's `or True` with a real check: `build()` must also write `build/pack/boxes.json` mapping frame name to its sheet-space crop box `[x0, y0, x1, y1]`, and the test reads it:

```python
    boxes = json.loads((out / "boxes.json").read_text())
    x0, y0 = boxes["walk_left_1"][0], boxes["walk_left_1"][1]
    assert f["origin"] == [60 - x0, 12 - y0]
```

Run: `python -m pytest tools/test_pipeline.py -q -k origin`
Expected: FAIL (ImportError for `origin`, then assertion failures).

- [ ] **Step 2: Write `tools/origin.py`**

```python
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
```

- [ ] **Step 3: Thread origins through `tools/slice.py`**

In `build()`: add parameter `origins_path: str | None = None`. When given, load it and build `overrides = {name: (x, y)}` from `frames[name]["origin"]` for entries that have one; names are annotation frame names (`walk_1`), which map to `walk_1` for non-facing bands and to both `walk_left_1` and `walk_right_1` for facing bands (the right copy mirrored). After `normalize` produces `(crop, ax, ay)` for a frame with sheet box `box`:

```python
    ov_origin = overrides.get(ann_name)
    if ov_origin is not None:
        ox = int(round(ov_origin[0] * scale)) - box.x0
        oy = int(round(ov_origin[1] * scale)) - box.y0
        origin = (ox, oy) if 0 <= ox < crop.shape[1] and 0 <= oy < crop.shape[0] else None
    else:
        origin = detect_origin(crop, min_area=max(30, int(round(30 * scale * scale))))
```

Flipped copies get `(crop.shape[1] - 1 - ox, oy)`. Every `all_frames.append((name, crop, ax, ay))` becomes `all_frames.append((name, crop, ax, ay, origin))`, and `pack_atlas` unpacks five-tuples and writes `"origin": [ox, oy]` when not None. `build()` also writes `boxes.json` next to `atlas.json`: `{name: [box.x0, box.y0, box.x1, box.y1]}` in sheet coordinates at the build scale. CLI: `--annotations` already exists for the annotated split; reuse the same path for origins (`origins_path=a.annotations`).

Run: `python -m pytest tools/test_pipeline.py -q`
Expected: all pass, including the four new tests.

- [ ] **Step 4: Annotator and render support**

`tools/annotations_io.py`: no schema enforcement exists; document `origin` in the module docstring and make `new_annotations` frames default to no origin. `tools/annotate.py`: the click-type radio gains `"origin"`; a click of that type sets `data["frames"][name]["origin"] = [x, y]` (sheet coordinates) instead of appending a point; `render_band_crop` draws the origin as a 3 px cyan (40, 220, 255) square; `points_table` unchanged. `tools/render_frames.py`: when a frame has `origin`, draw a cyan dot at `(x + ox // downscale, y + oy // downscale)`.

- [ ] **Step 5: TypeScript types and loader**

`src/shared/types.ts`: `export interface AtlasFrame { x: number; y: number; w: number; h: number; ax: number; ay: number; origin?: [number, number] }`. `src/main/pack.ts` `FrameSchema` gains `origin: z.tuple([z.number(), z.number()]).optional()`. Test in `src/main/pack.test.ts`: a fixture atlas with one frame carrying `origin: [3, 4]` loads and exposes it; a frame without it loads with `origin` undefined.

Run: `npx vitest run src/main/pack.test.ts`, `npm run typecheck`
Expected: pass.

- [ ] **Step 6: Rebuild the pack and check the origins**

Run the recipe from Global Constraints (the annotated build), copy the atlas files into `packs/mechanicus/`, run `python tools/render_frames.py packs/mechanicus build/frames_anim.png --anim` and confirm the cyan dot sits on the servo skull for the animation frames. Print the list of animation frames whose origin is missing or whose dot is not on the skull; for any wrong ones, do not hand-tune: leave them to the user's annotator override and list them in the report.

- [ ] **Step 7: Commit**

```bash
git add tools packs/mechanicus/atlas.png packs/mechanicus/atlas.json src/shared/types.ts src/main/pack.ts src/main/pack.test.ts
git commit -m "feat: per-frame projection origin (servo skull) in the pipeline, annotator, and pack loader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Origin reporting, the taller click-through hologram, and the cone

**Files:**
- Create: `src/renderer/overlay/origin.ts`, `src/renderer/overlay/origin.test.ts`, `src/renderer/hologram/cone.ts`, `src/renderer/hologram/cone.test.ts`
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/geometry.ts`, `src/main/geometry.test.ts`, `src/main/windows.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/renderer/overlay/main.ts`, `src/renderer/hologram/main.ts`, `src/renderer/hologram/index.html`, `src/renderer/hologram/styles.css`, `e2e/body.spec.ts`

**Interfaces:**
- Consumes: `AtlasFrame.origin` from Task 1; `hologramBounds(wa, xFraction, charW, charH)` and `HOLOGRAM_SIZE` from `src/main/geometry.ts`; `setOverlayInteractive` pattern from `src/main/windows.ts`.
- Produces: channels `overlay:origin` (`OriginPayload { x: number; y: number }`, screen coordinates), `hologram:origin` (`OriginPayload`, hologram-window content coordinates), `hologram:hover` (`{ over: boolean }`); bridge methods `origin(x, y): void`, `onOrigin(cb): () => void`, `hologramHover(over: boolean): void`; `originToWindow(origin, bounds)`; `PANEL_SIZE = { width: 480, height: 360 }` replacing `HOLOGRAM_SIZE`; `ProjectionCone`.

- [ ] **Step 1: Failing geometry tests** (`src/main/geometry.test.ts`, add)

```ts
import { hologramBounds, originToWindow, PANEL_SIZE } from './geometry'

const wa = { x: 0, y: 0, width: 1920, height: 1032 }

it('hologram window reaches from above the panel down into the skull region', () => {
  const charW = 352, charH = 326
  const b = hologramBounds(wa, 0.5, charW, charH)
  const charTop = wa.y + wa.height - charH
  expect(b.y).toBeLessThanOrEqual(charTop - PANEL_SIZE.height - 16)
  expect(b.y + b.height).toBeGreaterThanOrEqual(charTop + charH * 0.75)
  expect(b.width).toBeGreaterThanOrEqual(PANEL_SIZE.width + 2 * 120)
  expect(b.x).toBeGreaterThanOrEqual(wa.x)
  expect(b.x + b.width).toBeLessThanOrEqual(wa.x + wa.width)
})

it('hologram window contains any origin within the character box', () => {
  const charW = 352, charH = 326
  for (const xf of [0, 0.5, 1]) {
    const b = hologramBounds(wa, xf, charW, charH)
    const cx = wa.x + xf * (wa.width - charW) + charW / 2
    const charTop = wa.y + wa.height - charH
    for (const [dx, dy] of [[-charW / 2, charH * 0.1], [charW / 2, charH * 0.6]]) {
      const p = originToWindow({ x: cx + dx, y: charTop + dy }, b)
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(b.width)
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(b.height)
    }
  }
})

it('originToWindow subtracts the window position', () => {
  expect(originToWindow({ x: 500, y: 700 }, { x: 400, y: 600, width: 10, height: 10 })).toEqual({ x: 100, y: 100 })
})
```

Run: `npx vitest run src/main/geometry.test.ts`
Expected: FAIL (`originToWindow`, `PANEL_SIZE` missing).

- [ ] **Step 2: Geometry**

```ts
export const PANEL_SIZE = { width: 480, height: 360 }
export const CONE_SIDE_MARGIN = 120     // room either side of the panel for the cone
export const PANEL_GAP = 16             // gap between the panel bottom and the character's top
export const SKULL_REACH = 0.75         // window bottom reaches this far down the character

export function hologramBounds(wa: Rect, xFraction: number, charW: number, charH: number): Rect {
  const width = PANEL_SIZE.width + 2 * CONE_SIDE_MARGIN
  const cx = wa.x + xFraction * Math.max(0, wa.width - charW) + charW / 2
  const bias = cx < wa.x + wa.width / 2 ? 1 : -1
  let x = Math.round(cx - width / 2 + bias * PANEL_SIZE.width * 0.25)
  x = Math.max(wa.x, Math.min(wa.x + wa.width - width, x))
  const charTop = wa.y + wa.height - charH
  const y = Math.max(wa.y, charTop - PANEL_SIZE.height - PANEL_GAP)
  const bottom = Math.min(wa.y + wa.height, charTop + charH * SKULL_REACH)
  return { x, y, width, height: Math.max(PANEL_SIZE.height, Math.round(bottom - y)) }
}

export function originToWindow(origin: { x: number; y: number }, b: Rect): { x: number; y: number } {
  return { x: origin.x - b.x, y: origin.y - b.y }
}
```

Keep `HOLOGRAM_SIZE` as a deprecated alias of the full window size only if something still imports it; otherwise remove it and fix imports (`windows.ts`, `e2e`). The panel element is `PANEL_SIZE` wide, horizontally centered in the window, at the top.

Run: `npx vitest run src/main/geometry.test.ts`
Expected: PASS.

- [ ] **Step 3: IPC contract and bridge**

`src/shared/ipc.ts`: add `overlayOrigin: 'overlay:origin'`, `hologramOrigin: 'hologram:origin'`, `hologramHover: 'hologram:hover'` to `CH`; `export interface OriginPayload { x: number; y: number }`; `BuddyBridge` gains `origin(x: number, y: number): void`, `onOrigin(cb: (p: OriginPayload) => void): () => void`, `hologramHover(over: boolean): void`. `src/preload/index.ts`: wire the three (`origin` sends `{ x, y }`; `hologramHover` sends `{ over }`; `onOrigin` uses `on(CH.hologramOrigin)`).

- [ ] **Step 4: Failing overlay origin test** (`src/renderer/overlay/origin.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { originScreenPosition } from './origin'

const f = { x: 0, y: 0, w: 100, h: 200, ax: 50, ay: 200, origin: [20, 30] as [number, number] }
const canvas = { width: 200, height: 260 }

describe('originScreenPosition', () => {
  it('maps a crop-local origin through the draw transform', () => {
    // dx = 200/2 - 50 = 50, dy = (260-4) - 200 = 56 at scale 1
    const p = originScreenPosition(f, false, 1, canvas, { left: 10, top: 20 }, { x: 1000, y: 2000 })
    expect(p).toEqual({ x: 1000 + 10 + 50 + 20, y: 2000 + 20 + 56 + 30 })
  })
  it('mirrors horizontally when the frame is flipped', () => {
    const p = originScreenPosition(f, true, 1, canvas, { left: 0, top: 0 }, { x: 0, y: 0 })
    expect(p).toEqual({ x: 200 - (50 + 20), y: 56 + 30 })
  })
  it('returns null without an origin', () => {
    expect(originScreenPosition({ ...f, origin: undefined }, false, 1, canvas, { left: 0, top: 0 }, { x: 0, y: 0 })).toBeNull()
  })
})
```

- [ ] **Step 5: `src/renderer/overlay/origin.ts` and reporting**

```ts
import type { AtlasFrame } from '../../shared/types'

export function originScreenPosition(
  f: AtlasFrame, mirror: boolean, scale: number,
  canvas: { width: number; height: number },
  canvasRect: { left: number; top: number },
  windowPos: { x: number; y: number },
): { x: number; y: number } | null {
  if (!f.origin) return null
  const baselineY = canvas.height - 4
  const dx = canvas.width / 2 - f.ax * scale
  const dy = baselineY - f.ay * scale
  const ox = f.origin[0] * scale, oy = f.origin[1] * scale
  const localX = mirror ? canvas.width - (dx + ox) : dx + ox
  const localY = dy + oy
  return { x: Math.round(windowPos.x + canvasRect.left + localX), y: Math.round(windowPos.y + canvasRect.top + localY) }
}
```

In `src/renderer/overlay/main.ts` `draw()`, after `drawn = { f, mirror }`: if `lastState?.state.panelOpen`, compute `originScreenPosition(f, mirror, scale, canvas, canvas.getBoundingClientRect(), { x: window.screenX, y: window.screenY })` and, if it differs from the last reported point by at least 1 px in either axis, call `window.buddy.origin(x, y)`. Reset the last reported point when the panel closes so the first frame after reopening reports.

- [ ] **Step 6: Windows and main wiring**

`src/main/windows.ts`: `createHologramWindow` sets `win.setIgnoreMouseEvents(true, { forward: true })` after creation and exports `setHologramInteractive(win, interactive)` mirroring `setOverlayInteractive` (interactive: `setIgnoreMouseEvents(false)`; not: `setIgnoreMouseEvents(true, { forward: true })`), without a cursor watchdog (the panel closes on blur anyway). `src/main/ipc.ts`: handle `CH.overlayOrigin` by storing the last screen origin and, when the hologram is visible, sending `CH.hologramOrigin` with `originToWindow(origin, hologram.getBounds())`; handle `CH.hologramHover` with `setHologramInteractive`. `src/main/index.ts`: `placeHologram` re-sends the last origin after `setBounds`; when the panel opens, send the last known origin immediately if there is one.

- [ ] **Step 7: Failing cone test** (`src/renderer/hologram/cone.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { hexToRgb, edgePoints } from './cone'

describe('cone helpers', () => {
  it('parses theme hex colors', () => {
    expect(hexToRgb('#37c4ff')).toEqual([55, 196, 255])
    expect(hexToRgb('#fff')).toEqual([255, 255, 255])
    expect(hexToRgb('nonsense')).toEqual([91, 192, 190])
  })
  it('spreads edge points around a rounded rect', () => {
    const pts = edgePoints({ left: 10, top: 10, right: 110, bottom: 60 }, 40, 0, 12)
    expect(pts).toHaveLength(40)
    for (const p of pts) { expect(p.x).toBeGreaterThanOrEqual(9); expect(p.x).toBeLessThanOrEqual(111); expect(p.y).toBeGreaterThanOrEqual(9); expect(p.y).toBeLessThanOrEqual(61) }
  })
})
```

- [ ] **Step 8: `src/renderer/hologram/cone.ts`**

Port of `ProjectionOverlay.js` reduced to one target. Exports `hexToRgb`, `edgePoints` (the `getRoundedPoint` and `getEdgePoints` logic, jitter driven by `t`), and:

```ts
export class ProjectionCone {
  private rgb: [number, number, number] = [91, 192, 190]
  private source = { x: 0, y: 0 }
  private target: { left: number; top: number; right: number; bottom: number } | null = null
  private t = 0
  private raf = 0
  constructor(private canvas: HTMLCanvasElement, private lines = 220) {}
  setColor(hex: string): void { this.rgb = hexToRgb(hex) }
  setSource(x: number, y: number): void { this.source = { x, y } }
  setTarget(rect: DOMRect | null): void { this.target = rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null }
  start(): void { if (!this.raf) this.raf = requestAnimationFrame(this.frame) }
  stop(): void { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.clear() }
  private clear(): void { this.canvas.getContext('2d')!.clearRect(0, 0, this.canvas.width, this.canvas.height) }
  private frame = (): void => { this.draw(); this.raf = requestAnimationFrame(this.frame) }
  private draw(): void { /* the portfolio's draw(), single target: lines from source to edgePoints
     with flicker, distance fade (against the canvas diagonal), scan pulse and the three-stop gradient;
     destination-out fill of the rounded panel rect so lines pass behind it; border glow gradient
     oriented toward the source with shadowBlur; radial source glow. Alpha constants as in the original
     (0.12 line base, 0.7 border base). Color = this.rgb. this.t += 0.008 per frame. */ }
}
```

Write the full `draw()` from the original file `C:\repo\KuonYagiStylePortfolio\portfolio4.0\src\components\ProjectionOverlay.js` (functions `roundedRectPath`, `getRoundedPoint`, `getEdgePoints`, and the `draw` callback's line, mask, border-glow, and source-glow sections), dropping the scroll progress, the DOM target query, the planets, and the occlusion logic.

- [ ] **Step 9: Hologram page**

`index.html`: replace `<div id="cone"></div>` with `<canvas id="cone"></canvas>` as the first child of `#root`. `styles.css`: `#cone { position: fixed; inset: 0; pointer-events: none; z-index: 0 }`, `#panel { position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 480px; height: 360px; z-index: 1 }` (keep the existing panel styling otherwise). `main.ts`: size the canvas to `window.innerWidth/innerHeight` on load and resize; create `new ProjectionCone(canvas)`; `onTheme` calls `cone.setColor(theme.accent)`; `onOrigin` calls `cone.setSource(p.x, p.y)`; on load and resize `cone.setTarget(panel.getBoundingClientRect())`; start the cone when the page is visible and stop on `visibilitychange` hidden; `mousemove` on the window reports `window.buddy.hologramHover(over)` on transitions, where `over` is whether the pointer is inside `#panel`'s rect; `mouseleave` on the document reports false.

- [ ] **Step 10: e2e**

In `e2e/body.spec.ts`, after the click opens the hologram, assert its bounds height is greater than 360 and its width equals `480 + 240`; assert the overlay's atlas has an `origin` on `idle_0` (read `packs/mechanicus/atlas.json` in the test). Keep the rest.

Run: `npx vitest run`, `npm run typecheck`, `npm run build`, `npm run test:e2e`
Expected: all green.

- [ ] **Step 11: Manual check and commit**

Run `npm run dev`, click him, confirm the cone emanates from the skull and follows him when he is told to move (`/goto 20`), and that clicks in the cone area outside the panel fall through to the desktop. Close the app.

```bash
git add src e2e
git commit -m "feat: hologram projection cone cast from the servo skull; hologram window reaches the skull and is click-through outside the panel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- Spec coverage: origin per frame (Task 1), override in the annotator (Task 1 step 4), overlay reporting (Task 2 step 5), taller click-through hologram (Task 2 steps 2 and 6), cone port with theme color (Task 2 steps 8 and 9), tests and e2e (both tasks). Mirrored origins for flipped frames covered in Task 1 step 3 and tested.
- Placeholders: Task 2 step 8 defers the body of `draw()` to the named source file with the sections to keep, which the implementer can read; every other step carries its code.
- Types: `AtlasFrame.origin` is `[number, number]` in types.ts, the zod tuple, and `originScreenPosition`; `OriginPayload` is `{ x, y }` on both channels; `PANEL_SIZE` replaces `HOLOGRAM_SIZE` and Task 2 step 2 says to fix imports.
