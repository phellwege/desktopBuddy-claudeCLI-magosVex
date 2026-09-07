# Thought-bubble dots anchored at his head

Date: 2026-09-07. Status: head point chosen by Peter (three quarters of the way from the
sprite's centre to its top); geometry proposed by Claude, awaiting Peter's look at the
result on screen.

## 1. Problem

The idle thought bubble (`#mutter` in `src/renderer/overlay/index.html`) trails two small
circles toward him. They are CSS pseudo-elements at fixed offsets on the bubble
(`side-above`: 28% and 20% along the bubble's bottom edge; `side-left` and `side-right`:
fixed offsets on the near edge). `placeMutter` in `src/renderer/overlay/main.ts` clamps
the bubble to the window and picks the side, but the dots only know the bubble, not him.
When the bubble is wide, or pushed sideways by a window edge, the dots hang somewhere
along the bubble's edge with no relation to his head. Peter's read: anchor them on a head
point computed from his drawn pixels so they always start where his head is.

## 2. Geometry

All coordinates are overlay-window pixels, the frame `placeMutter` already works in.

- **Drawn rect.** `drawnRect` (the trimmed sprite inside the canvas cell, set on every
  paint) offset by the canvas position: this is the `bx`, `by`, `bw2` the bubble already
  anchors on, plus the height. Before the first paint (`drawnRect.w` is 0) the canvas box
  stands in, as it does for the bubble today.
- **Head point.** `x` at the drawn rect's horizontal centre; `y` three quarters of the way
  from the rect's vertical centre to its top: `y = top + h / 2 - 0.75 * (h / 2)`, which is
  `top + h / 8`. The 0.75 is one named constant, `HEAD_FRACTION`.
- **Trail start.** The point on the bubble's near edge closest to the head, kept an inset
  of one big-dot radius plus 2 px away from the bubble's corners:
  - bubble above him (`side-above`): the bottom edge, `x` = head `x` clamped into
    `[left + inset, right - inset]`;
  - bubble to his left (`side-left`): the right edge, `y` = head `y` clamped into
    `[top + inset, bottom - inset]`;
  - bubble to his right (`side-right`): the left edge, same `y` rule.
- **Dots.** Two circles centred on the segment from the trail start to the head point:
  the big one (12 px) at 35% of the way, the small one (8 px) at 70%. Each centre is
  then clamped so the circle stays inside the window. Sizes and fractions are named
  constants.

Because the start follows the head's `x` (or `y`) along the bubble's edge and the dots lie
on the straight line to the head, a bubble that has been clamped away from him produces a
diagonal trail that still ends at his head, which is the visible fix.

## 3. What changes

- New pure module `src/renderer/overlay/thought.ts` (no DOM): `headPoint(drawn)`,
  `trailStart(bubble, side, head)`, `trailDots(start, head)` and the constants. Unit
  tested under vitest's node environment like `src/renderer/hologram/compose.ts`.
- `index.html`: the two pseudo-elements and the six `side-*` rules go. A wrapper
  `#mutter-wrap` (absolute, top-left, `pointer-events: none`, the opacity transition and
  the `visible` class) holds the bubble `#mutter` and two real elements
  `#mutter-dot-big` and `#mutter-dot-small` (absolute, top-left, transform-positioned,
  same fill and border as the bubble, 12 px and 8 px). The bubble keeps its own look.
- `main.ts`: `showMutter`, `fadeOutMutter` and `hideMutterAtOnce` toggle `hidden` and
  `visible` on the wrapper instead of the bubble. `placeMutter` keeps its placement and
  clamping of the bubble, records which side it chose, then computes the head point, the
  trail start and the two dot centres through `thought.ts` and sets the two dots'
  transforms (`translate(cx - size / 2, cy - size / 2)`, rounded). The `side-*` classes
  are no longer needed and are removed.
- `e2e/mutter.spec.ts`: alongside the bubble's visibility, assert both dots are visible
  while the bubble is and hidden after it fades; the `#mutter` locator keeps working
  because the wrapper carries `hidden`.

Nothing about when the bubble appears, its text, timing, or the bubble's own position
changes.

## 4. Tests

- `thought.test.ts`: head point of a known rect (`top + h / 8`, centre `x`); trail start
  for each side including the clamp against both corners; dot fractions and sizes; a
  clamped-bubble case where the bubble sits well to the right of him and the dots step
  left and down toward the head; a case where nothing has drawn (canvas box passed in).
- e2e `mutter.spec.ts` as above.
- Peter looks at it on screen (the process rule for anything visual): bubble above him at
  rest, and near a window edge after a `/goto 2` or `/goto 98`.

## 5. Out of scope

Bubble placement or size, the mutter lines, timing, hologram panel bubbles.
