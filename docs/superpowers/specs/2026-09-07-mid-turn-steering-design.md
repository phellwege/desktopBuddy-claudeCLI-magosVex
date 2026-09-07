# Mid-rite steering design

Date: 2026-09-07. Status: approach A approved by Peter (silent steering, no
acknowledgement line).

## 1. Problem

While a turn is running, `ChatController.prompt` posts "Still working. Use /stop to
abort the current rite." and drops the text. During a ninety-minute physics rite on
2026-09-06 Peter asked the magos for a status report twice and neither message reached
him. The interactive CLI behaves differently: a message typed mid-turn reaches the model
at its next tool boundary, it answers in a sentence and carries on. The buddy should do
the same, and stay a single conversation while doing it.

## 2. Measured CLI behaviour

The docs do not specify what happens to a stdin message during a running turn (checked
2026-09-07: the streaming-input page says only that queued messages "process
sequentially"). Measured against the installed claude.exe (2.1.258) launched as
`-p --input-format stream-json --output-format stream-json --verbose`, with user lines
of the shape `{"type":"user","message":{"role":"user","content":"..."}}`:

1. A message written while a tool loop is running is injected at the next tool
   boundary. The model answered it in one sentence, ran its remaining tool, and finished
   the original task. One `result` line; `num_turns` counted the extra assistant message.
2. A message written during the final text (no boundary left), or after a `result`
   while stdin is still open, runs as the next turn in the same process, with its own
   `system init` and `result` lines. That follow-on `init` arrives within tens of
   milliseconds of the previous `result`.
3. Closing stdin the instant the first `result` arrives does not lose a queued message:
   the process drains it, emits its `result`, and exits about half a second later.
4. With stdin held open the process never exits on its own after a `result`; it waits
   for more input.
5. A steered user message is not echoed on stdout. The only `user` lines on stdout are
   tool results.

The buddy must therefore treat a `result` line as a turn boundary rather than the end of
the child, and must close stdin itself.

The readback layer spawns its own CLI with plain text on stdin and no stream-json input
flag; it is untouched by this design, and the fake's readback branch (keyed on argv) stays
as it is.

## 3. Decision: hold stdin open for the life of the turn (approach A)

One child process per turn and `--resume` between turns, exactly as today. The only
lifecycle change is inside the turn: the prompt goes down stdin as a stream-json user
line and stdin stays open until the first `result`. A new brain method `steer(text)`
writes a further user line to the live child. The panel already shows the operator's
bubble before the text reaches main, and, like the CLI, nothing else is posted.

Rejected, and why, so nobody re-proposes them:

- B, one long-lived child per session. Fewer spawns, but `/new`, `/cd`, `/model`,
  `/stop` and the stale-resume retry all become child-lifecycle management, and a wedged
  child takes the whole session with it.
- C, a side process for status questions (a forked session with read-only tools). Its
  answers would not be in the working session's memory, and two CLIs would write one
  transcript.

## 4. Brain (`src/main/brain/claude-cli.ts`)

### 4.1 Arguments and the prompt

`buildArgs` adds `--input-format stream-json` immediately after
`--output-format stream-json`. `respond` writes
`JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n'`
to stdin and does not end it.

### 4.2 `steer(text): boolean`

Writes one more user line, same shape, to the current child's stdin. Returns `true` when
a child is alive and its stdin is writable, `false` otherwise (no child, or stdin already
ended because the turn is draining). Never throws: the existing stdin error listener
swallows a write to a dead child, and a `false` return is the signal the chat controller
acts on.

### 4.3 Turn end

Today the first `result` line is terminal: the brain yields `done` and returns. With
stdin open that would leave the child waiting forever (measurement 4), so:

- On the first `result`: end stdin, record the result's session id and error, and keep
  reading. The child now either exits (nothing queued) or runs the queued steer as a
  follow-on turn (measurement 2 and 3).
- Lines after that first `result` belong to the same reply: text deltas keep streaming
  into the same bubble, activities are forwarded, a further `init` or `result` updates the
  recorded session id and error.
- `done` is yielded once, when the child closes, carrying the last result's session id
  (falling back to the init's) and the last result's error, if any.
- Grace: a CLI that holds the process open after a `result` (the headless mode waits on
  background work, up to ten minutes idle) must not hold the turn open with it. After
  stdin is ended, if no follow-on `init` has been seen and the child has not closed within
  `drainGraceMs` (a dep, default 1500 ms), the brain yields `done` and detaches, leaving
  the child to finish on its own exactly as today's code does. Anything the detached
  child prints afterwards is discarded. A follow-on `init` seen inside the grace restarts
  the clock at that turn's `result`.
- `stop()` is unchanged: it kills the process tree, and any queued steer dies with it. The
  `stopped` done event is unchanged.
- Mood handling is unchanged: `thinking` on the first activity, `restore` in `finally`.

Known costs and limits:

1. `done` now fires at child close or after the grace, so the reply settles roughly half a
   second later than before (the measured post-EOF exit), and readback starts then;
   streamed text is unaffected. If the pause is noticeable the knob is `DRAIN_GRACE_MS`.
2. The last result's error wins: an errored follow-on turn marks the whole reply errored
   (which suppresses readback), and a successful follow-on turn hides a first-turn error.
3. A follow-on turn whose `init` arrives later than the grace after the previous result is
   silently lost (the brain has detached); measured latency is tens of milliseconds, so
   this is a limit, not an expected path.
4. `/new` and `/cd` do not stop a running turn; a message typed after them steers the
   still-running child in the old session and workspace, whose id is then discarded.
5. The grace path detaches without killing; the next turn may `--resume` a session the
   detached child is still writing to. Same shape as before this change, slightly widened.

### 4.4 Interface

`Brain` gains `steer?(text: string): boolean`. Optional, so the echo brain and every
test fake keep compiling; the echo brain does not implement it.

## 5. Chat controller (`src/main/chat.ts`)

The busy branch of `prompt` becomes: if the brain has `steer` and it returns `true`,
return silently; otherwise post the existing "Still working" line. Nothing else changes.
The reply accumulator, expression, readback and the single `done` all cover the whole
drained turn, so a steered answer is read back with the rest of the reply. Slash commands
during a turn keep running immediately, as today.

## 6. Stream parser (`src/main/brain/stream.ts`)

No change expected. A second `system init` mid-stream parses to another `init` output;
`result` parses to `done`, which the brain now treats as a boundary. Unknown line types
(`task_started`, `task_notification`, `rate_limit_event`, `post_turn_summary`) must keep
parsing to `ignore`; the plan verifies this against the parser's tests.

## 7. Tests

`test/fake-claude.cjs` today drains stdin to EOF before it emits a line, which deadlocks
against a brain that holds stdin open. It changes to read line-delimited JSON user
messages: the first line is the prompt and starts the scenario; later lines are steers,
recorded so a scenario can react to them; EOF is observed separately. Every existing
scenario keeps its output. Two scenarios are added: `steer-drain` (first result, then on
EOF a second `init`, text and `result` with session id `s2`, then exit) and
`linger` (a result, then the process stays alive `FAKE_CLAUDE_LINGER_MS` ms, default 1500,
and exits on its own; it never consults stdin).

`src/main/brain/claude-cli.test.ts`, driven by those scenarios:

- the two exact-flag-list tests gain `--input-format stream-json`;
- the prompt reaches the fake as one JSON user line and stdin is still open afterwards;
- `steer` during a turn writes a second line the fake sees, and returns `true`;
- after the fake's first `result` the brain ends stdin; a fake that then emits a second
  `init`, text and `result` has that text yielded into the same turn, followed by exactly
  one `done` with the second result's session id;
- a fake that stays alive after its `result` with no follow-on `init` yields `done` after
  the grace, with the child detached;
- `steer` with no child returns `false`; `steer` after stdin ended returns `false`;
- `stop()` mid-turn is unchanged.

`src/main/chat.test.ts`: a prompt while busy calls `brain.steer` and posts no system line;
a brain without `steer`, or whose `steer` returns `false`, gets the refusal line; readback
receives the combined reply. `echo.test.ts` is unchanged.

`e2e/brain.spec.ts` runs the app against the fake CLI; the fake must accept stream-json
input for those flows to keep passing, and the suite is run before the branch is offered
for merge.

## 8. Out of scope

A long-lived child per session, acknowledgement lines, showing queued messages in the
panel, interrupt control messages, and the smoke script.
