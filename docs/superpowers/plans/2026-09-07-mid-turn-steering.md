# Mid-Rite Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A message typed while a rite is running reaches the running Claude Code turn instead of being dropped, so the magos can answer a status question mid-rite and carry on.

**Architecture:** The CLI brain keeps one child process per turn but sends the prompt as a stream-json user line and holds stdin open until the first `result`; a new `steer(text)` writes further user lines to the live child. After the first result the brain closes stdin and keeps reading, so a message the CLI queued as a follow-on turn drains into the same reply, with one `done` at process close (or after a short grace if the child lingers). The chat controller routes a busy-time prompt to `steer` and only falls back to the old refusal line when the brain cannot take it.

**Tech Stack:** TypeScript (strict), Electron main process, Node child_process, vitest (unit), Playwright (e2e), the fake CLI at `test/fake-claude.cjs`.

Spec: `docs/superpowers/specs/2026-09-07-mid-turn-steering-design.md`.

## Global Constraints

- Work in the worktree `C:\repo\mechanicus-buddy-steer` on branch `steer`. Never touch `C:\repo\mechanicus-buddy` (the running dev instance watches it). Never merge; Peter merges.
- No em dashes anywhere: code comments, test names, docs, commit messages. Use commas, colons or hyphens.
- Every commit: `git -c commit.gpgsign=false commit -q -F - <<'MSG' ... MSG` from the worktree, message ending with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The fake CLI must keep every existing scenario's output unchanged, and the readback branch (`--output-format json`, plain text on stdin) untouched.
- Flag order in `buildArgs` is asserted exactly by tests: `--input-format stream-json` goes immediately after `--output-format stream-json`.
- `Brain.steer` is optional on the interface; the echo brain does not implement it.
- Drain grace default 1500 ms, injectable through `ClaudeCliDeps.drainGraceMs`.
- Unit tests: `npx vitest run` (299 passing at baseline). Typecheck: `npm run typecheck`. E2E: `npm run test:e2e` (builds first; takes a few minutes).

---

## File structure

- `test/fake-claude.cjs` (modify): stdin becomes line-oriented (first line = prompt, later lines = steers, EOF tracked); two new scenarios `steer-drain` and `linger`; stdin destroyed when a scenario ends so nothing holds the process open.
- `src/main/brain/types.ts` (modify): `Brain` gains `steer?(text: string): boolean`.
- `src/main/brain/claude-cli.ts` (modify): `--input-format stream-json` in `buildArgs`; exported `userLine(text)`; `ClaudeCliDeps.drainGraceMs`; `respond` holds stdin open, ends it at the first result, drains, grace; `steer()`.
- `src/main/brain/claude-cli.test.ts` (modify): flag-list updates, `userLine` test, steer-drain test, linger test, steer-false tests.
- `src/main/chat.ts` (modify): busy branch of `prompt` tries `brain.steer` first.
- `src/main/chat.test.ts` (modify): steer tests, refusal fallback, combined readback guard.

---

### Task 1: Line-oriented fake CLI with the two new scenarios

**Files:**
- Modify: `test/fake-claude.cjs` (the `readStdin` helper, `main`, plus two new scenario functions)
- Test: the existing suites `src/main/brain/claude-cli.test.ts` and `src/main/brain/readback.test.ts` must stay green; the new scenarios get their tests in Task 3.

**Interfaces:**
- Consumes: nothing new. The current brain still writes a plain-text prompt and ends stdin at once; the fake must accept that as well as a JSON user line.
- Produces: env `FAKE_CLAUDE_SCENARIO=steer-drain` (first turn `s1` with text `Hel`+`lo`, then after stdin EOF a second turn `s2` whose text is `` ` prompt=${prompt} steers=${steers.join('|')}` ``), env `FAKE_CLAUDE_SCENARIO=linger` (turn `s1` with text `Hello`, then the process stays alive `FAKE_CLAUDE_LINGER_MS` ms, default 1500, before exiting).

