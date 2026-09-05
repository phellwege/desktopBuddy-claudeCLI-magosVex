# Future: multi-monitor travel and drag

Date: 2026-09-04
Status: **DELIVERED 2026-09-05.** Both halves are built and merged: commanded travel
(`2026-09-05-multi-monitor-travel.md`) and then click-and-drag on top of it. The
non-goal in main spec section 2 no longer holds.

Two things landed differently from the sketch below. The panel **hides and follows**
rather than closing, because the brain calls `go_to` mid-reply and closing would discard
a streaming turn. And there is **one overlay window**, not one per display: it is a
bottom strip on the display he is standing on, and grows to span source and target only
while he is in the air (the whole desktop while he is being carried).

## What Peter wants

1. **Commanded travel to another monitor** (`/goto` with a display target, and the
   `go_to` tool gaining a `display` argument).
   - Target monitor **above** the current one: use the `hover` animation and rise
     straight up onto that screen, landing on its bottom edge.
   - Target monitor **horizontally adjacent**: run toward the shared edge; as he nears
     it, play `hop` then `hover` across the gap, then land (`fall` into idle) on the
     bottom edge of the other monitor.
2. **Click and drag** the body to any monitor: `hover` plays the whole time he is held;
   on release he keeps hovering while descending until he lands on the bottom edge of
   whichever monitor he was dropped over (the "bar below him"), then idles.

## Art

The atlas already carries `hover_0..3` (unused today) and `jump_0..3` (`hop` and
`fall`). No new sprites are needed; a `hover` animation entry in `animations.json` is
the only pack change.

## Implementation sketch

- One overlay window per display (or one window spanning the virtual desktop) so the
  body can render across the seam; `hologramBounds`/`placeHologram` need the
  display's work area instead of the primary's.
- Buddy state gains a display id and a vertical coordinate for the airborne phase; the
  state machine gets `hovering` and `landing` activities. The bottom-edge invariant
  becomes "bottom edge of the current display".
- Route planning from `screen.getAllDisplays()`: classify the target as above, beside,
  or non-adjacent (diagonal or separated); non-adjacent runs to the halfway point,
  then hovers vertically and across.
- Drag: overlay switches to interactive on mousedown over the sprite, follows the
  cursor with `hover`, and on mouseup resolves the display under the cursor and lands.
- Close the hologram panel before any travel; it reopens on the new display if the user
  clicks him again.

## Answered by Peter (2026-09-04)

- **Diagonal or separated monitors:** run to the halfway point along the bottom edge,
  then hover up (or down) and over to the target, landing on its bottom edge.
- **Autonomous wandering never crosses monitors.** Only a command or a drag moves him
  to another display.
- **Drag:** the body is solid for the duration of a click-hold-drag by definition, so
  the click-through question does not apply.
