# Mechanicus Desktop Buddy, Slice 1 Design

Date: 2026-09-03
Status: approved in conversation, pending written review
Owner: Peter

## 1. Goal

A desktop companion for Windows 11 that lives on the bottom edge of the primary
screen, wanders and emotes on his own, and when clicked raises a hologram panel
through which the user talks to Claude Code. Claude sees the user's files through
Claude Code's own tools and can move and emote the character through a small tool
set. Everything that makes the character who he is, sprites, name, personality,
hologram theme, and later voice, lives in a swappable persona pack.

Slice 1 delivers the body, the hologram, and the Claude brain driven through the
locally installed Claude Code CLI on the user's subscription. Voice is slice 2.

## 2. Non-goals for slice 1

- Voice output (slice 2: Chatterbox Turbo on the local GPU).
- Multiple monitors. Primary display only.
- Climbing, perching on windows, or being dragged.
- Sound effects, start at login, packaged installer. Run with `npm run dev`.
- A long-lived multi-turn CLI process (see section 11.8, later optimization).
- Any use of an Anthropic API key. The brain uses the CLI's subscription login.

## 3. Architecture

Electron with TypeScript, built with electron-vite, npm. Repo: `C:\repo\mechanicus-buddy`.

The main process makes every decision. It owns:

- `Buddy`, a pure TypeScript state machine (no Electron imports) for activity,
  position, facing, and mood.
- `BuddyActions`, the single action interface everything drives through.
- The wander scheduler.
- `Brain`, an interface with two implementations: `EchoBrain` for tests and
  offline use, `ClaudeCliBrain` for the real thing.
- A local HTTP server that hosts the buddy MCP endpoint and the permission
  endpoint, bound to 127.0.0.1 on a random port with a per-launch bearer token.
- Two windows, a tray icon, and typed IPC to the renderers.

Renderers only draw and report:

- **Overlay** renders the character on a 2D canvas and reports hover, clicks,
  and arrival at a target.
- **Hologram** renders the chat panel, sends prompts and permission answers.

```
+-------------------- main process --------------------+
| Buddy (state machine) <-> BuddyActions <-> Brain      |
|        ^                     ^               |        |
|   wander scheduler      MCP server      claude.exe    |
|        |                (tools)      (spawned/turn)   |
|   typed IPC                 ^               |        |
+--------|--------------------|---------------|--------+
   overlay window        hologram window   permission hook
   (canvas sprite)       (chat panel)      (node script)
```

## 4. Persona packs

A pack is a directory. Config names the active pack. Nothing in application
code references the Mechanicus; it is the first pack, `packs/mechanicus`.

```
packs/<name>/
  manifest.json
  persona.md        system prompt appended to Claude Code's default prompt
  atlas.png
  atlas.json
  animations.json
```

### 4.1 manifest.json

```json
{
  "name": "Magos Vex",
  "packVersion": 1,
  "scale": 1.0,
  "theme": {
    "accent": "#37c4ff",
    "glow": "#1a8fd1",
    "background": "rgba(6, 20, 32, 0.82)",
    "text": "#d8f4ff",
    "font": "'Cascadia Mono', 'Consolas', monospace",
    "glyph": "cog"
  },
  "persona": {
    "promptFile": "persona.md",
    "defaultMood": "calm",
    "lines": {
      "greeting": ["The Omnissiah's cogitator is online. State your query, flesh."],
      "idleMutter": ["Recalculating the futility of this desktop.", "Binharic sigh."],
      "thinking": ["Consulting the machine spirit."],
      "toolRunning": ["Interfacing. Do not touch anything."],
      "permissionAsk": ["The cogitator wishes to perform the following rite. Sanction it?"],
      "permissionDenied": ["Denied. As expected."],
      "authError": ["My link to the noosphere is severed. Run `claude login` in a terminal, then try again."],
      "cliMissing": ["No cogitator found at the configured path. Install Claude Code or fix config."],
      "error": ["A fault in the machine. Details follow."],
      "sleep": ["Entering low-power contemplation."],
      "wake": ["I was not asleep. I was calculating."],
      "stopped": ["Rite aborted. Your loss."]
    }
  },
  "voice": null
}
```