- [ ] **Step 1: Replace `readStdin` with a line reader that records steers and EOF**

In `test/fake-claude.cjs`, delete the `readStdin` function (lines 17-23) and put this in its place:

```js
// stdin is line-delimited. The brain writes stream-json user lines, {"type":"user",
// "message":{"role":"user","content":"..."}}, and keeps the pipe open so it can steer a
// running turn with further lines (docs/superpowers/specs/2026-09-07-mid-turn-steering-design.md).
// The first line is the prompt and starts the scenario; later lines land in `steers`; EOF
// flips `stdinEnded`. A first line that is not JSON is taken as a plain-text prompt, which
// is what an older caller (or a test fake) writes.
const steers = []
let stdinEnded = false
let onStdinEnd = () => {}

function userText(line) {
  try {
    const msg = JSON.parse(line)
    const content = msg && msg.message && msg.message.content
    return typeof content === 'string' ? content : line
  } catch {
    return line
  }
}

function readPrompt() {
  return new Promise((resolve) => {
    let buf = ''
    let first = null
    const take = (line) => {
      if (first === null) { first = userText(line); resolve(first) } else steers.push(userText(line))
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) take(line)
      }
    })
    process.stdin.on('end', () => {
      const rest = buf.trim()
      buf = ''
      if (rest) take(rest)
      stdinEnded = true
      onStdinEnd()
    })
  })
}

function waitStdinEnd() {
  return stdinEnded ? Promise.resolve() : new Promise((resolve) => { onStdinEnd = resolve })
}
```

- [ ] **Step 2: Add the two scenarios**

Insert after `runTextCrash` (before `runMcp`):

```js
// One turn, then, once the brain has closed stdin (it does so at the first result), a second
// turn whose text echoes everything that came down the pipe: the prompt and every steer.
async function runSteerDrain(prompt) {
  await emit([
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'Hello' },
  ])
  await waitStdinEnd()
  await emit([
    { type: 'system', subtype: 'init', session_id: 's2', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ` prompt=${prompt} steers=${steers.join('|')}` } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's2', result: 'ok' },
  ])
}

// A result, then the process lingers the way the real CLI does while background work runs,
// and exits on its own after FAKE_CLAUDE_LINGER_MS (default 1500).
async function runLinger() {
  await emit([
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'Hello' },
  ])
  await sleep(Number(process.env.FAKE_CLAUDE_LINGER_MS) || 1500)
}
```

- [ ] **Step 3: Rewrite `main` to use the line reader and release stdin when a scenario ends**

Replace the whole `main` function with:

```js
async function main() {
  // The readback call (src/main/brain/readback.ts) is the only caller that asks for plain
  // json output; it inherits FAKE_CLAUDE_SCENARIO from the app, so it is keyed on argv.
  if (argValue('--output-format') === 'json') return runReadback()
  const prompt = await readPrompt()
  try {
    switch (process.env.FAKE_CLAUDE_SCENARIO) {
      case 'tool': await runTool(); break
      case 'auth': await runAuth(); break
      case 'crash': await runCrash(); break
      case 'text-crash': await runTextCrash(); break
      case 'mcp': await runMcp(); break
      case 'permission': await runPermission(); break
      case 'steer-drain': await runSteerDrain(prompt); break
      case 'linger': await runLinger(); break
      case 'text':
      default: await runText()
    }
  } finally {
    // An open stdin would keep the event loop, and so this process, alive after the
    // scenario has said everything it has to say.
    process.stdin.destroy()
  }
}
```

Also update the header comment (line 5) from "drains stdin (the prompt)" to "reads the prompt as the first stdin line (later lines are steers)".

- [ ] **Step 4: Run the existing suites to confirm nothing changed for them**

