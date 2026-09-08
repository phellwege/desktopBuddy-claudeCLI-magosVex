# CLI tab design

Date: 2026-09-07. Status: approved by Peter (own session, panel widens and grows only
while the tab is active, build order attachments, then `/cli`, then this tab).

## 1. Problem

The panel re-implements the CLI piece by piece and will always trail it. Peter's direction
(2026-09-07): put the real, interactive Claude Code in the panel as a second tab, so every
feature the CLI ships is available without a buddy change. The tab is strictly the CLI: no
buddy tools, no readback, no faces. The hand-off spec (`/cli`) covers the real CLI on the
panel's own session in a terminal window; this tab runs its own conversation.

## 2. Measured behaviour

From the real electron.exe 44.1.1 on Windows 11, 2026-09-07:

1. node-pty 1.1.0's shipped `prebuilds/win32-x64` binaries load inside Electron 44
   (Node 24.19, N-API 10, ABI 149) with no rebuild and no Visual Studio, and drive a real
   ConPTY: a `cmd.exe` session echoed back and exited cleanly. The installer's promise of
   no dev tools holds.
2. `claude.exe` 2.1.261 started in an Electron-owned ConPTY (100 by 30,
   `TERM=xterm-256color`) produced its first output in 46 ms and rendered a full screen
   (the folder trust prompt for the scratch directory); `/exit` typed into the pty ended
   it.
3. xterm.js 6.0.0 ships `css/xterm.css` and a fit addon at 0.11.0; both are plain
   JavaScript, so the sandboxed renderer needs nothing new.

Alt handling is not measured: xterm.js sends ESC plus the key for Alt combinations on
Windows, and the CLI's Windows image-paste key is Alt+V, so the two should meet; the plan
verifies it by hand.

## 3. Decision

A `CLI` tab beside `Chat` in the panel's title bar. Main owns one `PtySession` running
the CLI in the current workspace; the renderer shows it in xterm.js and forwards keys.
While the tab is active the panel is 700 by 480 and the hologram window is placed for that
size; on the chat tab everything returns to 480 by 360.

Rejected: a separate window for the CLI (Peter asked for a tab); a `<webview>` of a web
terminal (a second web stack for the same pty); sharing the panel's session in the tab
(that is `/cli`, and it would stand the chat tab down for as long as the tab lived).

## 4. Main: `src/main/pty.ts`

`PtySession` wraps node-pty behind an injectable factory:

- `start({ file, args, cwd, env, cols, rows })`: refuses when running; returns
  `{ ok: true }` or `{ ok: false, reason }` (a spawn failure's message).
- `write(data)`, `resize(cols, rows)`, `kill()` (through the existing process-tree helper
  on the pty's pid, so the CLI's own children go with it), `onData(cb)`, `onExit(cb)`.
- `running`.

Program and environment: `file` is the configured `cliPath`, `args` empty, `cwd` the
panel's workspace at start time (a later `/cd` does not move a running session; a restart
uses the new workspace), `env` the brain's `childEnv` plus `TERM=xterm-256color` and
`COLORTERM=truecolor`. Started lazily on the first switch to the tab; one session at most;
restart is kill then start. `app.on('before-quit')` kills it. The test hook
`BUDDY_PTY_CMD`, a JSON argv like `BUDDY_CLI_ARGS`, replaces file and args.

node-pty is a runtime dependency (not dev), so electron-vite externalizes it the way it
does the MCP SDK; the plan checks the built `out/main/index.js` requires it rather than
inlining it. Its prebuilds ship in the package; nothing runs at install beyond `npm ci`.
The `require('node-pty')` itself lives inside `nodePtyFactory` and runs on the first pty
start, not at app launch, so a missing or broken native module cannot take down the whole
buddy for a feature that is optional.

## 5. IPC (`src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts`)

- `pty:start`, invoke, `{ cols, rows }` to `{ ok: true } | { error }`.
- `pty:input`, send, `{ data }`. `pty:resize`, send, `{ cols, rows }`. `pty:kill`, send.
- `pty:data`, event, `{ data }`. `pty:exit`, event, `{ code }`.
- `hologram:mode`, send, `{ cli: boolean }`: main re-places the window for that mode.
- `clipboard:write`, send, `{ text }`: copy on select, via Electron's clipboard in main.