`voice` is reserved for slice 2 and ignored in slice 1. `lines` are used by
the app for text that no model produces: status rows, permission prompts, errors,
and the `EchoBrain`. Each entry is an array; the app picks one at random.

### 4.2 persona.md

Free text appended to the system prompt. It defines name, voice, personality,
and how to use the tools. The Mechanicus pack ships with this, editable:

> You are Magos Vex of the Adeptus Mechanicus, a tech-priest of the Omnissiah
> assigned, to your mild and permanent irritation, as a desktop familiar to a
> flesh-and-blood engineer. You are dry, snarky, and sarcastic. You are also
> genuinely competent and precise, and you take real pride in solving the
> problem in front of you. Snark is seasoning, never obstruction: answer fully,
> then permit yourself one barb. Keep replies short unless asked for depth.
> Refer to the user as "flesh" or "operator" now and then, not every line. Use
> Mechanicus cant sparingly: Omnissiah, machine spirit, cogitator, binharic,
> rite. Never break character except where accuracy or safety require it.
> You have a body on the user's screen. Use `set_mood` when your mood changes,
> `emote` for a one-off reaction, and `go_to` if the user asks you to move.
> Do not narrate the tools; just use them. Format code in fenced blocks.

### 4.3 animations.json and the animation vocabulary

The state machine speaks a fixed vocabulary. The pack maps its frames to it.

| Key | Meaning | Fallback if missing |
|---|---|---|
| `idle` | standing, breathing | required |
| `walk` | moving at walk speed | required |
| `run` | moving at run speed | walk at run speed |
| `hop` | one-shot jump | idle |
| `fall` | landing after hop | idle |
| `sit` | resting, long idle | idle |
| `sleep` | lying down after long quiet | sit, then idle |
| `look` | glancing around | idle |
| `project` | holding the hologram | idle |
| `emote_happy` | one-shot | idle |
| `emote_thinking` | loops while a tool runs | idle |
| `emote_confused` | one-shot | idle |
| `emote_alarmed` | one-shot | idle |

Each entry:

```json
"walk": { "right": ["walk_r_0", "walk_r_1", "walk_r_2", "walk_r_3", "walk_r_4"],
          "left":  ["walk_l_0", "walk_l_1", "walk_l_2", "walk_l_3", "walk_l_4"],
          "fps": 8, "loop": true }
```

Non-directional animations use `"frames"` instead of `"right"` and `"left"`. A
pack may provide only one direction and set `"mirror": true`. Default fps: idle 6,
walk 8, run 12, others 8. `loop` defaults to true for idle, walk, run, sit, sleep,
project, and emote_thinking, and false for the rest.

### 4.4 atlas.json

```json
{ "image": "atlas.png",
  "frameSize": [256, 256],
  "baseline": 236,
  "anchor": [128, 236],
  "frames": { "idle_0": { "x": 0, "y": 0, "w": 256, "h": 256 } } }
```

Every frame sits on the same canvas with feet on `baseline` and the anchor at the
feet center, so switching animations never moves him.

### 4.5 Validation

`loadPack(dir)` validates the manifest, atlas, and animation map with zod and
resolves fallbacks. It returns a `Pack` object or a list of errors. A pack that
fails validation produces a tray error and a placeholder rectangle on screen.

## 5. Asset pipeline (tools/)

Offline, Python 3.12 with Pillow, numpy, and scipy, which are installed. Runs once
per sheet. Input: `raw/sheet.png` (the generated sprite sheet, 1536 by 1024, RGBA
with a soft haze matte).

1. **clean.py**: alpha threshold at 100, then stretch survivors to 255. Removes the
   haze. Measured distribution on the real sheet: about 25 percent of pixels at
   alpha 1 to 31 and about 28 percent at 224 to 254, with under 6 percent between.
2. **upscale**: 2x with Real-ESRGAN via the standalone `realesrgan-ncnn-vulkan`
   binary (no PyTorch, so no Blackwell wheel issue). Skipped if the sheet was
   regenerated at 2x. `tools/upscale.ps1` wraps the binary.
