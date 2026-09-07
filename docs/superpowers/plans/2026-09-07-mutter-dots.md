# Mutter Dots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The idle thought bubble's two lead-in dots start at his head and run in a straight line to the bubble, whatever the bubble's position.

**Architecture:** A pure geometry module computes the head point from the drawn sprite rect, the trail start on the bubble's near edge, and the two dot centres along the segment between them; `placeMutter` in the overlay renderer positions two real dot elements from that, replacing the CSS pseudo-elements pinned to the bubble.

**Tech Stack:** TypeScript (strict), Electron renderer (overlay window), vitest (node environment), Playwright e2e.

Spec: `docs/superpowers/specs/2026-09-07-mutter-dots-design.md`.

## Global Constraints

- Work in the worktree `C:\repo\mechanicus-buddy-dots` on branch `mutter-dots`. Never touch `C:\repo\mechanicus-buddy` (the running dev instance hot-reloads the overlay from it). Never merge; the controller merges after Peter has looked.
- No em dashes anywhere: code comments, tests, docs, commit messages. Use commas, colons or hyphens.
- Every commit: `git -c commit.gpgsign=false commit -q -F - <<'MSG'` ... `MSG` from the worktree, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Constants: `HEAD_FRACTION = 0.75` (from the sprite's centre toward its top), `DOT_SIZES = [12, 8]`, `DOT_FRACTIONS = [0.35, 0.7]`, start inset = `DOT_SIZES[0] / 2 + 2`.
- Head point: `{ x: drawn.x + drawn.w / 2, y: drawn.y + drawn.h / 2 - HEAD_FRACTION * (drawn.h / 2) }`.
- Bubble timing, text, placement and clamping are unchanged; only the dots move.
- Unit tests: `npx vitest run` (309 at baseline). Typecheck: `npm run typecheck`. E2E: `npm run test:e2e` (22 at baseline; run in Task 3 only).

---

### Task 1: The pure geometry module

**Files:**
- Create: `src/renderer/overlay/thought.ts`
- Test: `src/renderer/overlay/thought.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Rect { x: number; y: number; w: number; h: number }
  export interface Point { x: number; y: number }
  export type Side = 'above' | 'left' | 'right'
  export const HEAD_FRACTION = 0.75
  export const DOT_SIZES: readonly [number, number] = [12, 8]
  export const DOT_FRACTIONS: readonly [number, number] = [0.35, 0.7]
  export const START_INSET = DOT_SIZES[0] / 2 + 2
  export function headPoint(drawn: Rect): Point
  export function trailStart(bubble: Rect, side: Side, head: Point): Point
  export function trailDots(start: Point, head: Point): Array<{ x: number; y: number; size: number }>
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/overlay/thought.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DOT_FRACTIONS, DOT_SIZES, START_INSET, headPoint, trailDots, trailStart } from './thought'

describe('headPoint', () => {
  it('is the horizontal centre, three quarters of the way from the vertical centre to the top', () => {
    // 80 wide, 160 tall at (100, 200): centre y 280, half height 80, 0.75 * 80 = 60 above it
    expect(headPoint({ x: 100, y: 200, w: 80, h: 160 })).toEqual({ x: 140, y: 220 })
  })
  it('works for a canvas-box fallback the same way', () => {
    expect(headPoint({ x: 0, y: 0, w: 96, h: 96 })).toEqual({ x: 48, y: 12 })
  })
})

describe('trailStart', () => {
  const bubble = { x: 100, y: 50, w: 200, h: 60 } // right edge 300, bottom 110
  it('above: bottom edge, under the head when the head is within the edge', () => {
    expect(trailStart(bubble, 'above', { x: 180, y: 300 })).toEqual({ x: 180, y: 110 })
  })
  it('above: clamps to the corners with the inset when the head is off to a side', () => {
    expect(trailStart(bubble, 'above', { x: 20, y: 300 })).toEqual({ x: 100 + START_INSET, y: 110 })
    expect(trailStart(bubble, 'above', { x: 900, y: 300 })).toEqual({ x: 300 - START_INSET, y: 110 })
  })
  it('left: right edge, level with the head, clamped by the inset', () => {
    expect(trailStart(bubble, 'left', { x: 400, y: 80 })).toEqual({ x: 300, y: 80 })
    expect(trailStart(bubble, 'left', { x: 400, y: 5 })).toEqual({ x: 300, y: 50 + START_INSET })
    expect(trailStart(bubble, 'left', { x: 400, y: 500 })).toEqual({ x: 300, y: 110 - START_INSET })
  })
  it('right: left edge, level with the head', () => {
    expect(trailStart(bubble, 'right', { x: 10, y: 80 })).toEqual({ x: 100, y: 80 })
  })
})

describe('trailDots', () => {
  it('places the big dot at 35% and the small dot at 70% of the way from start to head', () => {
    const dots = trailDots({ x: 0, y: 0 }, { x: 100, y: 200 })
    expect(dots).toEqual([
      { x: 100 * DOT_FRACTIONS[0], y: 200 * DOT_FRACTIONS[0], size: DOT_SIZES[0] },
      { x: 100 * DOT_FRACTIONS[1], y: 200 * DOT_FRACTIONS[1], size: DOT_SIZES[1] },
    ])
  })
  it('a bubble clamped to the right of him gives a trail stepping left and down toward the head', () => {
    // bubble far right (edge-clamped), head well to the left and below it
    const bubble = { x: 600, y: 0, w: 200, h: 60 }
    const head = { x: 300, y: 200 }
    const start = trailStart(bubble, 'above', head)
    expect(start).toEqual({ x: 600 + START_INSET, y: 60 })
    const [big, small] = trailDots(start, head)
    expect(big.x).toBeLessThan(start.x)
    expect(small.x).toBeLessThan(big.x)
    expect(big.y).toBeGreaterThan(start.y)
    expect(small.y).toBeGreaterThan(big.y)
    expect(small.x).toBeGreaterThan(head.x)
    expect(small.y).toBeLessThan(head.y)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /c/repo/mechanicus-buddy-dots && npx vitest run src/renderer/overlay/thought.test.ts`
Expected: FAIL, the module `./thought` does not exist.

- [ ] **Step 3: Implement**

Create `src/renderer/overlay/thought.ts`:

```ts
// Geometry for the thought bubble's two lead-in dots. Pure, no DOM: placeMutter in
// main.ts feeds it the drawn sprite rect and the bubble rect it has already placed, and
// positions two real elements from what comes back. The point of it: the dots start at
// his HEAD and run in a straight line to the bubble, so a bubble that has been clamped
// away from him by a window edge gets a diagonal trail that still ends on him, instead of
// two circles hanging off the bubble wherever it happens to sit.
export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export type Side = 'above' | 'left' | 'right'

// From the sprite's vertical centre, this fraction of the half-height toward the top:
// about the middle of a hood on a humanoid frame (Peter's call, 2026-09-07).
export const HEAD_FRACTION = 0.75
// Big dot nearest the bubble, small dot nearest him.
export const DOT_SIZES: readonly [number, number] = [12, 8]
export const DOT_FRACTIONS: readonly [number, number] = [0.35, 0.7]
// Keeps the trail start off the bubble's rounded corners.
export const START_INSET = DOT_SIZES[0] / 2 + 2

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

export function headPoint(drawn: Rect): Point {
  return { x: drawn.x + drawn.w / 2, y: drawn.y + drawn.h / 2 - HEAD_FRACTION * (drawn.h / 2) }
}

// The point on the bubble's near edge closest to the head, inset from the corners.
export function trailStart(bubble: Rect, side: Side, head: Point): Point {
  const right = bubble.x + bubble.w
  const bottom = bubble.y + bubble.h
  if (side === 'above') return { x: clamp(head.x, bubble.x + START_INSET, right - START_INSET), y: bottom }
  const y = clamp(head.y, bubble.y + START_INSET, bottom - START_INSET)
  return { x: side === 'left' ? right : bubble.x, y }
}

// Dot centres along the segment from the trail start to the head.
export function trailDots(start: Point, head: Point): Array<{ x: number; y: number; size: number }> {
  return DOT_FRACTIONS.map((f, i) => ({
    x: start.x + (head.x - start.x) * f,
    y: start.y + (head.y - start.y) * f,
    size: DOT_SIZES[i],
  }))
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd /c/repo/mechanicus-buddy-dots && npx vitest run src/renderer/overlay/thought.test.ts && npm run typecheck`
Expected: 8 tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /c/repo/mechanicus-buddy-dots && git add src/renderer/overlay/thought.ts src/renderer/overlay/thought.test.ts && git -c commit.gpgsign=false commit -q -F - <<'MSG'
overlay: pure geometry for thought-bubble dots anchored at his head

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 2: Wire the dots into the overlay

**Files:**
- Modify: `src/renderer/overlay/index.html` (the `#mutter` styles and the body markup)
- Modify: `src/renderer/overlay/main.ts` (`mutterEl` lookup near line 10; `placeMutter` lines 86-118; `hideMutterAtOnce`, `fadeOutMutter`, `showMutter` lines 123-149)
- Modify: `e2e/mutter.spec.ts`

**Interfaces:**
- Consumes: `headPoint`, `trailStart`, `trailDots`, `Side`, `Rect` from Task 1.

- [ ] **Step 1: Markup and styles**

In `index.html`, replace everything from the `/* An idle thought bubble ... */` comment through the last `#mutter.side-right::after` rule with:

```css
    /* An idle thought bubble and its two lead-in dots. The wrapper carries visibility
       (hidden attribute + the visible class for the fade); its children are positioned
       the same way as #buddy, an absolute offset from the window origin via transform.
       main.ts places the bubble above his head or beside him, then puts the dots on the
       straight line from the bubble's near edge to his head (overlay/thought.ts). */
    #mutter-wrap { position: absolute; left: 0; top: 0; pointer-events: none; opacity: 0; transition: opacity 300ms; }
    #mutter-wrap.visible { opacity: 1; }
    #mutter {
      position: absolute; left: 0; top: 0;
      max-width: 390px;
      padding: 12px 15px;
      border-radius: 18px;
      background: rgba(10, 14, 18, 0.86);
      color: #e8f1f2;
      font: 20px system-ui;
      border: 1px solid rgba(255, 255, 255, 0.18);
    }
    .mutter-dot {
      position: absolute; left: 0; top: 0;
      border-radius: 50%;
      background: rgba(10, 14, 18, 0.86);
      border: 1px solid rgba(255, 255, 255, 0.18);
      box-sizing: border-box;
    }
    #mutter-dot-big { width: 12px; height: 12px; }
    #mutter-dot-small { width: 8px; height: 8px; }
```

and change the body to:

```html
<body><canvas id="buddy"></canvas><div id="mutter-wrap" hidden><div id="mutter"></div><div id="mutter-dot-big" class="mutter-dot"></div><div id="mutter-dot-small" class="mutter-dot"></div></div><script type="module" src="./main.ts"></script></body>
```

The bubble's own declarations are exactly the ones it has today minus `pointer-events`, `opacity` and `transition`, which move to the wrapper; its look does not change.

- [ ] **Step 2: Renderer wiring**

In `main.ts`:

Near the top, after `const mutterEl = ...`:

```ts
const mutterWrap = document.getElementById('mutter-wrap') as HTMLDivElement
const dotEls = [document.getElementById('mutter-dot-big'), document.getElementById('mutter-dot-small')] as HTMLDivElement[]
```

and import from the new module:

```ts
import { headPoint, trailDots, trailStart, type Rect, type Side } from './thought'
```

Replace `placeMutter` with:

```ts
// Beside his head: above the canvas if the window (the bottom strip, usually) has room for
// the bubble there, otherwise to whichever side of the canvas has more room. Re-run from
// place() on every frame he might be walking through, so the bubble tracks him. The two
// lead-in dots are then laid on the line from the bubble's near edge to his head
// (thought.ts), so they stay on him even when the bubble is clamped away by a window edge.
function placeMutter(canvasLeft: number, canvasTop: number): void {
  if (!mutterVisible) return
  const bw = mutterEl.offsetWidth
  const bh = mutterEl.offsetHeight
  const winW = window.innerWidth
  const winH = window.innerHeight
  // Anchor on his actual drawn pixels, not the full character cell, so the bubble sits
  // close to him instead of floating off toward the cell's empty margin. Before the first
  // draw (drawnRect.w is 0) fall back to the canvas box.
  const haveDrawn = drawnRect.w > 0
  const drawn: Rect = haveDrawn
    ? { x: canvasLeft + drawnRect.x, y: canvasTop + drawnRect.y, w: drawnRect.w, h: drawnRect.h }
    : { x: canvasLeft, y: canvasTop, w: canvas.width, h: canvas.height }
  let bubble: Rect
  let side: Side
  const aboveTop = drawn.y - bh - 4
  if (aboveTop >= 0) {
    const left = Math.min(Math.max(0, drawn.x + drawn.w / 2 - bw / 2), Math.max(0, winW - bw))
    bubble = { x: left, y: aboveTop, w: bw, h: bh }
    side = 'above'
  } else {
    const top = Math.min(Math.max(0, drawn.y + 6), Math.max(0, winH - bh))
    const roomLeft = canvasLeft
    const roomRight = winW - (canvasLeft + canvas.width)
    if (roomRight >= roomLeft) {
      bubble = { x: Math.min(drawn.x + drawn.w + 4, Math.max(0, winW - bw)), y: top, w: bw, h: bh }
      side = 'right'
    } else {
      bubble = { x: Math.max(0, drawn.x - bw - 4), y: top, w: bw, h: bh }
      side = 'left'
    }
  }
  mutterEl.style.transform = `translate(${Math.round(bubble.x)}px, ${Math.round(bubble.y)}px)`
  const head = headPoint(drawn)
  const dots = trailDots(trailStart(bubble, side, head), head)
  dots.forEach((d, i) => {
    const r = d.size / 2
    const cx = Math.min(Math.max(r, d.x), Math.max(r, winW - r))
    const cy = Math.min(Math.max(r, d.y), Math.max(r, winH - r))
    dotEls[i].style.transform = `translate(${Math.round(cx - r)}px, ${Math.round(cy - r)}px)`
  })
}
```

Note the side naming: the existing code called the bubble-to-his-right placement `side-right`; here `side` names where the bubble is relative to him, and `trailStart` takes the bubble's LEFT edge for `'right'` (bubble to his right) and RIGHT edge for `'left'`, which matches Task 1's tests.

In `hideMutterAtOnce`, `fadeOutMutter` and `showMutter`, replace every `mutterEl.classList.remove('visible')`, `mutterEl.classList.add('visible')`, `mutterEl.hidden = true` and `mutterEl.hidden = false` with the same calls on `mutterWrap`. Keep `mutterEl.textContent = text` and `void mutterEl.offsetWidth` as they are (the reflow read can stay on the bubble).

- [ ] **Step 3: Typecheck and unit suite**

Run: `cd /c/repo/mechanicus-buddy-dots && npm run typecheck && npx vitest run`
Expected: typecheck clean; 317 tests pass (309 plus Task 1's 8).

- [ ] **Step 4: E2E assertion for the dots**

In `e2e/mutter.spec.ts`, after the `textContent` poll and before the `toBeHidden` wait, add:

```ts
  // The two lead-in dots show and hide with the bubble, and sit inside the window.
  const big = overlay.locator('#mutter-dot-big')
  const small = overlay.locator('#mutter-dot-small')
  await expect(big).toBeVisible()
  await expect(small).toBeVisible()
  const boxes = await Promise.all([big.boundingBox(), small.boundingBox(), overlay.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))])
  for (const b of [boxes[0], boxes[1]]) {
    expect(b).not.toBeNull()
    expect(b!.x).toBeGreaterThanOrEqual(0)
    expect(b!.y).toBeGreaterThanOrEqual(0)
    expect(b!.x + b!.width).toBeLessThanOrEqual(boxes[2].w)
    expect(b!.y + b!.height).toBeLessThanOrEqual(boxes[2].h)
  }
```

and after the bubble's `toBeHidden`, add `await expect(big).toBeHidden()`.

- [ ] **Step 5: Commit**

```bash
cd /c/repo/mechanicus-buddy-dots && git add src/renderer/overlay/index.html src/renderer/overlay/main.ts e2e/mutter.spec.ts && git -c commit.gpgsign=false commit -q -F - <<'MSG'
overlay: thought-bubble dots run from the bubble to his head instead of hanging off the bubble

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 3: Verification and Peter's look

- [ ] **Step 1: Full unit suite and typecheck**

Run: `cd /c/repo/mechanicus-buddy-dots && npm run typecheck && npx vitest run`
Expected: clean; 317 tests pass.

- [ ] **Step 2: E2E**

Run: `cd /c/repo/mechanicus-buddy-dots && npm run test:e2e 2>&1 | tail -8`
Expected: 22 passed (the mutter spec now also checks the dots).

- [ ] **Step 3: Em dash sweep**

Run: `cd /c/repo/mechanicus-buddy-dots && git diff master --name-only | xargs grep -l "$(printf '\xe2\x80\x94')" ; echo "exit=$?"`
Expected: no file names, `exit=123`.

- [ ] **Step 4: Hand-off**

Report to the controller: commits, counts. The controller merges to master and restarts the buddy, then Peter looks at the bubble at rest and after `/goto 2` and `/goto 98` (edge-clamped bubble), the visual review this repo requires for anything drawn.