Run: `cd /c/repo/mechanicus-buddy-steer && npx vitest run src/main/brain/claude-cli.test.ts src/main/brain/readback.test.ts`
Expected: all tests in both files PASS (the brain still writes a plain prompt and ends stdin; the fake accepts that).

- [ ] **Step 5: Smoke the new scenarios by hand**

Run from the worktree:

```bash
printf '{"type":"user","message":{"role":"user","content":"hi"}}\n{"type":"user","message":{"role":"user","content":"status?"}}\n' | FAKE_CLAUDE_SCENARIO=steer-drain node test/fake-claude.cjs -p --output-format stream-json
```

Expected: four lines for turn `s1` (init, two deltas, result), then init `s2`, a text delta ` prompt=hi steers=status?`, and result `s2`. (The pipe closes stdin right away, which stands in for the brain closing it.)

Run: `printf 'hi\n' | FAKE_CLAUDE_SCENARIO=linger FAKE_CLAUDE_LINGER_MS=300 node test/fake-claude.cjs -p --output-format stream-json`
Expected: init, delta `Hello`, result, then the process exits about 300 ms later.

- [ ] **Step 6: Commit**

```bash
cd /c/repo/mechanicus-buddy-steer && git add test/fake-claude.cjs && git -c commit.gpgsign=false commit -q -F - <<'MSG'
test: fake CLI reads line-delimited stdin and gains steer-drain and linger scenarios

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 2: The stream-json input flag, `userLine`, and the `steer` interface

**Files:**
- Modify: `src/main/brain/types.ts` (the `Brain` interface, last line)
- Modify: `src/main/brain/claude-cli.ts` (`ClaudeCliDeps`, `buildArgs`, new export)
- Test: `src/main/brain/claude-cli.test.ts` (the two `buildArgs` tests, a new `userLine` block)

**Interfaces:**
- Produces: `export function userLine(text: string): string` returning `JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'`; `ClaudeCliDeps.drainGraceMs?: number`; `Brain.steer?(text: string): boolean`.

- [ ] **Step 1: Update the two exact-flag tests and add the `userLine` test**

In `src/main/brain/claude-cli.test.ts`, in both `buildArgs` tests change the first expected line from

```ts
      '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
```

to

```ts
      '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--verbose',
```

Change the import line to include the new export:

```ts
import { buildArgs, childEnv, ClaudeCliBrain, userLine, type ClaudeCliDeps } from './claude-cli'
```

Add after the `childEnv` describe block:

```ts
describe('userLine', () => {
  it('is one stream-json user message per line, newline terminated', () => {
    expect(userLine('hi there')).toBe('{"type":"user","message":{"role":"user","content":"hi there"}}\n')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /c/repo/mechanicus-buddy-steer && npx vitest run src/main/brain/claude-cli.test.ts`
Expected: the two `buildArgs` tests FAIL on the missing `--input-format` pair; the `userLine` test FAILS with `userLine is not a function` (or a TypeScript import error).

- [ ] **Step 3: Implement**

`src/main/brain/types.ts`, replace the `Brain` interface line with:

```ts
export interface Brain {
  respond(prompt: string, ctx: BrainContext): AsyncIterable<BrainEvent>
  stop(): void
  // Hands a further user message to the turn that is running right now (the CLI gives it
  // to the model at its next tool boundary, or runs it as the next turn). Returns false
  // when there is nothing running that can take it; the caller then refuses the prompt.
  steer?(text: string): boolean
}
```

`src/main/brain/claude-cli.ts`:

In `ClaudeCliDeps`, after `env?: NodeJS.ProcessEnv`, add:

```ts
  // How long, after the first result, to wait for a child that neither exits nor starts a
  // follow-on turn before the turn is declared done and the child left to itself.
  drainGraceMs?: number
```

In `buildArgs`, change the first line to:

```ts
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--verbose']
```

After `childEnv`, add:

```ts
// One stream-json user message, newline terminated: the shape the CLI reads from stdin
// under --input-format stream-json, both for the prompt and for a steer.
export function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd /c/repo/mechanicus-buddy-steer && npx vitest run src/main/brain/claude-cli.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean. (The turn tests still pass: the fake accepts a plain prompt and the brain still writes one.)

- [ ] **Step 5: Commit**

```bash
cd /c/repo/mechanicus-buddy-steer && git add src/main/brain/types.ts src/main/brain/claude-cli.ts src/main/brain/claude-cli.test.ts && git -c commit.gpgsign=false commit -q -F - <<'MSG'
brain: stream-json input flag, userLine helper, optional Brain.steer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 3: Hold stdin open, drain the follow-on turn, grace, and `steer()`

**Files:**
- Modify: `src/main/brain/claude-cli.ts` (`ClaudeCliBrain`: fields, `respond`, new `steer`)
- Test: `src/main/brain/claude-cli.test.ts`

**Interfaces:**
- Consumes: `userLine`, `ClaudeCliDeps.drainGraceMs` (Task 2); fake scenarios `steer-drain` and `linger` (Task 1).
- Produces: `ClaudeCliBrain.steer(text: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Add inside the `describe('ClaudeCliBrain', ...)` block of `src/main/brain/claude-cli.test.ts`, after the `stop() mid-turn` test:

```ts
  it('holds stdin open: a steer reaches the child, and a follow-on turn queued behind the first result drains into the same reply with one done', async () => {
    const brain = new ClaudeCliBrain(baseDeps({ spawn: fakeSpawn('steer-drain') }))
    const iter = brain.respond('hi', { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null })[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.value).toEqual({ type: 'text', delta: 'Hel' })
    // The turn is running (its first result is still 40 ms away); steer must be accepted.
    expect(brain.steer('status?')).toBe(true)
    const rest: BrainEvent[] = []
    for (;;) { const r = await iter.next(); if (r.done) break; rest.push(r.value) }
    const text = rest.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')
    // The fake's second turn echoes what came down stdin: the JSON prompt line and the steer.
    expect(text).toBe('lo prompt=hi steers=status?')
    expect(rest.filter(e => e.type === 'done')).toHaveLength(1)
    expect(rest.at(-1)).toEqual({ type: 'done', sessionId: 's2', error: undefined })
    // The turn is over: nothing left to steer.
    expect(brain.steer('late')).toBe(false)
  }, 10000)

  it('declares the turn done after the grace when the child lingers past its result with no follow-on turn', async () => {
    const spawnFn = ((_command: string, args: readonly string[], options: Record<string, unknown>) =>
      nodeSpawn(process.execPath, [fakeCliScript, ...args], {
        ...options,
        env: { ...(options.env as NodeJS.ProcessEnv), FAKE_CLAUDE_SCENARIO: 'linger', FAKE_CLAUDE_LINGER_MS: '1500' },
      })) as unknown as ClaudeCliDeps['spawn']
    const brain = new ClaudeCliBrain(baseDeps({ spawn: spawnFn, drainGraceMs: 100 }))
    const started = Date.now()
    const events = await collect(brain.respond('hi', { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null }))
    expect(events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')).toBe('Hello')
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 's1', error: undefined })
    // Well before the child's 1500 ms linger: the grace, not the child's exit, ended the turn.
    expect(Date.now() - started).toBeLessThan(1200)
    expect(brain.steer('late')).toBe(false)
  }, 10000)

  it('steer() returns false when no turn is running', () => {
    expect(new ClaudeCliBrain(baseDeps()).steer('x')).toBe(false)
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /c/repo/mechanicus-buddy-steer && npx vitest run src/main/brain/claude-cli.test.ts`
Expected: the three new tests FAIL (`brain.steer is not a function`; the steer-drain text is `Hello` with no drained turn).

- [ ] **Step 3: Implement**

In `src/main/brain/claude-cli.ts`, add a constant after the `SpawnFn` type:

```ts
const DRAIN_GRACE_MS = 1500
```

Replace the `ClaudeCliBrain` class (from `export class ClaudeCliBrain` to the end of the file) with:

```ts
export class ClaudeCliBrain implements Brain {
  private child: ChildProcess | null = null
  private stopped = false
  // True from the prompt going down stdin until the first result, when the brain ends stdin
  // so the child can drain whatever it queued and exit. steer() writes only while this holds.
  private stdinOpen = false

  constructor(private readonly deps: ClaudeCliDeps) {}

  async *respond(prompt: string, ctx: BrainContext): AsyncIterable<BrainEvent> {
    this.stopped = false
    const spawnFn: SpawnFn = this.deps.spawn ?? nodeSpawn
    const newSessionId = randomUUID()
    // /cd and /model change the workspace and model for the next turn (spec 6.5); ctx carries
    // ChatController's live settings on every call, so it wins over the deps this brain was
    // constructed with.
    const workspace = ctx.workspace
    const args = buildArgs({ ...this.deps, model: ctx.model }, ctx.sessionId, newSessionId)
    const env = childEnv(this.deps.env ?? process.env)

    const channel = new EventChannel<Item>()
    let stdoutRemainder = ''
    const stderrLines: string[] = []
    let sessionIdFromInit: string | undefined
    let sawActivity = false
    // The most recent result line. Set at the first result (the turn boundary) and replaced
    // by any follow-on turn's result while the child drains; reported in the single done.
    let lastResult: { sessionId?: string; error?: string } | null = null
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const clearGrace = (): void => { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null } }
    const armGrace = (): void => {
      clearGrace()
      graceTimer = setTimeout(() => channel.push({ kind: 'grace' }), this.deps.drainGraceMs ?? DRAIN_GRACE_MS)
    }

    const child = spawnFn(this.deps.cliPath, [...(this.deps.argsPrefix ?? []), ...args], { cwd: workspace, env })
    this.child = child

    const onStdout = (chunk: Buffer): void => {
      stdoutRemainder += chunk.toString('utf8')
      const lines = stdoutRemainder.split('\n')
      stdoutRemainder = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) channel.push({ kind: 'line', line })
    }
    const onStderr = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) stderrLines.push(line.trim())
    }
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.on('error', (error: NodeJS.ErrnoException) => { channel.push({ kind: 'spawnError', error }); channel.end() })
    child.on('close', (code) => {
      clearGrace()
      if (stdoutRemainder.trim()) channel.push({ kind: 'line', line: stdoutRemainder })
      channel.push({ kind: 'close', code })
      channel.end()
    })

    // A child that already exited (or never started a real stdin pipe, as some fakes in
    // tests don't) can make this write fail with EPIPE/EOF; without a listener, Node treats
    // an 'error' event with no handler as an uncaught exception and crashes the process.
    child.stdin?.on('error', () => { /* ignore: the child is gone, nothing to write to */ })
    child.stdin?.write(userLine(prompt))
    // stdin stays open: steer() writes further user lines until the first result. Measured
    // CLI behaviour (spec section 2): a line written during a tool loop is handed to the
    // model at its next tool boundary; one written with no boundary left runs as the next
    // turn of the same process once stdin is closed.
    this.stdinOpen = true
    const endStdin = (): void => {
      if (!this.stdinOpen) return
      this.stdinOpen = false
      child.stdin?.end()
    }

    try {
      for await (const item of channel) {
        if (item.kind === 'line') {
          for (const out of parseStreamLine(item.line)) {
            switch (out.type) {
              case 'ignore': break
              case 'init':
                sessionIdFromInit = out.init.sessionId
                // An init after the first result is a queued steer running as its own turn:
                // wait for its result rather than declaring the turn done under it.
                clearGrace()
                break
              case 'text': yield out; break
              case 'activity':
                if (!sawActivity) { sawActivity = true; this.deps.onMood('thinking') }
                yield out
                break
              case 'done': {
                if (out.error && isAuthError(out.error)) {
                  const authLine = pickLine(this.deps.lines.authError)
                  if (authLine) yield { type: 'status', text: authLine, expression: 'sadness' }
                }
                // A result line is a turn boundary, not the end of the child. Close stdin
                // (the child then drains anything queued and exits) and keep reading; the
                // single done goes out at close, or after the grace if the child lingers.
                lastResult = { sessionId: out.sessionId ?? sessionIdFromInit, error: out.error }
                endStdin()
                armGrace()
                break
              }
              default: break
            }
          }
        } else if (item.kind === 'spawnError') {
          if (item.error.code === 'ENOENT') {
            const missingLine = pickLine(this.deps.lines.cliMissing)
            if (missingLine) yield { type: 'status', text: missingLine, expression: 'sadness' }
          }
          yield { type: 'done', error: item.error.message }
          return
        } else if (item.kind === 'grace') {
          // The child is still alive after its result with no follow-on turn (the real CLI
          // waits on background work this way). The reply is complete; leave the child to
          // finish on its own, as the code did before stdin was held open, and stop
          // listening to it.
          child.stdout?.off('data', onStdout)
          child.stderr?.off('data', onStderr)
          yield { type: 'done', sessionId: lastResult?.sessionId ?? sessionIdFromInit, error: lastResult?.error }
          return
        } else if (item.kind === 'close') {
          if (this.stopped) {
            // The session id learned from init survives a stop or a crash, so the next turn
            // resumes the same conversation instead of starting over.
            yield { type: 'done', sessionId: sessionIdFromInit, error: `stopped (exit code ${item.code ?? 'null'})`, stopped: true }
          } else if (lastResult) {
            yield { type: 'done', sessionId: lastResult.sessionId ?? sessionIdFromInit, error: lastResult.error }
          } else {
            const tail = stderrLines.slice(-5).join('\n')
            yield { type: 'done', sessionId: sessionIdFromInit, error: `exit code ${item.code ?? 'null'}${tail ? ': ' + tail : ''}` }
          }
        }
      }
    } finally {
      clearGrace()
      this.stdinOpen = false
      this.child = null
      this.deps.onMood('restore')
    }
  }

  // Writes one more user line to the running child. False when nothing is running or the
  // turn is already draining (stdin closed at its first result); never throws, the stdin
  // error listener above swallows a write to a child that has gone.
  steer(text: string): boolean {
    const child = this.child
    if (!child || !this.stdinOpen || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false
    child.stdin.write(userLine(text))
    return true
  }

  stop(): void {
    this.stopped = true
    const child = this.child
    if (!child) return
    killTree(child)
  }
}
```

Also extend the `Item` union (above the class) with the grace kind:

```ts
type Item =
  | { kind: 'line'; line: string }
  | { kind: 'spawnError'; error: NodeJS.ErrnoException }
  | { kind: 'close'; code: number | null }
  | { kind: 'grace' }
