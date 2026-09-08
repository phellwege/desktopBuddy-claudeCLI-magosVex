# Terminal hand-off design (`/cli`)

Date: 2026-09-07. Status: approved by Peter (plain Claude Code in the terminal, no buddy
tools; `/cli` plus a right-click menu item). Revised 2026-09-08 (Peter): a fresh,
independent instance; no session sharing, no stand-down.

## 1. Problem

The panel is a thin client over the CLI's print mode, so every CLI feature it does not
re-implement is out of reach: image paste, plan mode, `@` mentions, the CLI's own
permission prompts, and whatever ships next. Peter's direction (2026-09-07) is to ride
the CLI's features instead of rebuilding them. The cheapest form is a hand-off: open a
brand-new, independent Claude Code in a terminal window in the workspace, leaving the
panel free to keep working the whole time. The embedded CLI tab is the sibling
sub-project with its own spec; the image attachments spec is the other.

## 2. Measured behaviour

Against claude.exe 2.1.261 and Electron 44.1.1 on Windows 11, 2026-09-07:

1. From the first version, kept for the record: `--resume <id>` keeps the id. A session
   created with `--session-id X` and resumed with `--resume X` reports `session_id` X in
   its result and remembers the earlier turn.
2. A console program spawned as a direct child of the Electron main process, which has
   no console of its own, gets none either: with `stdio: 'ignore'` its stdin is NUL
   (`timeout.exe` reports "Input redirection is not supported"), and redirecting from
   `CON` fails with "Access is denied". The interactive CLI cannot run that way.
3. From the first version, kept for the record: `cmd.exe /c start "" /wait <program>`
   from Electron opens a real console (`timeout.exe` counted down in it) and the
   wrapper's exit is the program's exit: 2.6 s for a 3 s countdown, the balance being the
   window's own teardown. PowerShell's `Start-Process -Wait` behaves the same at about a
   second more startup.
4. The default-terminal delegation in this machine's registry names Windows Terminal, so
   the window `start` opens is a Windows Terminal window; without it, conhost. Nothing
   here depends on which.
5. A GNU `timeout` from Git on the PATH shadows `timeout.exe`; the measurements above
   were taken with System32 first on the PATH. The hand-off itself runs the CLI by full
   path and is not affected.

## 3. Decision

`/cli`, and the menu item, open a brand-new, independent Claude Code in a new console
window in the workspace. The panel carries on the whole time: nothing here waits for the
window, tracks it, or stands the panel down while it is open, and quitting the buddy
leaves the window running.

Rejected:

- Sharing the panel's own session with the terminal, which the first version of this
  design did (closing the window handed control back to the panel, and the panel stood
  down while it was open). Peter's call (2026-09-08) is a fresh instance instead: a
  terminal is normally its own thing, and the panel should never have to wait on it.
- The CLI as a direct child of the main process: measurement 2 above still holds, so the
  launch still goes through `cmd /c start`.
- Passing the buddy MCP config so he could move and pull faces from the terminal:
  Peter's call is plain Claude Code, and the local server admits one client at a time
  today, so it would also have needed the multi-client change the tab may bring.

## 4. Launcher (`src/main/handoff.ts`)

`buildHandoffCommand(cliPath, workspace)` returns the spawn triple: file `cmd.exe`, args
`['/c', 'start "Claude Code" /d "<workspace>" "<cliPath>"']`, verbatim true. The quotes
carry paths with spaces; a path containing a double quote is refused with a reason
rather than passed through. Nothing else goes on the command line: no session id, no MCP
config, no tool or permission flags, no model.

In the non-hook branch, `open` first checks that `cliPath` exists on disk and refuses
with `no Claude Code at <cliPath>` when it does not, rather than handing a missing path
to `cmd /c start`: that pops a "Windows cannot find ..." dialog that `windowsHide` buries,
leaving the detached wrapper alive behind it after the panel has already posted the
confirmation. The hook branch skips this check.

