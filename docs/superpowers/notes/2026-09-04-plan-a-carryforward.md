# Plan A carry-forward (merged to master 2026-09-04 at 4261d2b)

Items the final whole-branch review and the per-task reviews deferred. Address in Plan B or later slices.

## Before Plan B drives the body from a model
- Main-side arrival timeout: Actions.goTo resolves on the renderer's arrival event; if the overlay is hidden mid-walk the promise never settles and go_to would hang.
- Hologram window: add will-navigate and setWindowOpenHandler blocks before model output flows through the panel.
- Annotated mode: check the saved sheetSize against the sheet being sliced.
- Quit path: the 250 ms tick and the hover watchdog keep firing after before-quit destroys the windows.
- ChatController: concurrent activity rows render in reverse order (unreachable with EchoBrain).

## Deferred minors (ledger)
- Task 2: minor (deferred): bare '/' yields 'unknown command: /' message (plan-mandated cosmetic)
- Task 2: minor (deferred): '/mood ' with empty arg yields 'unknown mood: ' (plan-mandated cosmetic)
- Task 3: minor (deferred): unused 'AnimationDef' type import in src/main/pack.ts
- Task 3: minor (deferred): fallback loop relies on ANIMATION_KEYS order matching FALLBACK dependencies; add a comment or assertion
- Task 4: minor (deferred): run/walk threshold uses >= so exactly 0.25 runs (spec says 'above')
- Task 4: minor (deferred): beginEmote allows a new emote to interrupt an in-progress emote/hop; not in spec, not wrong
- Task 4: minor (deferred): closePanel() resets to idle instead of the pre-panel restful activity (pre-existing, out of fix scope)
- Task 5: minor (deferred): pack_atlas shelf-wrap branch untested; bare open() without context managers in build(); empty frame list would make a zero-width atlas
- Task 6: minor (deferred): unused 'names' list allocated on the facing branch of build() in tools/slice.py
- Task 7: minor (deferred): resolvePackPath raw '..' guard does not cover %2e%2e spelling (no escape possible; inconsistent policy only)
- Task 7: minor (deferred): loadConfig has no runtime type validation of config fields
- Task 8: minor (deferred): CSP img-src also allows data: and blob: (unused); walkable() clamps to 1 and rounds
- Task 9: minor (deferred): Actions.goTo immediate-arrival path resolves twice (harmless)
- Task 9: minor (deferred): watchdog interval has no window 'closed' guard (unreachable today)
- Task 9: minor (deferred): hologram focusable relies on Electron default; make explicit
- Task 9: minor (deferred): ipc click handler's extra interact() call is redundant
- Task 10: review NEEDS FIXES at 89369dc: Important (1) markdown pre-sanitize deletes <T> in code blocks; (2) /new mid-turn race, plan-mandated, fixed additively with a turn serial. minor (deferred): concurrent activity rows render in reverse order (unreachable until Plan B).
- Task 10: minor (deferred): chat.test.ts uses unescaped Windows path literals ('C:\repo', 'D:\w') so the /cd test no longer exercises a real path (test-only)
- Task 11: review NEEDS FIXES at 2edb210: Important (1) tray Show does not restore the hologram (plan-mandated); (2) no main-process uncaughtException/unhandledRejection logging (controller constraint); (3) Ctrl+Q quit path in spec 14 assigned to no task (plan gap). Fix round 1 dispatched. minor (deferred): no unit tests for tray/menu builders; tray icon path will break once packaging is introduced (no packs/ in out/).
- Task 11: minor (deferred): hologram Ctrl+Q handler does not check input.isAutoRepeat

## Follow-ups agreed with Peter
- Hologram projection cone ported from KuonYagiStylePortfolio ProjectionOverlay.js, source = servo skull per frame (origin in atlas.json, annotator override, overlay reports skull screen position, hologram window extends to the skull).
- Persona readback (spec section 19): displayed text unaltered; speaker button summarizes in character via a one-shot claude -p --model haiku, spoken by the voice layer.
- segment_sam._safe_crop_bounds clamps the automatic SAM crop to sibling bands; allow overlap up to the panel border.
- hide_1 annotation is nearly empty (unused by animations).

## Projection cone addendum (merged 2026-09-04 at 22047c6)
Deferred minors from its reviews:
- minor (deferred): cone mask/glow radius 12 vs panel border-radius 4; #panel top:0 clips shadows; canvas not DPR-scaled; 280 gradients per frame; overlay forces layout per frame while panel open; work areas narrower than 720 px overflow; panel overlaps character on work areas under ~706 px tall; rAF stop relies on document.hidden only; reopen shows the previous origin for one frame; cone.test perimeter check weak; e2e width assertion restates the constant; baked flipped origin uses w-1-ox vs renderer w-ox (1 px, moot with explicit left frames).
- Final fixes 91a60df, 85d7d79 re-reviewed clean. minor (deferred): stale renderer hover flag on reopen with the pointer already over the panel (first click falls through until a mouse move). Pack commits e1ca075, 22047c6 from Peter's annotation saves. Branch ready to merge at 22047c6.
- Stale renderer hover flag on reopen with the pointer already over the panel (first click falls through until a mouse move).
- Auto origin detection picks bone-colored effects (the ? bubble, sparkles) over the skull in a few frames; annotator overrides cover the current pack.