Bridge: `ptyStart`, `ptyInput`, `ptyResize`, `ptyKill`, `onPtyData`, `onPtyExit`,
`setMode`, `writeClipboard`. Data crosses as strings, one IPC message per pty chunk.

## 6. Geometry (`src/main/geometry.ts`, `src/main/index.ts`)

`hologramBounds(wa, xFraction, charW, charH, panel = PANEL_SIZE)`; `CLI_PANEL_SIZE` is
`{ width: 700, height: 480 }`. The window width is the panel width plus the two cone
margins (940 in CLI mode), its top is `charTop - panel.height - PANEL_GAP`, clamped to the
work area exactly as today; on a display narrower than 940 the window still clamps to the
work area rather than shrinking the panel, so the CLI tab can crop against the screen edge
on a small or heavily scaled display, left as a known limitation. `placeHologram` reads
the current mode, which `hologram:mode`
sets; the mode also re-places at once. The overlay's origin translation is unchanged
because it works from the window's actual bounds.

## 7. Renderer (`src/renderer/hologram/`)

- Title bar: two tab buttons, `Chat` and `CLI`, left of the name; the status text stays.
  Ctrl+Tab switches. The active tab is renderer state; the panel reopens on the tab it was
  on (the window is hidden, not destroyed).
- `#cli`: hidden unless active; holds the xterm `Terminal` (DOM renderer, font from the
  pack's `--font` at 12 px, theme from the pack: panel background, `--text` foreground,
  `--accent` cursor, scrollback 5000) and the fit addon. On activation: `ptyStart` if not
  started, fit, `ptyResize`, focus. A resize observer on `#panel` refits and retargets
  the cone (`sizeCone`), which today only listens to window resizes.
- Wiring: `onPtyData` writes to the terminal; `terminal.onData` sends `ptyInput`;
  `terminal.onResize` sends `ptyResize`; a `mouseup` on `#cli` with a non-empty selection
  sends `writeClipboard` once the selection has ended, rather than on every change during
  the drag.
- Keys in the tab go to the CLI, Escape included, so the panel closes by clicking him or
  from the chat tab; Ctrl+Q still quits at the window level. Text paste is xterm's own
  Ctrl+V and Shift+Insert. Alt+V reaches the CLI as ESC v for its image paste.
- Exit: the terminal shows `[Claude Code exited, code N]  Enter to restart`; Enter or a
  click on that line restarts. The custom key handler swallows that Enter keystroke
  entirely (it never reaches the fresh session as input), since xterm fires its key event
  before the data event for the same keydown and the CR would otherwise land on the new
  CLI as an empty submit or an accept on its folder trust dialog. A start refusal shows
  its reason the same way.
- No CLI installed, or the echo brain: the tab shows the pack's `cliMissing` line and no
  terminal.
- A permission card arriving while the CLI tab is active switches the panel to the chat
  tab first, since `#permission` is hidden along with the rest of the chat tab's children
  while the CLI tab shows.
- `#panel.cli` sets 700 by 480; `setMode` is sent on every switch.

## 8. Tests

- `pty.test.ts` with a fake factory: file, args, cwd, `TERM` and `COLORTERM` in the env
  and no `CLAUDECODE`; write and resize pass through; exit fires once with the code; a
  second start while running is refused; restart after exit replaces the session; the
  hook replaces file and args; kill uses the tree helper.
- `geometry.test.ts`: `hologramBounds` with `CLI_PANEL_SIZE` gives width 940 and a higher
  top, clamps at the work-area top, and the default argument keeps every existing case.
- `ipc.test.ts` or `windows.test.ts`: `hologram:mode` re-places with the right size.
- `e2e/cli-tab.spec.ts`: `BUDDY_PTY_CMD` runs a node one-liner that prints `READY>` and
  echoes each line back as `echo:<line>`. Click the CLI tab: the panel is 700 wide and the
  window 940; `READY>` appears; type `hi` and Enter; `echo:hi` appears; click Chat: 480
  and 720 again; click CLI: `echo:hi` is still in the buffer.
- Manual: the real CLI in the tab in `C:\repo`, a question answered, and an Alt+V image
  paste from a snip.

## 9. README

The panel section describes the tabs: the CLI tab is the real Claude Code on its own
session in the workspace; Alt+V pastes an image there; `/cli` remains the way to put the
real CLI on the panel's session.

## 10. Out of scope

More than one CLI tab, the panel's session inside the tab, clickable links, font and
scrollback settings, a WebGL renderer, and macOS.
