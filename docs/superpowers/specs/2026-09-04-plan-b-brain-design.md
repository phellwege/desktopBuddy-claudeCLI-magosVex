# Plan B: the Claude Code brain, Design

Date: 2026-09-04
Status: approved in conversation
Owner: Peter
Builds on: `2026-09-03-mechanicus-buddy-design.md` sections 11, 13, 14, 19 (readback), 20 (cone).

## 1. Goal

Replace the echo brain with Claude Code running on the user's subscription through the
locally installed CLI, so the hologram answers real questions, sees the user's files
through Claude Code's own tools, moves and emotes the character through a small tool
set, and asks the user before running anything beyond reading. Displayed text is
Claude Code's output unaltered; the persona applies only to the future spoken readback
(section 19 of the main spec), which is not part of this plan.

Also in scope, because a model will now drive him: two carry-forward prerequisites, a
fix that makes typed and tool-driven emotes visible while the panel is open, and a
per-message expression face in the chat window.

## 2. Non-goals

- Voice, the speaker button, and the in-character summary (voice slice).
- A long-lived multi-turn CLI process (per-turn spawn with resume stays).
- Multiple monitors, packaging, start at login.
- Any Anthropic API key. The brain uses the CLI's subscription login.

## 3. Projecting rule change (spec 8 amendment)

While the panel is open (`projecting`):
- One-shot emotes play and return to the `project` pose when they finish. This covers
  `/emote`, `emote()` from Claude's tool, and the emote that a mood change triggers.
- `thinking` still replaces the held pose while a tool runs.
- `/sleep` typed in the panel closes the panel, then sleeps. `sleep()` from a tool does
  the same.

Every slash command appends a one-line confirmation to the log: the pack's `stopped`
line for `/stop`, and short neutral lines otherwise ("moving to 20%", "mood: happy",
"emote: alarmed", "sleeping", "awake", "new session", "workspace: C:\foo",
"model: sonnet").

## 4. Expression faces in the chat window

The pack's `animations.json` gains:

```json
"faces": { "neutral": "faces_0", "happy": "faces_1", "disbelief": "faces_2",
           "irritation": "faces_3", "anger": "faces_4", "love": "faces_6",
           "sadness": "faces_7", "cringe": "faces_8", "begging": "faces_9" }
```

Expression names are fixed by the app: `neutral | happy | disbelief | irritation |
anger | love | sadness | cringe | begging`. A pack may omit any; missing ones fall back
to `neutral`, and a pack with no `faces` block shows no avatar.

- Every message bubble from him carries the expression chosen for that message, drawn
  from the atlas on a small canvas inside the bubble, left of the reply text, about 56 px
  tall. It is rendered as a hologram in the style of the portfolio's planets: the frame
  tinted with the pack's accent color, translucent with a slow flicker (opacity around
  0.7 plus two small sine terms), and horizontal scanlines over it. There is no avatar in
  the title bar. Old messages never change.
- Claude chooses per reply with the `set_expression` tool (one call per reply; the tools
  note says love is reserved for a genuinely brilliant idea and should almost never
  appear). No call means neutral.
- App-posted lines use fixed faces: greeting neutral, permission card begging, denied
  anger, errors and auth or CLI failures sadness, everything else neutral.
- The echo brain picks neutral, except a random one in ten replies gets happy, so the
  path is exercised offline.

Mood (`calm | happy | thinking | confused | alarmed`) stays the body's axis and no
longer implies a face.

## 5. Prerequisites landed first

- **Arrival timeout.** `Actions.goTo` resolves on the overlay's arrival event today; if
  the overlay is hidden or never reports, the promise hangs and the wander scheduler
  stays stuck in `walking`. Main starts a timer per commanded move of
  `distance / speed + 2 s`; on expiry it calls `buddy.arrived()` itself and logs one
  line. Unit-tested with fake timers.
- **Navigation block.** The hologram window sets `will-navigate` to `preventDefault`
  and `setWindowOpenHandler` to deny, so sanitized markdown links cannot navigate the
  panel or open windows. Links render as plain text with the URL, not as anchors.

