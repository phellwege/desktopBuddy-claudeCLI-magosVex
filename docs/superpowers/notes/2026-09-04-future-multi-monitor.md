# Future: multi-monitor travel and drag

Date: 2026-09-04
Status: parked, requested by Peter, not scheduled. Plan A/B keep the body on the
primary display's bottom edge (main spec section 2 non-goals).

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
  or non-adjacent (diagonal or separated); non-adjacent falls back to hover the whole
  way.
- Drag: overlay switches to interactive on mousedown over the sprite, follows the
  cursor with `hover`, and on mouseup resolves the display under the cursor and lands.
- Close the hologram panel before any travel; it reopens on the new display if the user
  clicks him again.

## Open questions for Peter

- Diagonal or separated monitors: hover the whole way, or refuse with a line?
- Should wandering ever cross monitors on its own, or only when told or dragged?
- While dragged, should the click-through toggle stay off until release (he would
  block clicks under the cursor for the duration)? Probably yes.