```

And update the file's header comment (line 1-4) to say: "Spawns the installed CLI in print mode with stream-json in and out, feeds it the prompt as a user line, keeps stdin open so a running turn can be steered, and turns each line of stdout into BrainEvents via parseStreamLine."

- [ ] **Step 4: Run to verify they pass, and that the old tests still do**

Run: `cd /c/repo/mechanicus-buddy-steer && npx vitest run src/main/brain/claude-cli.test.ts && npm run typecheck`
Expected: every test in the file PASS, typecheck clean. Watch two in particular: `does not crash when child.stdin emits an error` (the fake stdin has `write` and `end`, close 0 with no result, so the done reports `exit code 0`) and `stop() mid-turn` (close arrives with `stopped` set, so the stopped done wins even though no result was seen).

If the steer-drain test's text is `lo prompt=hi steers=` (steer missing), the steer write raced the fake's EOF: check that `stdinOpen` is set before the first stdout line can arrive, which the code above guarantees because the write and the flag precede the first `await`.

- [ ] **Step 5: Run the whole unit suite**

Run: `cd /c/repo/mechanicus-buddy-steer && npx vitest run`
Expected: 29 files, 303 tests PASS (299 baseline, 1 from Task 2, 3 from this task).

- [ ] **Step 6: Commit**

```bash
cd /c/repo/mechanicus-buddy-steer && git add src/main/brain/claude-cli.ts src/main/brain/claude-cli.test.ts && git -c commit.gpgsign=false commit -q -F - <<'MSG'
brain: hold stdin open per turn, steer() into the running child, drain the follow-on turn with a grace

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 4: Chat controller routes a busy-time prompt to `steer`