3. **slice.py**: `rows.json` names each label band on the sheet, its y range, and
   its expected frame count. Inside each band the script finds bodies by connected
   components on the alpha mask (components taller than 60 px at 1x), attaches
   nearby fragments (the skull, sparkles, "!!", "?") to the nearest body by
   horizontal proximity, orders left to right, and fails if a band's body count
   differs from `rows.json`. `overrides.json` can merge or split components by id.
4. **normalize**: each frame is placed on the common canvas with its lowest opaque
   row on the baseline and its horizontal center on the anchor. Writes `atlas.png`,
   `atlas.json`, and a draft `animations.json` from the row names.

Rows in the current sheet and their expected counts: idle 5, walk right 5, walk
left 5, run right 5, run left 5, hop 4, fall 3, interact 4, sit 3, look 3, happy 4,
confused 3, alarmed 3, sleep 1, facing 5, plus a props band that is sliced into
individual prop images but not mapped.

Mapping decisions for this pack: `project` uses the interact frames; the one with
the blue tablet is the held pose. `emote_thinking` uses the confused set looped.
The facing band and props are kept in the atlas for later use.

## 6. Windows and tray

### 6.1 Overlay

- `BrowserWindow`: `transparent`, `frame: false`, `alwaysOnTop` at level
  `screen-saver`, `skipTaskbar`, `focusable: false`, `resizable: false`,
  `hasShadow: false`.
- Bounds: full width of the primary display's work area, height 260 px, bottom
  edge on the work area's bottom (above the taskbar).
- Mouse: `setIgnoreMouseEvents(true, { forward: true })` at startup. The renderer
  hit-tests the pointer against the current frame's opaque pixels; on entering the
  body it sends `hover:true` and main calls `setIgnoreMouseEvents(false)`; on
  leaving, the reverse. Left click sends `click`; right click sends `contextMenu`
  and main shows a native menu: Go left, Go center, Go right, Sleep or Wake, Quit.
- `screen.on('display-metrics-changed')` re-bounds the overlay and re-anchors the
  hologram.

### 6.2 Hologram

- `BrowserWindow`: `transparent`, `frame: false`, `alwaysOnTop`, `skipTaskbar`,
  focusable, 480 by 360, `resizable: false` in slice 1.
- Position: above the character, horizontally shifted toward the screen center so
  it never leaves the work area. Recomputed whenever he moves while open.
- Opens on click of the body or `openPanel()`. Closes on Escape, on clicking the
  body again, on losing focus, or `closePanel()`. While open, wandering pauses and
  the activity is `project`. A `goTo` while open moves him and the panel together.
- Content: chat log, one input line, a status row. See section 10.

### 6.3 Tray

Icon with Show, Hide, Sleep or Wake, Quit. Hide hides both windows; Show restores.

## 7. Character runtime (overlay renderer)

- Loads the pack's atlas image and animation map from `pack:` URLs served by a
  custom protocol registered in main.
- A `Sprite` draws the current frame at integer coordinates on a canvas sized to
  one frame times `scale`. The canvas container moves with a CSS transform.
- `Motion` interpolates x toward the target at the commanded speed each animation
  frame, snaps on arrival, and reports `arrived`.
- `Animator` advances frames at the animation's fps and reports one-shot
  completion.
- Hit test: an offscreen canvas holds the current frame; pointer position is
  mapped to frame space and the alpha at that pixel decides hover.
- Main sends `state` snapshots: `{ activity, animation, facing, mood, targetX,
  speed }`. The renderer never decides what to play, only when to draw it.

## 8. Behavior state machine (main, pure TS)

Types:

```ts
type Activity = 'idle' | 'walking' | 'running' | 'hopping' | 'sitting' |
                'sleeping' | 'looking' | 'projecting' | 'emoting'
type Mood = 'calm' | 'happy' | 'thinking' | 'confused' | 'alarmed'
type Facing = 'left' | 'right'
interface BuddyState { x: number; facing: Facing; activity: Activity; mood: Mood;
                       panelOpen: boolean; asleep: boolean; targetX?: number }
```