## 6. The brain

### 6.1 ClaudeCliBrain, one process per turn

`respond(prompt, ctx)` spawns `config.cliPath` with:

```
-p --output-format stream-json --include-partial-messages --verbose
--setting-sources project      (the user's own hooks and plugins stay out of his turns;
                                `--bare` is not an option, it drops the subscription login)
--session-id <uuid>            (first turn)   |   --resume <uuid>   (later turns)
--append-system-prompt <tools note>
--mcp-config <inline JSON: buddy http server with bearer token>
--strict-mcp-config
--allowedTools <config.allowedTools joined by space>
--permission-mode manual
--permission-prompt-tool mcp__buddy__permission_prompt
--model <config.model>          (only when set)
--add-dir <config.extraDirs>    (only when set)
```

`cwd` is the workspace; the prompt is written to stdin, then stdin is closed. The child
environment is the parent's minus `CLAUDECODE` and `ANTHROPIC_API_KEY`. `stop()` kills
the child; the session stays resumable. Only one turn runs at a time (the controller
already enforces this).

The tools note (no persona):

> You are a desktop assistant with a small animated body on the user's screen. Tools:
> go_to moves the body to a percentage across the screen; set_mood changes its body
> language (calm, happy, thinking, confused, alarmed); emote plays a one-off reaction;
> sleep and wake; get_state reads its state; set_expression picks the face shown next to
> this reply (neutral, happy, disbelief, irritation, anger, love, sadness, cringe,
> begging; love only for a genuinely brilliant idea, almost never). Call set_expression
> at most once per reply. Do not narrate tool use. Keep replies concise unless asked.

### 6.2 Stream parsing (pure module)

`parseStreamLine(line) -> BrainEvent[]` handles: `system` `init` (session id, model),
`stream_event` text deltas (`text`), `assistant` messages with `tool_use` blocks
(`activity` rows labeled from tool name and input: file path, pattern, or command,
truncated to 80 chars; buddy tools produce no row), `user` messages with `tool_result`
(`activity` done), and `result` (`done` with session id, and `error` when `is_error` or
`subtype` is not `success`). Unknown types are ignored; malformed lines are logged.

Process handling: exit without a `result` yields `done` with an error naming the exit
code and the last five stderr lines; spawn `ENOENT` yields `done` with the pack's
`cliMissing` line; an error mentioning authentication, login, or `not logged in` maps
to the pack's `authError` line. The first `activity` of a turn sets mood `thinking`;
`done` restores the prior mood unless a tool changed it during the turn.

### 6.3 Buddy MCP server

Hosted in main with `@modelcontextprotocol/sdk` over Streamable HTTP at
`http://127.0.0.1:<port>/mcp`, bound to 127.0.0.1, port chosen at launch, bearer token
generated at launch and required on every request. Tools, each returning a short text
result:

| Tool | Input | Effect |
|---|---|---|
| `go_to` | `{ x: 0..100, run?: boolean }` | `actions.goTo`, returns after arrival or the arrival timeout |
| `set_mood` | `{ mood }` | `actions.setMood` |
| `emote` | `{ kind: happy, thinking, confused, alarmed, look, hop }` | `actions.emote`, returns when it finishes |
| `sleep`, `wake` | none | `actions.sleep` (closes the panel first), `actions.wake` |
| `get_state` | none | `actions.getState()` as JSON |
| `set_expression` | `{ expression }` | sets the expression stamped on the current reply |
| `permission_prompt` | `{ tool_name, input, tool_use_id }` | the CLI's permission prompt; shows the card and returns allow or deny (6.4) |

### 6.4 Permission flow (amended 2026-09-04, evening)

Verified against the installed CLI (2.1.220): `PermissionRequest` hooks never run in
print mode, whether given inline through `--settings` or from a settings file; a tool
that would prompt is auto-denied before any hook. Session hooks from the user's own
settings do run. The documented headless mechanism works: with
`--permission-prompt-tool mcp__buddy__permission_prompt` the CLI calls that tool on the
buddy MCP server with `{ tool_name, input, tool_use_id }` and honors a text result of
`{"behavior":"allow","updatedInput":<input>}` or `{"behavior":"deny","message":"..."}`.