**Files:**
- Modify: `src/main/chat.ts:64` (the busy branch of `prompt`)
- Test: `src/main/chat.test.ts`

**Interfaces:**
- Consumes: `Brain.steer?(text): boolean` (Task 2).

- [ ] **Step 1: Write the failing tests**

In `src/main/chat.test.ts`, rename the existing test at line 90 from
`'refuses a second prompt while busy and /stop stops the brain'` to
`'refuses a second prompt while busy when the brain cannot steer, and /stop stops the brain'` (body unchanged: that brain has no `steer`).

Add directly after it:

```ts
  it('steers a second prompt into the running turn when the brain can take it, and posts nothing', async () => {
    const out = fakeOut()
    let release!: () => void
    const steers: string[] = []
    const brain: Brain = {
      async *respond() { yield { type: 'text', delta: 'x' }; await new Promise<void>(r => { release = r }); yield { type: 'done' } },
      stop() {},
      steer(text) { steers.push(text); return true },
    }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('one')
    await new Promise(r => setTimeout(r, 5))
    expect(c.busy).toBe(true)
    c.prompt('  how is it going?  ')
    expect(steers).toEqual(['how is it going?'])
    expect(out.systems).toEqual([])
    release()
    await new Promise(r => setTimeout(r, 5))
    expect(c.busy).toBe(false)
    expect(out.dones).toBe(1)
  })
  it('falls back to the refusal line when the brain declines the steer', async () => {
    const out = fakeOut()
    let release!: () => void
    const brain: Brain = {
      async *respond() { yield { type: 'text', delta: 'x' }; await new Promise<void>(r => { release = r }); yield { type: 'done' } },
      stop() {},
      steer() { return false },
    }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('one')
    await new Promise(r => setTimeout(r, 5))
    c.prompt('two')
    expect(out.systems.at(-1)).toContain('/stop')
    release()
    await new Promise(r => setTimeout(r, 5))
  })
  it('readback gets the whole reply, including text that arrives after a drained follow-on turn', async () => {
    const out = fakeOut()
    const rb = fakeReadback({ ok: true, text: 'spoken' })
    const c = new ChatController({
      brain: scriptedBrain([{ type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' }, { type: 'text', delta: ' and the answer' }, { type: 'done', sessionId: 's2' }]),
      actions: fakeActions(), pack, out, settings: settings(), readback: rb,
    })
    c.prompt('hi')
    await new Promise(r => setTimeout(r, 10))
    expect(rb.calls).toEqual(['Hello and the answer'])
    expect(c.status().session).toBe('s2')
  })
```