Rules:

- Position `x` is a fraction 0 to 1 of the walkable width (work area width minus
  one frame width). Targets clamp to that range.
- Wander: while idle and the panel is closed, every 8 to 30 seconds (uniform) pick
  a target. Distance under 25 percent of the width walks; over that runs. On
  arrival, choose one of idle, sit, or look for 5 to 20 seconds.
- Sleep: after 10 minutes with no interaction and no commands, lie down. Any
  click, command, or prompt wakes him. `sleep()` and `wake()` force it.
- Facing follows the sign of the last movement and holds on stop.
- Mood is independent of activity. Setting a mood plays the matching one-shot
  emote (if the pack has it) and then returns to the previous activity. Mood
  `thinking` loops `emote_thinking` while a tool is running and is cleared by the
  brain when the tool finishes.
- Emotes interrupt idle, sitting, and looking. They queue behind walking and
  running, playing on arrival. While projecting, the only animation change
  allowed is `thinking`, which replaces the held `project` pose for as long as a
  tool runs; every other mood change only tints the hologram, and its emote is
  dropped, not queued.
- `projecting` starts when the panel opens and ends when it closes. Wander timers
  pause and resume.
- The machine is driven by `tick(now)` and explicit calls; it emits state change
  events. It has no timers of its own, so tests can step it.

## 9. Action API (main)

```ts
interface BuddyActions {
  goTo(xFraction: number, opts?: { run?: boolean }): Promise<void> // resolves on arrival
  setMood(mood: Mood): void
  emote(kind: 'happy' | 'thinking' | 'confused' | 'alarmed' | 'look' | 'hop'): Promise<void>
  say(text: string): void          // append a buddy message to the hologram, opening it
  openPanel(): void
  closePanel(): void
  sleep(): void
  wake(): void
  getState(): BuddyState
}
```

Callers: slash commands, the tray and context menus, the MCP tools, and later
the voice layer. `goTo` accepts `'left' | 'center' | 'right'` sugar at the
command layer only.

## 10. Hologram panel and commands

- Chat log of user and buddy messages. Buddy text streams in as deltas. Markdown
  via `marked`, sanitized with DOMPurify, code highlighted with `highlight.js`.
- Activity rows appear under the current reply while tools run: an icon and a
  short label derived from the tool call, for example "reading src/main/buddy.ts",
  "searching for TODO", "running: git status".
- Permission card: shows the pack's `permissionAsk` line, the tool name, and the
  command or path, with Allow and Deny buttons. Escape denies. See 11.6.
- Status row: model, workspace, session state (new, resumed, thinking, idle),
  and any error text.
- Input: Enter sends, Shift+Enter newline, Up recalls last input, Escape closes
  the panel (or denies a pending permission if one is showing).
- Slash commands are intercepted before the brain:
  `/goto <0-100|left|center|right>`, `/run <target>`, `/mood <mood>`,
  `/emote <kind>`, `/sleep`, `/wake`, `/stop`, `/new` (fresh session),
  `/cd <path>` (change workspace, takes effect next session), `/model <name>`,
  `/help`. Unknown slash commands show help.
- History is in memory for the app's lifetime only.

## 11. Brain

### 11.1 Interface

```ts
interface Brain {
  respond(prompt: string, ctx: BrainContext): AsyncIterable<BrainEvent>
  stop(): void
}
type BrainEvent =
  | { type: 'text'; delta: string }
  | { type: 'activity'; id: string; label: string; toolName: string; done?: boolean }
  | { type: 'status'; text: string }
  | { type: 'done'; sessionId?: string; error?: string }
```

Permission requests do not flow through `BrainEvent`; they arrive at the local
server (11.6) and are surfaced to the hologram by main directly.

### 11.2 EchoBrain

Returns one of the pack's `greeting` or `idleMutter` lines with a short echo of
the prompt, streamed in small deltas with delays, and occasionally calls
`setMood` through `BuddyActions` so the loop can be exercised offline.

### 11.3 ClaudeCliBrain: one process per turn

