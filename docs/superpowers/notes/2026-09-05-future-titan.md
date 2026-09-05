# Future: summon the Titan

Date: 2026-09-05
Status: parked, requested by Peter, not scheduled. After the voice slice and
multi-monitor work, or whenever the titan sheet exists.

## What Peter wants

A `/titan` command (and a `summon_titan` tool for Vex). A Titan walks in, filling the
full vertical space of the monitor he is on, crosses the screen slowly, fires at an icon
and blows it up (the icon disappears), then Vex sends a servo skull over and it
"reassembles" the destroyed icon, which reappears.

## Pieces

- **Titan pack:** a second sprite sheet through the existing pipeline (bands, keying,
  SAM, annotator, annotated split). Frames must be drawn large or upscaled with a real
  upscaler: a full-height titan is roughly 1000 px tall, and a small sheet blown up 8x
  looks like mud. Bands: walk, aim, fire, muzzle flash, projectile, explosion, servo skull
  flight, reassemble sparkle.
- **Effects window:** a full-screen transparent click-through window (the buddy's overlay
  is only the bottom strip) that draws the titan, projectile, explosion, and skull. Lives
  on whichever monitor is chosen (ties into the multi-monitor note). Optional sound
  through an audio element in that window.
- **Target and the "destroy" gag (Peter's simplification, same day).** Nothing on the
  desktop is hidden or moved. The user marks the target: `/titan mark` records the cursor's
  screen position (Electron's `screen.getCursorScreenPoint()`), or `/titan` with no mark
  uses the cursor position at that moment. The titan fires at the mark; an energy shield
  sprite appears over the icon and shatters; then smoke and a small fire loop are drawn over
  the icon in the effects window. The servo skull flies over and "repairs" it: the smoke
  and fire shrink and fade to nothing. The real icon underneath is never touched, so there
  is no native helper, no Explorer trick, and nothing to restore if the app dies mid-gag.
  Sprite bands needed for this part: shield (appear, hold, shatter), smoke loop, fire loop,
  skull flight, repair sparkle.
- **Choreography:** a scripted timeline in main (summon, walk in, aim, fire, impact,
  target gone, skull flies, reassemble, target back, titan walks off), interruptible by
  `/stop`, with the buddy reacting (alarmed emote on the shot, happy on the rebuild).

## The sheet (Peter, 2026-09-05)

Peter produced the titan sheet (Warlord-style, white and gold with blue weapon energy).
Bands, left to right, top to bottom:

- walk cycle, 8 frames
- idle, 4 frames (loop)
- weapon aim / elevation, 7 frames at -30, -20, -10, 0, +10, +20, +30 degrees
- fire / charge / shoot, 8 frames (two are both labeled 6; the slicer numbers by position)
- post-fire / cooldown, 6 frames (smoke drifting off the barrel)
- beam effect assets, 7 standalone pieces: charge glow 1 and 2, muzzle flash, beam start,
  beam mid 1, beam mid 2, beam end (tileable beam: start + N mids + end)
- impact / icon destruction, 6 frames (flash, fireball, smoke, dissipate)
- smoke and dust, 7 standalone pieces: smoke 1 to 4, foot dust 1 to 3

White background (keys cleanly per band). Frames are roughly 200 px tall; a monitor-height
titan needs about 1000, so regenerate larger or run one pass of a real upscaler
(Real-ESRGAN) before slicing; the nearest-neighbor upscaler will look blocky at 5x.
Expected path: `raw/sheets/titan.png`, its own `rows.json` bands, pack `packs/titan`.

## Effort

Peter's art and annotation time for the titan and effects sheet, then about two sessions
for the effects window, the choreography state machine, and tests. No native code.

## Open questions

- Which monitor when there are several: the buddy's, or the one under the cursor?
- Is one mark enough, or a small list of marked icons that the titan picks from?
- Does Vex trigger it on his own ever, or only on command? (Multi-monitor rule was
  "never on his own"; same default here.)
