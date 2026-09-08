# Terminal hand-off design (`/cli`)

Date: 2026-09-07. Status: approved by Peter (plain Claude Code in the terminal, no buddy
tools; `/cli` plus a right-click menu item).

## 1. Problem

The panel is a thin client over the CLI's print mode, so every CLI feature it does not
re-implement is out of reach: image paste, plan mode, `@` mentions, the CLI's own
permission prompts, and whatever ships next. Peter's direction (2026-09-07) is to ride
the CLI's features instead of rebuilding them. The cheapest form is a hand-off: open the
real CLI in a terminal window on the panel's own session, and pick the conversation back
up when the window closes. The embedded CLI tab is the sibling sub-project with its own
spec; the image attachments spec is the other.

## 2. Measured behaviour

Against claude.exe 2.1.261 and Electron 44.1.1 on Windows 11, 2026-09-07:

1. `--resume <id>` keeps the id. A session created with `--session-id X` and resumed with
   `--resume X` reports `session_id` X in its result and remembers the earlier turn.
2. A console program spawned as a direct child of the Electron main process, which has
   no console of its own, gets none either: with `stdio: 'ignore'` its stdin is NUL
   (`timeout.exe` reports "Input redirection is not supported"), and redirecting from
   `CON` fails with "Access is denied". The interactive CLI cannot run that way.
3. `cmd.exe /c start "" /wait <program>` from Electron opens a real console
   (`timeout.exe` counted down in it) and the wrapper's exit is the program's exit: 2.6 s
   for a 3 s countdown, the balance being the window's own teardown. PowerShell's
   `Start-Process -Wait` behaves the same at about a second more startup.
4. The default-terminal delegation in this machine's registry names Windows Terminal, so
   the window `start` opens is a Windows Terminal window; without it, conhost. Nothing
   here depends on which.
5. A GNU `timeout` from Git on the PATH shadows `timeout.exe`; the measurements above
   were taken with System32 first on the PATH. The hand-off itself runs the CLI by full
   path and is not affected.

## 3. Decision

`/cli`, and the menu item, run the CLI in a new console window through `start /wait` on
the panel's session, and the panel stands down until the window closes.

Rejected:

- `wt.exe` as the launcher: it returns at once, so the CLI's exit is not observable.
- The CLI as a direct child: measurement 2.
- Passing the buddy MCP config so he could move and pull faces from the terminal:
  Peter's call is plain Claude Code, and the local server admits one client at a time
  today, so it would also have needed the multi-client change the tab may bring.

## 4. Launcher (`src/main/handoff.ts`)

`buildHandoffCommand({ cliPath, workspace, sessionId, fresh })` returns the spawn
triple: file `cmd.exe`, args
`['/c', 'start "Claude Code" /wait /d "<workspace>" "<cliPath>" <flag> <id>']`, options
`{ windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore', cwd: workspace, env }`,
where `flag` is `--resume` for an existing id and `--session-id` for a minted one, and
`env` is `childEnv` from `brain/claude-cli.ts` (no `CLAUDECODE`, no `ANTHROPIC_API_KEY`).
The quotes carry paths with spaces; a path containing a double quote is refused with a
reason rather than passed through. Nothing else goes on the command line: no MCP config,
no tool or permission flags, no model.

`Handoff` holds the state: `start(d)` returns `{ ok: true }` or `{ ok: false, reason }`,
`active`, `stop()` kills the wrapper's process tree (the CLI is inside it), and `onExit`
fires once when the wrapper closes, which is the CLI's exit by measurement 3. A spawn
error fires `onExit` with the error's message. `spawn` is injectable, as in the brain. A
test hook `BUDDY_HANDOFF_CMD`, a JSON argv like `BUDDY_CLI_ARGS`, replaces the whole
launcher so the e2e suite never opens a console.

## 5. Chat controller (`src/main/chat.ts`, `commands.ts`)

`parseCommand` gains `cli`, no arguments. `run('cli')`:

- With no handoff dep (no CLI installed, or the echo brain): the pack's `cliMissing` line.
- While a turn is running: `Finish or /stop the current rite first.` Two CLI processes on
  one transcript is the case this whole design avoids.
- Otherwise: with no session id yet, mint one, store it through `settingsChanged` (which
  persists it to state.json), and launch with `--session-id`; else launch with
  `--resume`. Post `He is in the terminal. Close it to continue here.`

While the hand-off is active: a prompt gets the same stand-down line back and is neither
sent nor steered; `/new`, `/cd` and `/clear` get `Not while he is in the terminal.`, since
they would fork the session out from under the window; `/stop` ends the hand-off
(`Handoff.stop`) and posts the pack's stopped line; a second `/cli` gets
`Already in the terminal.`; body commands run as usual. On exit: `Back from the terminal.`
and a status refresh. The next panel turn resumes the same id, so the terminal's turns are
in his memory. Nothing from the terminal is replayed into the panel, and terminal turns get
no readback and no face. The session allow-list is untouched.

`ChatController.openCli()` exposes the same path for the menu; it opens the panel first
so the lines are seen.

## 6. Menu (`src/main/index.ts`)

The right-click menu gains `Open in Claude Code`, calling `openCli`. It is always enabled;
the refusals above explain themselves in the panel.

## 7. Edge cases, documented rather than handled

- Closing the window mid-turn kills the CLI; the transcript keeps what was flushed and the
  panel resumes it.
- `/clear` or a new session started inside the terminal leaves the panel's id pointing at
  the old conversation.
- `/cd` inside the terminal does not move the panel's workspace.
- A minted id whose window is closed before any turn has no transcript on disk. The next
  `/cli` checks for that transcript (`state.ts`'s `sessionTranscriptExists`, injected as
  `ChatController`'s `transcriptExists`) and, finding none, launches the same id fresh
  (`--session-id`) instead of resuming it; the id is kept, not re-minted, and settings are
  untouched. Without an injected checker the default treats every id as having a
  transcript, so nothing changes for a caller that never wires one in.

## 8. Tests

- `handoff.test.ts`: the command line for a plain path and a path with spaces; the quote
  refusal; `--resume` against `--session-id`; re-entry refusal; `onExit` from a fake child's
  close and from a spawn error; `stop` kills the fake's tree.
- `commands.test.ts`: `/cli` parses; `/cli anything` is an error.
- `chat.test.ts`: no handoff dep posts the cliMissing line; busy refusal; a null id is
  minted, persisted and passed as `--session-id`; an existing id is passed as `--resume`;
  the stand-down refusals for a prompt, `/new`, `/cd`, `/clear`; `/stop` ends it; the
  return line and status after exit; a second `/cli` is refused.
- `e2e/handoff.spec.ts`: with `BUDDY_HANDOFF_CMD` pointing at a node one-liner that lives
  800 ms, `/cli` posts the stand-down line, a prompt typed meanwhile gets it back, and the
  return line follows.
- Manual: `/cli` on this machine opens Windows Terminal with the CLI resumed on the panel's
  session; a turn typed there is known to the panel afterwards.

## 9. README

The panel commands table gains `/cli`: open the real Claude Code in a terminal on this
session; the panel waits until it closes. The menu item is mentioned beside it.

## 10. Out of scope

macOS (`open -a Terminal` and its own quoting), replaying terminal turns into the panel,
the model override, buddy tools in the terminal, and `/cli` during a running turn.