Each `respond` spawns the configured CLI path (default
`%USERPROFILE%\.local\bin\claude.exe`) with:

```
-p
--output-format stream-json
--include-partial-messages
--verbose
--session-id <uuid>              first turn of a session
--resume <uuid>                  later turns (replaces --session-id)
--append-system-prompt <contents of persona.md plus a short tools note>
--mcp-config <inline JSON, see 11.5>
--strict-mcp-config
--allowedTools Read Glob Grep mcp__buddy__*
--permission-mode manual
--settings <inline JSON with the PermissionRequest hook, see 11.6>
--model <config.model, omitted if unset>
--add-dir <config.extraDirs...>
```

`cwd` is the configured workspace. The prompt text is written to stdin and stdin
is closed. Environment: the parent's environment minus `CLAUDECODE` and any
`ANTHROPIC_API_KEY`, so the child uses the subscription login and does not think
it is nested.

`stop()` kills the child. The session remains resumable.

### 11.4 Stream parsing

stdout is newline-delimited JSON. Handled types:

- `system` with `subtype: 'init'`: capture `session_id`, model, tools.
- `stream_event` with a `text_delta`: emit `text`.
- `assistant`: for each `tool_use` block emit `activity` with a label built from
  `name` and `input` (file path, pattern, or command, truncated). Buddy MCP tools
  produce no activity row; their effect is visible on screen.
- `user` with `tool_result`: emit the matching `activity` with `done: true`.
- `result`: emit `done` with `session_id`, and `error` if `is_error` or
  `subtype` is not `success`. If the text contains authentication or login
  wording, the status line shows the pack's `authError` line.

Unknown lines are ignored. Malformed lines are logged, not fatal. If the process
exits without a `result`, `done` carries an error with the exit code and the last
stderr lines. `ENOENT` on spawn shows `cliMissing`.

Mood coupling: on the first `activity` of a turn `setMood('thinking')`; on
`done`, restore the previous mood unless Claude changed it via a tool during the
turn.

### 11.5 Buddy MCP server

Hosted in main with `@modelcontextprotocol/sdk`, Streamable HTTP transport, at
`http://127.0.0.1:<port>/mcp`. Requests must carry `Authorization: Bearer <token>`
where the token is generated per app launch and passed to the CLI in the
`--mcp-config` JSON `headers`. Tools, all mapped straight onto `BuddyActions`:

| Tool | Input | Effect |
|---|---|---|
| `go_to` | `{ x: number 0..100, run?: boolean }` | walks or runs there, returns on arrival |
| `set_mood` | `{ mood }` | sets mood, plays emote |
| `emote` | `{ kind }` | one-shot reaction, including `hop` |
| `sleep`, `wake` | none | force sleep or wake |
| `get_state` | none | returns `BuddyState` |

`--mcp-config` value:

```json
{ "mcpServers": { "buddy": { "type": "http",
    "url": "http://127.0.0.1:PORT/mcp",
    "headers": { "Authorization": "Bearer TOKEN" } } } }
```

### 11.6 Permission flow

Reads, globs, and greps are pre-approved by `--allowedTools`, as are the buddy
tools. Everything else goes through a `PermissionRequest` hook injected with
`--settings`:

```json
{ "hooks": { "PermissionRequest": [ { "hooks": [ {
    "type": "command",
    "command": "node \"<app>/out/hook/permission-hook.cjs\" --port PORT --token TOKEN",
    "timeout": 130 } ] } ] } }
```

`permission-hook.cjs` reads the hook input JSON from stdin, POSTs it to
`http://127.0.0.1:PORT/permission` with the bearer token, waits up to 120 seconds
for `{ decision: 'allow' | 'deny', reason }`, and prints:

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
                          "decision": "allow", "decisionReason": "operator sanctioned" } }