- [ ] **Step 2: Run to verify the steer test fails**

Run: `cd /c/repo/mechanicus-buddy-steer && npx vitest run src/main/chat.test.ts`
Expected: `steers a second prompt...` FAILS (steers is `[]`, systems holds the refusal); `falls back...` and the readback guard PASS already; the renamed test PASSES.

- [ ] **Step 3: Implement**

In `src/main/chat.ts`, replace the line

```ts
    if (this.running) { this.deps.out.system('Still working. Use /stop to abort the current rite.'); return }
```

with

```ts
    if (this.running) {
      // A message typed mid-rite goes into the running turn: the CLI hands it to the model at
      // its next tool boundary, or runs it as the next turn if none is left (spec
      // 2026-09-07-mid-turn-steering-design). The panel already shows the operator's bubble,
      // so nothing is posted. Only a brain that cannot take it (the echo brain, or a turn
      // that is already draining) gets the refusal.
      if (this.deps.brain.steer?.(text.trim())) return
      this.deps.out.system('Still working. Use /stop to abort the current rite.')
      return
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd /c/repo/mechanicus-buddy-steer && npx vitest run src/main/chat.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /c/repo/mechanicus-buddy-steer && git add src/main/chat.ts src/main/chat.test.ts && git -c commit.gpgsign=false commit -q -F - <<'MSG'
chat: a prompt typed mid-rite steers the running turn instead of being refused

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 5: Full verification, docs sweep, hand-off

**Files:**
- Possibly modify: `README.md` (only if it documents the old refusal)
- No new code.

- [ ] **Step 1: Docs sweep for the old behaviour**

Run: `cd /c/repo/mechanicus-buddy-steer && grep -rn "Still working" README.md docs/*.md src/main/commands.ts 2>/dev/null`
Expected: no hits outside `src/main/chat.ts` and its test. If `README.md` has a hit, replace that sentence with: `Typing while a rite runs hands the message to the running turn; the magos answers at his next tool boundary and carries on. /stop still aborts.` and include `README.md` in the final commit.

- [ ] **Step 2: Em dash sweep of everything this branch touched**

Run: `cd /c/repo/mechanicus-buddy-steer && git diff master --name-only | xargs grep -l "$(printf '\xe2\x80\x94')" ; echo "exit=$?"`
Expected: no file names printed (`exit=123` from xargs means grep matched nothing in any file). Fix any hit. Git Bash's grep rejects `-P` unicode escapes without a UTF-8 locale, hence the printf form.

- [ ] **Step 3: Full unit suite and typecheck**

Run: `cd /c/repo/mechanicus-buddy-steer && npm run typecheck && npx vitest run`
Expected: typecheck clean; 29 files, 306 tests PASS (baseline 299, plus 1 from Task 2, 3 from Task 3, 3 from Task 4).

- [ ] **Step 4: E2E suite against the fake CLI**

Run: `cd /c/repo/mechanicus-buddy-steer && npm run test:e2e 2>&1 | tail -30`
Expected: every spec PASS (22 at baseline). The brain specs launch the app with `BUDDY_CLI_ARGS=[fake-claude.cjs]`, so they exercise the new stdin handling end to end. If a brain spec times out waiting for a reply, the fake has not exited after its scenario: check that `process.stdin.destroy()` in the fake's `main` runs (Task 1 Step 3) and that the brain ends stdin at the first result (Task 3).

- [ ] **Step 5: Live smoke with the real CLI, from the worktree build (optional but recommended)**

Run: `cd /c/repo/mechanicus-buddy-steer && npm run build && npx electron-vite preview`
Ask the buddy for something that runs a couple of tools (for example: "run `sleep 8` twice with Bash and then say done"), and while the activity line shows, type "what are you doing right now?". Expected: a one-line answer appears in the same bubble, the rite continues, and one done. Then close the preview.

- [ ] **Step 6: Commit any docs change and report**

If Step 1 changed `README.md`:

```bash
cd /c/repo/mechanicus-buddy-steer && git add README.md && git -c commit.gpgsign=false commit -q -F - <<'MSG'
docs: README describes mid-rite steering

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

Report to Peter: branch `steer` in `C:\repo\mechanicus-buddy-steer`, commits listed by `git log --oneline master..steer`, test counts from Steps 3 and 4. Do not merge. After Peter merges, remove the worktree: `cd /c/repo/mechanicus-buddy && git worktree remove /c/repo/mechanicus-buddy-steer && git branch -d steer`.