So the flow is: the buddy MCP server exposes `permission_prompt`; main turns each call
into the hologram's permission card (opening the panel if closed), with the pack's
`permissionAsk` line, the tool name, and the salient input; the user's Allow or Deny
resolves the call; a timeout of `permissionTimeoutSec` denies, dismisses the card, and
posts one status line. Reads, globs, greps, and buddy tools never prompt because they
are in `allowedTools`. There is no hook script, no `--settings` argument, and no
`/permission` HTTP endpoint. Verified 2026-09-04 against CLI 2.1.220: allow with
`updatedInput` writes the file, deny leaves it unwritten, `mcp__buddy__*` in
`--allowedTools` lets buddy tools run without a prompt, and `--setting-sources project`
keeps the user's plugin hooks out of the stream while the login still works.

The former hook design (a `PermissionRequest` hook posting to `POST /permission`) is
withdrawn. Cards show one at a time: a request arriving while a card is up waits its turn;
if the server's timeout expires it first, it is denied without ever showing a card.

### 6.4.1 Permission mode and session allows (added 2026-09-05, Peter's call)

Asking on every edit was too much. Two changes:

- `config.permissionMode` is `acceptEdits` (default) or `manual`, passed to the CLI as
  `--permission-mode`. With `acceptEdits` the CLI approves file edits inside the workspace
  on its own; shell commands and anything outside the workspace still come through the
  permission tool. `manual` restores the old behavior.
- The permission card gets a third button, "Allow this session". It answers the request
  as allowed and remembers the tool name (`Bash`, `WebFetch`, whatever asked) in a
  session allow-list held in main; later requests for that tool name are answered
  allowed without a card and without a line. The list clears on `/new` and `/cd` (a new
  CLI session) and on app exit. Deny and the timeout behave as before.

### 6.5 Sessions, workspace, config

One session per app run until `/new`. `/cd <path>` changes the workspace for the next
session; `/model <name>` sets the model for the next turn. Config fields `cliPath`,
`workspace`, `extraDirs`, `model`, `allowedTools`, `permissionTimeoutSec` become live
and are validated at load (bad types fall back to defaults with a logged line). Startup
runs `claude auth status` once and shows its result in the status row as informational
text; a failing first turn shows the `authError` line with the raw detail.

## 7. Error handling

- Child spawn failure, non-zero exit, malformed stream: the turn ends cleanly with a
  system line carrying the pack's `error` or `cliMissing` line plus the raw detail; the
  app never crashes.
- Permission server unreachable from the hook: the hook denies; the status row notes
  the denial.
- `/stop` during a turn kills the child and posts the `stopped` line; the session id is
  kept.
- The MCP server rejects requests without the launch token with 401.

## 8. Testing

- Unit: stream parser against fixture files (text turn, tool turn, error result,
  truncated stream, auth error); label builder; the tools note builder; arrival timeout
  with fake timers; navigation block handlers; the expression map and fallback.
- Fake CLI (`test/fake-claude.cjs`): accepts the real flags, reads stdin, and emits
  scripted stream-json for scenarios: streamed text; a `Read` tool with a later result;
  a real JSON-RPC `tools/call` of `set_mood` and `set_expression` against the live MCP
  endpoint; spawning the real hook script with a fake `Bash` request and honoring the
  decision; an auth error; an exit without a result. No quota is spent.
- HTTP tests for the MCP server (token required, each tool) and the permission endpoint
  (resolve, timeout).
- Playwright e2e extended: with the fake CLI, a prompt streams into the panel, an
  activity row appears and completes, a permission card appears and Deny resolves it,
  and a reply carries an expression face.
- One real-CLI smoke test behind `npm run smoke:claude`, run only on demand.

## 9. Config additions

`permissionMode: "acceptEdits" | "manual"`, default `acceptEdits` (6.4.1). Existing fields
become live. `allowedTools` default stays `["Read", "Glob", "Grep", "mcp__buddy__*"]`.