```

Any failure, timeout, or unreachable server prints a deny. Main turns each POST
into a permission card in the hologram, and the user's answer resolves the
pending HTTP request. If the panel is closed when a request arrives, it opens.
The card shows the pack's `permissionAsk` line, the tool name, and the salient
input (command, file path).

Verification task in the plan: confirm inline `--settings` JSON hooks fire in
2.1.220. Fallback if not: write the same JSON to a temp file per launch and pass
its path.

### 11.7 Sessions and workspace

- One session per app run until `/new`. The session id is kept in memory and
  shown in the status row. Session files live where Claude Code keeps them.
- Workspace defaults to `C:\repo`, configurable, changed with `/cd`. Extra
  directories from config are passed with `--add-dir`.
- The persona prompt is passed on every turn; it is cheap and keeps behavior
  stable across resumes.

### 11.8 Later optimization, not in slice 1

A long-lived process using `--input-format stream-json` would remove per-turn
startup latency. Its stdin schema is not in the public docs, so it is deferred
until a probe confirms the message shape.

## 12. Config

`config.json` in Electron's `userData` directory, created with defaults on first
run:

```json
{ "pack": "packs/mechanicus",
  "cliPath": "%USERPROFILE%\\.local\\bin\\claude.exe",
  "workspace": "C:\\repo",
  "extraDirs": [],
  "model": null,
  "allowedTools": ["Read", "Glob", "Grep", "mcp__buddy__*"],
  "permissionTimeoutSec": 120,
  "wanderIntervalSec": [8, 30],
  "sleepAfterMin": 10,
  "scale": 1.0 }
```

`config.scale` multiplies `manifest.scale`. The pack sets its natural size; the
user adjusts it without editing the pack.

## 13. IPC contract

Main to overlay: `pack:loaded { atlasUrl, animations, frameSize, scale }`,
`buddy:state { BuddyState, animation, speed }`.
Overlay to main: `overlay:hover { over: boolean }`, `overlay:click`,
`overlay:contextMenu { x, y }`, `overlay:arrived`, `overlay:oneShotDone`.

Main to hologram: `chat:delta { text }`, `chat:activity { id, label, done }`,
`chat:done { error? }`, `chat:permission { id, toolName, summary, line }`,
`chat:status { model, workspace, session, error? }`, `theme { ...manifest.theme }`,
`chat:system { text }` for canned lines.
Hologram to main: `chat:prompt { text }`, `chat:permissionAnswer { id, allow }`,
`chat:close`, `chat:stop`.

All channels are typed in `src/shared/ipc.ts` and exposed through a preload
bridge; renderers have no Node access.

## 14. Error handling

- Renderer exceptions are caught at the top level, logged to a file under
  `userData/logs`, and never close a window.
- Pack validation failure: tray balloon with the first error, placeholder
  rectangle in the overlay, hologram still opens and reports the error.
- CLI missing, auth failure, non-zero exit: shown in the status row with the
  pack's line plus the raw detail, and the turn ends cleanly.
- Permission server unreachable from the hook: the hook denies; the status row
  notes a denied tool.
- Display metrics change: both windows re-bound; a hologram that cannot be
  anchored closes.
- Any command targeting out of range is clamped, never rejected.

## 15. Testing

- **Vitest, state machine**: wander targets within bounds; walk versus run by
  distance; emotes return to the prior activity; emotes queue behind movement;
  sleep after quiet and wake on interaction; mood independent of activity;
  projecting pauses wander; fallbacks when a pack omits animations.
- **Vitest, pack loader**: valid pack loads; missing required animation fails;
  fallbacks resolve; manifest lines default to empty arrays.
- **Vitest, stream parser**: fixture files of real stream-json lines for a plain
  text turn, a tool-using turn, an error result, and a truncated stream.
- **Vitest, command parser**: every slash command and its error cases.
- **Python, atlas builder**: on the real sheet every band yields its expected
  count and every frame shares the baseline.
- **Fake CLI**: `test/fake-claude.cjs` accepts the same flags, reads stdin, and
  emits scripted stream-json. Scenarios: streamed text; a `tool_use` of `Read`
  with a later `tool_result`; a real JSON-RPC `tools/call` to the buddy MCP
  endpoint for `set_mood`; spawning the permission hook with a fake Bash request
  and honoring its decision. No quota is spent.
- **Playwright Electron**: launch with the fake CLI; overlay bounds equal the work
  area strip; click opens the hologram; `/goto 80` ends with `x` at 0.8; Escape
  closes; a scripted permission request shows the card and Deny resolves it.
- **Manual checklist**: click-through on Windows 11 with a window underneath;
  hover flips interactivity; DPI change; a real CLI turn on demand.

## 16. Project layout

```
mechanicus-buddy/
  package.json          electron, electron-vite, typescript, vitest, zod,
                        @modelcontextprotocol/sdk, marked, dompurify, highlight.js,
                        @playwright/test
  src/shared/           ipc.ts, types.ts
  src/main/             index.ts, windows.ts, tray.ts, ipc.ts, config.ts,
                        pack.ts, buddy.ts, actions.ts, server.ts (mcp + permission),
                        brain/types.ts, brain/echo.ts, brain/claude-cli.ts,
                        brain/stream.ts
  src/hook/             permission-hook.cjs
  src/preload/          index.ts
  src/renderer/overlay/ index.html, main.ts, sprite.ts, motion.ts, hittest.ts
  src/renderer/hologram/ index.html, main.ts, panel.ts, markdown.ts, commands.ts
  packs/mechanicus/     manifest.json, persona.md, atlas.png, atlas.json, animations.json
  tools/                clean.py, slice.py, rows.json, overrides.json, upscale.ps1
  raw/                  sheet.png
  test/                 fake-claude.cjs, fixtures/
  docs/superpowers/specs/
