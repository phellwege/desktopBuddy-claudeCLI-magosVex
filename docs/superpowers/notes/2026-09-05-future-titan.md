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
- **Target and the "destroy" gag.** Two options:
  - *Windows first (recommended):* pick a visible top-level window (nearest the titan, or
    a random one), minimize it at the moment of impact, restore it when the skull finishes.
    Plain Win32 calls, robust.
  - *Desktop icons later:* items of Explorer's desktop list view cannot be hidden, but
    they can be moved: the classic cross-process trick (write an LVITEM into Explorer's
    memory, send LVM_SETITEMPOSITION) shoves the icon off-screen behind the explosion and
    slides it back on reassembly. Feasible, hacky, sensitive to Explorer versions.
  - Either way this needs a native helper for window enumeration and positions: a small
    FFI layer (koffi) in main or a helper executable, replacing the PowerShell probes used
    by hand so far.
- **Choreography:** a scripted timeline in main (summon, walk in, aim, fire, impact,
  target gone, skull flies, reassemble, target back, titan walks off), interruptible by
  `/stop`, with the buddy reacting (alarmed emote on the shot, happy on the rebuild).

## Effort

Larger than multi-monitor: Peter's art and annotation time for the titan sheet, then
about two or three sessions for the effects window, the native helper, the choreography
state machine, and tests.

## Open questions

- Which monitor when there are several: the buddy's, or the one under the cursor?
- Should the shot target a window near the titan, the cursor, or a random one?
- Does Vex trigger it on his own ever, or only on command? (Multi-monitor rule was
  "never on his own"; same default here.)
