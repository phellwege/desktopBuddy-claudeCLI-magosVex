# Multi-Monitor Travel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The body can be commanded onto any attached display and travels there in character: run to a launch point, `hover` (with a `hop` when crossing a side seam), land on the target display's bottom edge, walk to the requested spot.

**Architecture:** The character's canonical position becomes a floor-center point in absolute virtual-desktop pixels. A new pure `displays.ts` derives an ordinal roster from `screen.getAllDisplays()`, classifies a target as beside / above / below / apart, and plans a route as a list of legs. `Buddy` gains a display ordinal, a `hovering` activity, and a leg queue advanced by the existing arrival event. The single overlay window stays a bottom strip on the current display and expands to the union of source and target work areas only for the duration of a flight, so the sprite can render across the seam without a second window.

**Tech Stack:** Electron 44, TypeScript, electron-vite, vitest, Playwright `_electron`.

Spec: `docs/superpowers/notes/2026-09-04-future-multi-monitor.md` (Peter's requirements and his 2026-09-04 answers).

## Assumptions taken without review

These three calls were put to Peter on 2026-09-05 and not answered; the plan proceeds on the recommended option. Any of them can be reversed in plan review, and the note in each place says what changes if so.

1. **One overlay window, re-bound per display and expanded during flight.** Not one window per display (needs a travel window anyway, so strictly more work) and not a permanent full-virtual-desktop window (a permanent always-on-top layer over every screen risks interfering with fullscreen games). Steady-state footprint is byte-identical to today's.
2. **Ordinal display ids**, ordered top-to-bottom then left-to-right, re-derived on every roster change. Not Electron's opaque ids (unfriendly to type, renumber on hotplug) and not directional names (vocabulary changes when monitors are rearranged).
3. **Travel only. Drag is a later slice.** Drag needs the interactive-overlay and hit-test work layered on a coordinate model that does not exist yet; it lands cleanly once travel is proven. The union-rect window and the airborne state machine built here are what drag will reuse.

## Deviation from the note

The note says "close the hologram panel before any travel; it reopens on the new display if the user clicks him again." That is wrong for the common case: the brain calls `go_to` *while it is mid-reply into the open panel*, so closing would discard a streaming turn. Instead the panel **hides** for the duration of the flight and is re-placed and re-shown on the target display after landing, with its content intact (hiding a `BrowserWindow` preserves renderer state). `panelOpen` stays true throughout.

## Global Constraints

- No em dashes anywhere (code, comments, commit messages, docs). Application code never names the Mechanicus; pack-specific text lives under `packs/`.
- Autonomous wandering never crosses displays (Peter, 2026-09-04). Only a command, a tool call, or a future drag moves him to another display. `Buddy.tick`'s wander picks an x fraction on the *current* display and is otherwise untouched.
- The bottom-edge invariant becomes "the bottom edge of the current display's work area". He is never at rest anywhere else.
- Every new geometry helper is pure and unit-tested against the fixture in `displays.test.ts` that reproduces Peter's actual three-screen layout, including its negative coordinates.
- No test spawns the real `claude`; every test uses `test/fake-claude.cjs`.
- Commit with `git -c user.name="phellwege" -c user.email="phellwege1@gmail.com" commit -m "<message>"`; every message ends with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Stage only files you changed (never `git add -A`; ignore `build/` and `test-results/`). No PRs.
- **Worktree, not in place** (the 9/5 lesson, reinforced by the hologram hot-reload hazard noted in `2026-09-04-plan-b-carryforward.md`): branch `multi-monitor-travel` lives in `C:\repo\mechanicus-buddy-mm` with `node_modules` junctioned to the main tree. `C:\repo\mechanicus-buddy` stays on `master` for Peter's own session. This slice edits the overlay renderer, so a hot reload against his running app is exactly the failure that note describes.
- Windows: PowerShell-safe or Git Bash commands; never `taskkill` from Git Bash. Kill leftover test Electron processes with PowerShell `Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force` only when no dev instance is running (the controller runs the dev instance; ask if unsure).

## Target hardware

The development machine has three displays, and the plan's fixtures use these exact rects:

| Device | Bounds | Work area | Role |
|---|---|---|---|
| `DISPLAY3` | `(-575, -1440) 5120x1440` | `(-575, -1440) 5120x1392` | ultrawide, **above** both others, overhangs left and right |
| `DISPLAY2` | `(0, 0) 1920x1080` | `(0, 0) 1920x1032` | primary |
| `DISPLAY1` | `(1920, 0) 1920x1080` | `(1920, 0) 1920x1032` | **beside** the primary, shared edge at x=1920 |

This layout exercises every branch: `above` (2 to 1), `beside` (2 to 3), and negative virtual coordinates throughout. It does **not** exercise `apart`, which stays unit-test-only.

Ordinals under the top-to-bottom, left-to-right rule: `DISPLAY3` = 1, `DISPLAY2` = 2, `DISPLAY1` = 3.

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/displays.ts` (new) | `roster()`, `relate()`, `floorY()`, `walkBand()`, `planRoute()`, `unionRect()`. All pure, no Electron import. |
| `src/main/displays.test.ts` (new) | Unit tests over the three-screen fixture plus synthetic `apart` and single-screen cases. |
| `src/main/geometry.ts`, `geometry.test.ts` | `overlayBounds`/`hologramBounds` take a work area (already do) plus a new `travelBounds()`. |
| `src/shared/types.ts` | `Activity` gains `hovering`; `AnimationKey` gains `hover`; `BuddyState` gains `display` and `flight`; `WALK_SPEED`/`RUN_SPEED` become px/s, plus `FLY_SPEED`. |
| `src/main/buddy.ts`, `buddy.test.ts` | Display ordinal, leg queue, `travelTo()`, `hovering` handling in `openPanel`/`sleep`/`emote`. |
| `src/main/actions.ts`, `actions.test.ts` | `goTo` gains a display argument; arrival timeout math in px. |
| `src/main/windows.ts`, `windows.test.ts` | `rebound()` takes a work area; `expandForFlight()` / `collapseTo()`. |
| `src/main/index.ts` | Roster wiring, current-display tracking, flight window expansion, hologram hide/show around a flight, `display-metrics-changed` recovery. |
| `src/shared/ipc.ts`, `src/preload/index.ts` | `StagePayload` (the overlay window's virtual origin), flight leg on `BuddyStatePayload`. |
| `src/renderer/overlay/motion.ts`, `motion.test.ts` | 2D straight-line motion in virtual pixels. |
| `src/renderer/overlay/main.ts` | Absolute virtual placement (`translate(x, y)`), stage handling. |
| `src/main/commands.ts`, `commands.test.ts` | `/goto <display>:<0-100>`, `/displays`, help text. |
| `src/main/server.ts`, `server.test.ts` | `go_to` gains `display`; `get_state` returns the roster. |
| `src/main/brain/prompt.ts`, `prompt.test.ts` | Tools note mentions the display argument. |
| `packs/mechanicus/animations.json`, `pack.mechanicus.test.ts` | A `hover` entry over the existing `hover_0..3` frames. |
| `e2e/travel.spec.ts` (new) | Single-display behavior and the unknown-display error path. |

---

### Task 1: Display roster and route planning

**Files:** create `src/main/displays.ts`, `src/main/displays.test.ts`

**Interfaces:**

```ts
import type { Rect } from './geometry'

export interface ScreenLike { id: number; workArea: Rect; primary: boolean }
export interface DisplayInfo { ord: number; id: number; wa: Rect; primary: boolean }

// Top-to-bottom by work-area y, then left-to-right by x. Ordinals are 1-based and
// re-derived on every roster change, so they stay meaningful when monitors move.
export function roster(screens: ScreenLike[]): DisplayInfo[]

export type Relation = 'same' | 'beside' | 'above' | 'below' | 'apart'
// beside: work areas share a vertical edge AND their y ranges overlap.
// above/below: y ranges are disjoint AND their x ranges overlap.
// apart: everything else (diagonal or physically separated).
export function relate(from: Rect, to: Rect): Relation

export function floorY(wa: Rect): number            // wa.y + wa.height
export function walkBand(wa: Rect, charW: number): { min: number; max: number }
export function toFraction(vx: number, wa: Rect, charW: number): number
export function fromFraction(f: number, wa: Rect, charW: number): number

export type Leg =
  | { kind: 'walk'; to: { x: number; y: number }; run: boolean }
  | { kind: 'fly'; to: { x: number; y: number }; hop: boolean }

// startVX is the character's current floor-center x in virtual px; landFraction is the
// requested 0..1 position on the target display. Legs are in virtual px throughout.
// A zero-length leg is never emitted.
export function planRoute(args: {
  from: DisplayInfo; to: DisplayInfo; startVX: number; landFraction: number
  charW: number; runThreshold: number
}): Leg[]
```

Routes, all ending with a walk along the target floor to the requested spot (dropped when it is zero-length):

- `same`: a single `walk`.
- `beside`: `walk` to the shared edge inset by `charW/2` on the source side, then `fly` with `hop: true` to the mirrored inset point on the target floor, then `walk`.
- `above` / `below`: `walk` to the launch x, which is the requested landing x clamped into the horizontal overlap of the two work areas (so the trailing walk is usually zero), then `fly` with `hop: false` straight up or down to the target floor, then `walk`.
- `apart`: `walk` to the midpoint of the source walk band (Peter's answer), then a single straight-line diagonal `fly` to the nearest point of the target walk band on its floor, then `walk`.

`run` on a walk leg is `true` when the leg's distance is at least `runThreshold` of the source display's walk band, matching today's rule.

**Tests:** the three-screen fixture verbatim from the table above.
- [x] `roster` orders `DISPLAY3, DISPLAY2, DISPLAY1` as ordinals 1, 2, 3 and survives the negative y.
- [x] `relate` returns `beside` for 2→3, `above` for 2→1 and 3→1, `below` for 1→2, `same` for 2→2.
- [x] `relate` returns `apart` for a synthetic diagonal pair and for two rects with a gap between them.
- [x] `planRoute` 2→3 emits walk-to-x1920-minus-inset, fly with `hop: true`, then the trailing walk.
- [x] `planRoute` 2→1 with `landFraction` 0.5 emits a walk to the clamped launch x, a `hop: false` fly, and a **short** trailing walk. (Corrected during Task 1: the plan first claimed no trailing walk. The ultrawide's centre is x=1985, past the primary's band max of 1820, so the launch column cannot reach it and a 165 px walk remains. A no-trailing-walk case exists but needs a landing fraction whose column lies inside the primary; that is covered by its own test.)
- [x] `planRoute` 2→1 with `landFraction` 0 (the ultrawide overhangs left of the primary, so the landing x is outside the primary's band) emits a launch at the primary's left edge, a fly, then a non-zero trailing walk left.
- [x] `planRoute` same-display reduces to one walk, identical to today's `goTo`.
- [x] Single-display roster: every ordinal resolves to 1 and `planRoute` to itself is one walk.
- [x] `apart` runs to the halfway point, then one straight diagonal fly, then the trailing walk.
- [x] An explicit `run` override applies to every walk leg; sub-pixel legs are never emitted.

### Task 2: Position in virtual pixels

**Files:** `src/shared/types.ts`, `src/renderer/overlay/motion.ts`, `motion.test.ts`

`Motion` becomes a 2D straight-line integrator over virtual pixels. This replaces the fraction-per-second speeds, which had a latent bug that multi-monitor makes visible: at `WALK_SPEED = 0.08` of the walk band per second he would cross the 5120-wide ultrawide 2.7x faster than the 1920-wide primary. Speeds become pixels per second, chosen to match today's on-primary feel.

```ts
// src/shared/types.ts
export const WALK_SPEED = 140   // px/s, was 0.08 fraction/s (~137 px/s on a 1920 primary)
export const RUN_SPEED = 430    // px/s, was 0.25 fraction/s (~430 px/s on a 1920 primary)
export const FLY_SPEED = 700    // px/s along a fly leg

// src/renderer/overlay/motion.ts
export class Motion {
  vx: number; vy: number                          // floor-center, virtual px
  target: { x: number; y: number } | undefined
  speed = 0                                       // px/s
  setTarget(target: { x: number; y: number } | undefined, speed: number): void
  advance(dtMs: number): { arrived: boolean }     // straight line toward target
}
```

- [x] Port `motion.test.ts` to the 2D form: existing horizontal cases with `vy` held constant must keep passing unchanged in behavior.
- [x] Add a diagonal case: arrival happens once, at the endpoint, with no overshoot.
- [x] Add a case where `dtMs` overshoots the remaining distance: it clamps to the target rather than passing it.

### Task 3: Buddy gains a display and a leg queue

**Files:** `src/main/buddy.ts`, `src/main/buddy.test.ts`, `src/shared/types.ts`

```ts
export type Activity = 'idle' | 'walking' | 'running' | 'hopping' | 'sitting' |
  'sleeping' | 'looking' | 'projecting' | 'emoting' | 'hovering'
export type AnimationKey = ... | 'hover'
export interface BuddyState {
  x: number                                   // fraction on the CURRENT display, unchanged meaning
  display: number                             // ordinal, 1-based
  facing: Facing; activity: Activity; mood: Mood
  panelOpen: boolean; asleep: boolean
  targetX?: number
  // Present only while activity is 'hovering' or a leg is in flight: the leg the renderer
  // is interpolating, in virtual px. Absent at rest, so resting state is unchanged.
  leg?: Leg
}
```

`Buddy` keeps `private legs: Leg[]` and a `travelTo(displayOrd, x, run?)` that stores the planned route and starts leg 0. `arrived()` pops the next leg if one remains, and only runs its existing tail logic (rest pick, queued emote, pending sleep, panel reprojection) when the queue empties. The display ordinal flips to the target at the moment the `fly` leg's arrival is reported, which is exactly when he touches the target floor.

- [x] `travelTo` to the current display is behaviorally identical to `goTo` (same emissions, same tail logic).
- [x] A three-leg route reports `walking` → `hovering` → `walking` → `idle` and emits `display` changing exactly once, on the fly leg's arrival.
- [x] `animation()` returns `hover` while `hovering`, and `hop` for a `hop: true` leg's opening frames before switching to `hover`.
- [x] `openPanel()` does not force `projecting` while `hovering` (today it excludes only walking and running).
- [x] `sleep()` mid-flight sets `pendingSleep` and lands first, same as it does mid-walk.
- [x] `emote()` mid-flight queues rather than interrupting, same as mid-walk.
- [x] Wander never sets a `display` different from the current one.
- [x] A new `travelTo` mid-flight supersedes the old route and drops its remaining legs.

### Task 4: The overlay window follows and expands

**Files:** `src/main/geometry.ts`, `geometry.test.ts`, `src/main/windows.ts`, `windows.test.ts`

```ts
// src/main/geometry.ts
export function unionRect(a: Rect, b: Rect): Rect
// The union of the two work areas, plus a small margin. A straight line between any two
// points inside a bounding box stays inside it, so this contains the whole flight path;
// each display's own work area already provides charH of headroom above its own floor.
export function travelBounds(from: Rect, to: Rect): Rect
```

`rebound(overlay, wa, charH)` takes the work area instead of reading the primary. Two new helpers set the window to the travel rect and back to the target display's strip. No ack handshake is needed: the character is positioned in absolute virtual coordinates, so a window resize landing a frame late shifts nothing on screen.

- [x] `unionRect` is correct with negative origins (the `DISPLAY3` + `DISPLAY1` union is `(-575, -1440) 4415x2520`).
- [x] `travelBounds` of a display with itself is that display's own rect plus margin.
- [x] `overlayBounds` and `hologramBounds` are unchanged in behavior when handed the primary's work area (regression guard: the existing tests must pass untouched).

### Task 5: The renderer draws at an absolute virtual position

**Files:** `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/overlay/main.ts`

A new `StagePayload { origin: { x: number; y: number } }` tells the overlay renderer its window's virtual origin; it is sent whenever the window is re-bound. Placement stops being "bottom-anchored, translateX only":

```ts
const place = () => {
  const left = motion.vx - stage.origin.x - canvas.width / 2
  const top  = motion.vy - stage.origin.y - canvas.height
  canvas.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
}
```

The 4px baseline inset inside the canvas is unchanged, so at rest on the primary the drawn result is pixel-identical to today. `apply()` sets the motion target from `state.leg` when present, otherwise from the resting fraction as it does now. Facing during a fly leg follows the sign of the leg's dx.

- [x] With a single display and no leg, the rendered position matches the pre-change behavior for fractions 0, 0.5, and 1 (assert against the computed transform, not a screenshot).
- [x] The `origin` report for the hologram cone keeps working: it already converts to screen coordinates via `window.screenX/screenY`, which stays correct in the expanded window.

### Task 6: Command, tool, and prompt surfaces

**Files:** `src/main/commands.ts`, `commands.test.ts`, `src/main/chat.ts`, `chat.test.ts`, `src/main/actions.ts`, `src/main/server.ts`, `server.test.ts`, `src/main/brain/prompt.ts`, `prompt.test.ts`

- `/goto <0-100|left|center|right>` unchanged (current display). New `/goto <display>:<target>`, for example `/goto 1:50`, and the same for `/run`.
- New `/displays` lists the roster with size, ordinal, and which one he is on.
- `go_to` tool: `{ x: z.number().min(0).max(100), display: z.number().int().min(1).optional(), run: z.boolean().optional() }`.
- `get_state` returns the roster so the model can choose sensibly: each entry with ordinal, pixel size, whether it is primary, and whether he is currently on it.
- `prompt.ts` tools note: `go_to` moves the body to a percentage across the current screen, or to another display with `display`.

- [x] `/goto 1:50` parses to `{ kind: 'goto', display: 1, x: 0.5, run: false }`.
- [x] `/goto 50` parses with `display: undefined` (current display), byte-identical to today's result shape otherwise.
- [x] `/goto 0:50` and `/goto abc:50` are usage errors.
- [x] `/goto 9:50` on a three-screen roster reports `no display 9 (1-3 attached)` and moves nothing.
- [x] The `go_to` tool with `display` calls through to `actions.goTo` with the ordinal; without it, the existing single-argument test still passes.
- [x] `get_state` includes the roster and marks the current display.

### Task 7: Wiring, the hologram, and display changes

**Files:** `src/main/index.ts`, `packs/mechanicus/animations.json`, `src/main/pack.mechanicus.test.ts`

- Track the current `DisplayInfo`; `placeHologram` and `rebound` use its work area rather than `screen.getPrimaryDisplay()`.
- On flight start: if the panel is open, `hologram.hide()`. On landing: `placeHologram()` against the new display, then `hologram.show()` if it was open. `panelOpen` stays true and the panel's content is untouched.
- `display-metrics-changed`: re-derive the roster. If the current display is gone, abort any flight, snap him to the primary's floor, re-bound both windows. If it still exists, re-bound in place as today.
- `animations.json` gains `hover` over the existing `hover_0..3` frames (loop, `mirrorLeft`, fps 8). No new art: the atlas already carries them, unused.

- [x] `pack.mechanicus.test.ts` asserts the `hover` entry resolves to four real atlas frames.
- [x] Unplugging the current display is covered by a unit test over the recovery helper, not by an Electron test.

### Task 8: Verification

**Files:** `e2e/travel.spec.ts`

Playwright cannot fake a second display, so automated e2e covers only what a single screen can prove; the real verification is manual on the three-screen rig and must be done before the branch is called done.

- [x] e2e: `/goto 1:50` on a single-display machine behaves exactly like `/goto 50`.
- [x] e2e: `/goto 2:50` on a single-display machine shows the `no display 2` error and he does not move.
- [x] e2e: the existing overlay and hologram specs pass unchanged.
- [ ] **Manual, on the three-screen rig, with Peter present:** `/goto 3:50` from the primary (beside, hop across the x=1920 seam); `/goto 1:50` from the primary (above, straight rise onto the ultrawide); `/goto 1:0` from display 3 (above and a long trailing walk into the ultrawide's left overhang); `/goto 2:50` from display 1 (below, descent); a `go_to` issued by the brain mid-reply with the panel open, confirming the panel hides, follows, and re-shows with its text intact.

---

## Findings during implementation

Three things the plan did not anticipate, all fixed:

1. **Hiding the panel closed it.** `hologram.hide()` blurs the window, and the blur handler's
   job is to close the panel on a click-away. So the panel hidden for the trip closed itself
   and never came back, which is exactly the streaming-turn loss the deviation above exists to
   prevent. Main now tracks `journeying` and the blur handler stands down for the duration.
2. **The e2e suite was testing the dev server, not the build.** `ELECTRON_RENDERER_URL` is set
   in anything spawned by a running `npm run dev`, and the buddy's brain is spawned by exactly
   that, so a test run started from inside the app loaded renderers from whichever checkout the
   dev server was serving. Every spec silently exercised the main tree instead of its own build.
   `e2e/env.ts` strips the variable; `body.spec.ts` and `brain.spec.ts` were affected too and
   now pass against a real build for the first time.
3. **`ipcMain.emit` is dropped silently before `wireIpc` runs.** A synthetic `overlay:click`
   sent too early does nothing, and because a hidden `BrowserWindow` still has a live, fillable
   DOM, a test could type into a panel that was never open and notice nothing. The travel spec
   waits for the pack handshake and asserts `panelOpen` rather than inferring it.

## Out of scope

- **Drag** (`hover` while held, land on the display under the cursor). The next slice; it reuses the union-rect window and the airborne state from here.
- **Remembering the display across restarts.** He starts on the primary every launch, as today. `state.json` is untouched.
- **Autonomous cross-display wandering.** Explicitly ruled out by Peter.
- **Perching on window edges.** Still a non-goal from the main spec.