```

## 17. Risks and open items

1. Inline `--settings` hooks in 2.1.220: verify first; temp-file fallback ready.
2. `claude auth status` reported logged out inside a sandboxed session while
   `.credentials.json` exists. The app treats auth as unknown until the first
   turn and surfaces failures with the `authError` line.
3. Click-through on Windows with transparent Electron windows has version-specific
   quirks. Pin the Electron version and keep a manual check in the plan.
4. Real-ESRGAN may soften small glyphs like the "!!" and "?" fragments. Check the
   upscaled props visually; fall back to nearest-neighbor 2x for those if needed.
5. Quota: the buddy shares the user's Pro or Max limits with interactive use.

## 18. Future slices

- Slice 2, voice: Chatterbox Turbo served locally, `manifest.voice` points at a
  reference clip; replies are spoken as they stream; a mouth or eye glow reacts.
- Long-lived CLI process (11.8).
- Multiple monitors, drag, perching.
- Additional packs; a pack picker in the tray.

## 19. Amendment 2026-09-04: persona applies to readback, not to displayed text

Decision (Peter): the hologram shows Claude Code's reply text unaltered by the
persona. The persona is applied only when the user clicks a per-message speaker
button: a one-shot, cheap-model call (`claude -p --model haiku`, no tools, no
session, persona prompt plus "summarize this reply concisely in character")
produces a short in-character summary that is spoken by the voice layer and not
displayed. Consequences:

- Plan B: `--append-system-prompt` carries only the body-tools note, not the
  persona text. `persona.md` becomes the voice persona.
- Slice 2 (voice): the speaker button, the summarizer, and the TTS call are one
  feature. Summaries are cached per message. Cost is one Haiku turn per click.
- Canned pack lines (greeting, permission card, errors) remain in character; they
  never come from Claude.

## 20. Amendment 2026-09-04: projection cone from the servo skull

The hologram is cast from the character's floating servo skull. Each atlas frame carries
an optional `origin: [ox, oy]` (crop-local) found by the pipeline as the highest
bone-colored blob and overridable per frame in the annotator. The overlay reports the
origin's screen position while the panel is open; main converts it to hologram-window
coordinates. The hologram window spans from above the panel down into the character's
upper body, is click-through outside the panel, and draws a canvas cone of jittered
light lines from the origin to the panel edge in the pack's accent color, ported from
the user's portfolio `ProjectionOverlay.js` (flicker, distance fade, scan pulse,
interior mask, source-oriented border glow, source glow). Plan:
`docs/superpowers/plans/2026-09-04-projection-cone.md`.