`Handoff.open(o)` spawns that command (or the `BUDDY_HANDOFF_CMD` test hook's argv in
place of it, not verbatim) with `{ cwd: o.workspace, env: childEnv(...), stdio: 'ignore',
windowsHide: true, windowsVerbatimArguments, detached: true }`, then calls `child.unref()`
at once and returns `{ ok: true }` or `{ ok: false, reason }`. A spawn error calls
`o.onError` with the error's message; nothing else is tracked, and every call to `open`
spawns a fresh window, never refusing on account of an earlier one. Measured on this
machine: a console `start` opens outlives the app whether or not the wrapper handed to
`spawn` is itself detached, so `detached: true` plus `unref()` is belt and braces rather
than load-bearing, and there is nothing left here to stop at quit.

## 5. Chat controller (`src/main/chat.ts`, `commands.ts`)

`parseCommand` gains `cli`, no arguments. `run('cli')` calls `ChatController.openCli()`,
which works at any time: mid-turn, right after another `/cli`, regardless of the session
id. There is no hand-off state left for it to be gated on.

- With no handoff dep (no CLI installed, or the echo brain): the pack's `cliMissing` line.
- With a handoff dep but a workspace that no longer exists: `no such directory:
  <workspace>` (the same wording `/cd` uses), and `handoff.open` is never called, so a
  vanished workspace cannot produce a confirmation followed by an async spawn error or a
  silent `start` failure.
- Otherwise: `handoff.open({ workspace, onError })`. A refusal to build the launch
  command, or a spawn error reported through `onError`, posts the pack's `error` line
  plus the reason, with the `sadness` face. Otherwise: `Opened Claude Code in a
  terminal.`

Nothing here touches settings, the session id, or a running turn: `/stop`, `/new`, `/cd`
and `/clear` behave exactly as they did before this design existed, since there is no
shared session left for `/cli` to protect them from. `ChatController.openCli()` exposes
the same path for the menu.

## 6. Menu (`src/main/index.ts`)

The right-click menu gains `Open in Claude Code`, calling `openCli`. It is always enabled;
the refusals above explain themselves in the panel. `index.ts` opens the panel first,
then calls `chat.openCli()`, so the confirmation or refusal line is on screen rather than
posted to a panel the operator has not opened.

## 7. Edge cases, documented rather than handled

- `/cd` inside the terminal does not move the panel's workspace: the two are independent
  conversations from the moment the window opens.
- `cmd` re-expands `%NAME%` inside the quoted paths before running `start`, so a workspace
  or CLI path containing a percent-delimited name opens elsewhere or fails. Both values
  are the operator's own (`/cd` insists the directory exists; `cliPath` is config), so
  this is data-only and documented, not guarded.

## 8. Tests

- `handoff.test.ts`: the command line for a plain path and a path with spaces; the quote
  refusal; the spawn call is detached, hidden, verbatim, stdio ignored, in the workspace,
  with the scrubbed env, and unrefs its child; a hook command replaces the launcher and is
  not verbatim; every `open` spawns a new window; a spawn error reaches `onError`; a
  refusal to build the command spawns nothing.
- `commands.test.ts`: `/cli` parses; `/cli anything` is an error.
- `chat.test.ts`: no handoff dep posts the cliMissing line; a plain `/cli` opens in the
  workspace, confirms, and changes nothing else; `/cli` works during a running turn and
  every time it is called; a refusal and a spawn error both post the error line with the
  reason and the `sadness` face; `openCli` is the same path the menu uses.
- `e2e/handoff.spec.ts`: with `BUDDY_HANDOFF_CMD` pointing at a node one-liner that writes
  a marker file holding its cwd, `/cli` posts the confirmation line, the marker proves the
  workspace, and the panel answers a prompt sent right after.
- Manual: `/cli` twice on this machine opens two Windows Terminal windows, each a fresh
  Claude Code in the workspace; quitting the buddy leaves both running.

## 9. README

The panel commands table gains `/cli`: open a fresh Claude Code in a terminal in the
workspace, independent of the panel. The menu item is mentioned beside it.

## 10. Out of scope

Sharing the panel's own session with the terminal (the first version's design); tracking
or closing the windows `/cli` opens; macOS (`open -a Terminal` and its own quoting); the
model override; and buddy tools in the terminal.
