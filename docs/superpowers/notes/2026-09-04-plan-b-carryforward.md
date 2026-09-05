# Plan B carry-forward

Date: 2026-09-04 (evening)
Branch: `plan-b-brain`, seven tasks plus two fix rounds; see the spec's amended section 6.4
for the permission design change made after verification against the installed CLI.

## Verified against the real CLI (2.1.220), do not re-derive

- The full per-turn argv from `buildArgs` spawns, streams, and returns a result; the buddy
  MCP server shows `connected` in the init line.
- `PermissionRequest` hooks never fire in print mode (inline `--settings` and a settings
  file both tested). The permission-prompt MCP tool works: allow with `updatedInput` wrote
  a file, deny left it unwritten.
- `--setting-sources project` keeps the user's plugin hooks out of the stream and keeps
  the subscription login. `--bare` drops the login; never use it.
- `mcp__buddy__*` in `--allowedTools` lets buddy tools run without a prompt.
- Claude Code runs its own safe-command list without asking (for example `echo`, `ls`),
  so some Bash calls never show the card. That is the CLI's policy, not a bug here.

## Deferred, small

- `chat:stop` IPC channel is wired end to end but no renderer control sends it (the
  typed `/stop` command is the only path). Either add a Stop button to the panel or drop
  the channel.
- `scripts/smoke-claude.mjs` duplicates the flag list from `buildArgs` by hand; drift is
  caught only by eye. Consider building the script from `out/main` once packaging exists.
- Stream types `system/status`, `rate_limit_event`, `system/thinking_tokens`,
  `system/post_turn_summary` are ignored. A rate-limit notice in the status row would be
  a small win.
- Startup `claude auth status` shows raw text when the output is not JSON; the JSON path
  shows only `loggedIn`. The email and org in that JSON could be shown too.
- All main and renderer log lines land in one file named `renderer.log`; split by name.
- `before-quit` stops the child through `taskkill`; no job object, so a grandchild the
  CLI spawned (a long Bash command) can outlive the app.

## Deferred, larger

- Packaged builds (non-goal in the spec): `pack://` protocol paths, `userData`, and the
  `claude.exe` default path all assume the dev layout.
- Voice slice (spec section 19): speaker button, in-character readback, Chatterbox Turbo.
- Multi-monitor travel and drag: `2026-09-04-future-multi-monitor.md`.
- The other three faction packs in `raw/sheets/` (sprite pipeline is ready; annotation is
  the manual part).

## Dev-server hot reload of the hologram window (2026-09-05)

Editing a hologram renderer file while the app runs from `npm run dev` reloads that
window in place. Once that left main believing the panel was open while nothing showed,
so clicks on the body seemed dead and he sat frozen until a restart. Until the
hologram-ready handshake resyncs panel state (open or closed, hover flags, pending card),
make renderer edits in a worktree or restart the app right after.

## Landed later

Idle mutter thought bubbles (2026-09-05): after two minutes with no interaction, and every
two minutes after that until he falls asleep, a small thought bubble near his head shows a
random line from the pack's `idleMutter` set and fades out on its own. It never appears
while the panel is open, while asleep, mid-drag, or mid-journey, and it never counts as an
interaction itself (it does not delay sleep). The interval is `mutterIntervalMin` in
config.json (minutes, default 2; 0 disables mutters entirely).
