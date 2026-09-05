# Readback Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every brain reply in the hologram gets a short in-character headline produced by a second, tool-less Haiku CLI call, with Claude Code's plain reply folded under an arrow row in the same bubble.

**Architecture:** A new `Readback` class spawns `claude -p --output-format json --model haiku` per reply with the pack's `persona.md` as the system prompt (no tools, no MCP, no session persistence, scratch cwd). `ChatController` numbers every reply, fires the readback after a clean `done` without awaiting it, and sends the result to the hologram over a new `chat:readback` channel keyed by that id. The renderer keeps the bubbles awaiting a readback in a map and reflows one bubble once when its text arrives.

**Tech Stack:** Electron 44, TypeScript, electron-vite, vitest, Playwright `_electron`, the existing fake CLI `test/fake-claude.cjs` driven through `process.execPath` and the `BUDDY_CLI_ARGS` prefix hook.

Spec: `docs/superpowers/specs/2026-09-04-readback-layer-design.md`.

## Global Constraints

- No em dashes anywhere (code, comments, commit messages, docs). Application code never names the Mechanicus; pack-specific text lives under `packs/`.
- The persona never reaches the main turn. The tools note (`src/main/brain/prompt.ts`) is untouched.
- No test spawns the real `claude`; every test uses `test/fake-claude.cjs`. The only real-CLI path is `npm run smoke:claude`, run by hand only. Never run it as part of a task.
- Readback flags (pinned against CLI 2.1.220): `-p --output-format json --model haiku --setting-sources project --no-session-persistence --system-prompt <persona + instruction> --tools "" --strict-mcp-config`. No `--mcp-config`, no `--session-id`, no `--resume`.
- Input to the readback is cut at 12,000 characters with a trailing ` [truncated]`. Timeout 45 seconds (raised from 20 on 2026-09-05). Scratch cwd is `<userData>/readback`, created on first use.
- Waiting state (Peter, 2026-09-04 evening): with readback on, the bubble shows three animated dots from its first delta until the readback lands or fails; the plain text accumulates hidden. On failure, timeout, or an error turn the dots give way to the plain text with no arrow. With readback off the bubble streams plain text as today.
- Only real replies get a readback: not system lines, canned lines, permission cards, slash confirmations, error turns, empty replies, the echo brain, or `config.readback === false`. Old bubbles never change after their readback lands or fails.
- Commit with `git -c user.name="phellwege" -c user.email="phellwege1@gmail.com" commit -m "<message>"`; every message ends with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Stage only files you changed (never `git add -A`; ignore `build/` and `test-results/`). Branch `readback-layer`, in place, no PRs.
- Windows: PowerShell-safe or Git Bash commands; never `taskkill` from Git Bash. Kill leftover test Electron processes with PowerShell `Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force` only when no dev instance is running (ask the controller if unsure; the controller runs the dev instance).

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/brain/process.ts` (new) | `killTree(child)`: the Windows `taskkill /T /F` or POSIX `kill` helper, moved out of `ClaudeCliBrain.stop()` so both brains share it. |
| `src/main/brain/readback.ts` (new) | `READBACK_INSTRUCTION`, `buildReadbackArgs`, `truncateInput`, `parseReadbackOutput`, and the `Readback` class (spawn, stdin, timeout, JSON parse, `stopAll`). |
| `src/main/brain/readback.test.ts` (new) | Unit tests for the pure helpers and the class against the fake CLI. |
| `test/fake-claude.cjs` | New `readback` behavior selected by argv (`--output-format json`), with a failing variant via `FAKE_CLAUDE_READBACK=fail`. |
| `src/shared/ipc.ts`, `src/preload/index.ts` | `id` on `ChatDonePayload`, `ChatReadbackPayload`, `CH.chatReadback`, `onChatReadback`. |
| `src/main/chat.ts`, `src/main/chat.test.ts` | Message ids, reply text collection, readback trigger after `done`, `log` and `readback` deps. |
| `src/main/config.ts`, `src/main/config.test.ts` | `readback: boolean` (default `true`). |
| `src/main/index.ts` | Construct `Readback` (or not), `out.readback`, `BUDDY_READBACK=0` test override, `before-quit` kills readbacks in flight. |
| `packs/mechanicus/persona.md` | Drop the final tools paragraph. |
| `src/renderer/hologram/main.ts`, `src/renderer/hologram/styles.css` | Awaiting map, one-time reflow, toggle row, styles. |
| `e2e/brain.spec.ts` | Headline and toggle case; readback-off case. |
| `scripts/smoke-claude.mjs` | One readback step after the main turn. |

---

### Task 1: The readback call

**Files:**
- Create: `src/main/brain/process.ts`, `src/main/brain/readback.ts`, `src/main/brain/readback.test.ts`
- Modify: `src/main/brain/claude-cli.ts` (`stop()` uses `killTree`), `test/fake-claude.cjs`

**Interfaces:**
- Consumes: `childEnv(base)` from `src/main/brain/claude-cli.ts`; the fake CLI conventions (`argValue`, `emit`, `readStdin` if present, otherwise read stdin the same way `runMcp` does).
- Produces:

```ts
// src/main/brain/process.ts
export function killTree(child: ChildProcess): void

// src/main/brain/readback.ts
export const READBACK_INSTRUCTION: string
export const READBACK_MAX_CHARS = 12000
export const READBACK_TIMEOUT_MS = 45000
export interface ReadbackDeps {
  cliPath: string
  persona: string            // the pack's persona.md text (PackData.persona.prompt)
  scratchDir: string         // <userData>/readback, created on first use
  spawn?: typeof nodeSpawn   // injectable for tests
  env?: NodeJS.ProcessEnv    // defaults to childEnv(process.env)
  argsPrefix?: string[]      // BUDDY_CLI_ARGS test hook, same as the brain
  timeoutMs?: number         // defaults to READBACK_TIMEOUT_MS
}
export type ReadbackResult = { ok: true; text: string } | { ok: false; reason: string }
export function buildReadbackArgs(persona: string): string[]
export function truncateInput(text: string): string
export function parseReadbackOutput(stdout: string): ReadbackResult
export class Readback {
  constructor(deps: ReadbackDeps)
  run(text: string): Promise<ReadbackResult>   // never rejects
  stopAll(): void                               // kills every child in flight
}
```

- [ ] **Step 1: Write the failing tests for the pure helpers**

`src/main/brain/readback.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildReadbackArgs, parseReadbackOutput, truncateInput, Readback, READBACK_INSTRUCTION, READBACK_MAX_CHARS, type ReadbackDeps } from './readback'

const fakeCliScript = join(__dirname, '../../../test/fake-claude.cjs')

describe('buildReadbackArgs', () => {
  it('produces the pinned flag list with the persona and instruction as the system prompt', () => {
    const args = buildReadbackArgs('I am the persona.')
    expect(args).toEqual([
      '-p', '--output-format', 'json', '--model', 'haiku',
      '--setting-sources', 'project', '--no-session-persistence',
      '--system-prompt', `I am the persona.\n\n${READBACK_INSTRUCTION}`,
      '--tools', '', '--strict-mcp-config',
    ])
  })
})

describe('truncateInput', () => {
  it('leaves short input alone and cuts long input with a marker', () => {
    expect(truncateInput('short')).toBe('short')
    const long = 'x'.repeat(READBACK_MAX_CHARS + 50)
    const cut = truncateInput(long)
    expect(cut.length).toBe(READBACK_MAX_CHARS + ' [truncated]'.length)
    expect(cut.endsWith(' [truncated]')).toBe(true)
  })
})

describe('parseReadbackOutput', () => {
  it('returns the result text on a clean success', () => {
    expect(parseReadbackOutput('{"type":"result","subtype":"success","is_error":false,"result":"So it is."}'))
      .toEqual({ ok: true, text: 'So it is.' })
  })
  it('fails on is_error, a non-success subtype, empty text, and malformed JSON', () => {
    expect(parseReadbackOutput('{"type":"result","subtype":"success","is_error":true,"result":"x"}').ok).toBe(false)
    expect(parseReadbackOutput('{"type":"result","subtype":"error_during_execution","is_error":false,"result":"x"}').ok).toBe(false)
    expect(parseReadbackOutput('{"type":"result","subtype":"success","is_error":false,"result":"   "}').ok).toBe(false)
    expect(parseReadbackOutput('not json').ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/brain/readback.test.ts`
Expected: FAIL, cannot find module `./readback`.

- [ ] **Step 3: Create `process.ts` and move the kill logic there**

`src/main/brain/process.ts`:

```ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

// Kills a CLI child and everything it spawned. Windows has no process groups, so taskkill
// walks the tree; the spawn is best effort and must never throw or leave a handle behind.
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    const killer = nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('error', () => { /* best effort only */ })
  } else {
    child.kill()
  }
}
```

In `src/main/brain/claude-cli.ts`, replace the body of `stop()` after `const child = this.child` with a call to `killTree(child)` (keep `this.stopped = true` and the early return when there is no child). Import `killTree` from `./process`. Run `npx vitest run src/main/brain/claude-cli.test.ts` to confirm the stop test still passes.

- [ ] **Step 4: Write `readback.ts` with the helpers**

`src/main/brain/readback.ts`:

```ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { childEnv } from './claude-cli'
import { killTree } from './process'

export const READBACK_INSTRUCTION =
  'You are the voice layer of a desktop assistant. The user\'s message below is a reply the ' +
  'assistant just gave, written in plain language. Restate its substance in your own character ' +
  'in at most three short sentences. Add no facts and answer nothing new. Keep file names, ' +
  'commands, and numbers exactly as written. Use no code blocks, lists, or headings. If the reply ' +
  'is only code, say what the code does. Output the restatement and nothing else.'
export const READBACK_MAX_CHARS = 12000
export const READBACK_TIMEOUT_MS = 45000

export interface ReadbackDeps {
  cliPath: string
  persona: string
  scratchDir: string
  spawn?: typeof nodeSpawn
  env?: NodeJS.ProcessEnv
  argsPrefix?: string[]
  timeoutMs?: number
}
export type ReadbackResult = { ok: true; text: string } | { ok: false; reason: string }

export function buildReadbackArgs(persona: string): string[] {
  return [
    '-p', '--output-format', 'json', '--model', 'haiku',
    '--setting-sources', 'project', '--no-session-persistence',
    '--system-prompt', `${persona}\n\n${READBACK_INSTRUCTION}`,
    '--tools', '', '--strict-mcp-config',
  ]
}

export function truncateInput(text: string): string {
  return text.length <= READBACK_MAX_CHARS ? text : text.slice(0, READBACK_MAX_CHARS) + ' [truncated]'
}

export function parseReadbackOutput(stdout: string): ReadbackResult {
  let parsed: unknown
  try { parsed = JSON.parse(stdout.trim()) } catch { return { ok: false, reason: 'malformed JSON' } }
  const o = parsed as { type?: string; subtype?: string; is_error?: boolean; result?: unknown }
  if (o.is_error === true) return { ok: false, reason: `is_error: ${String(o.result).slice(0, 120)}` }
  if (o.subtype !== 'success') return { ok: false, reason: `subtype ${o.subtype ?? 'missing'}` }
  const text = typeof o.result === 'string' ? o.result.trim() : ''
  return text ? { ok: true, text } : { ok: false, reason: 'empty result' }
}
```

- [ ] **Step 5: Run the helper tests to verify they pass**

Run: `npx vitest run src/main/brain/readback.test.ts`
Expected: the three helper describes PASS (the `Readback` class does not exist yet; no test uses it so far).

- [ ] **Step 6: Add the fake CLI readback behavior**

In `test/fake-claude.cjs`, before the `switch (process.env.FAKE_CLAUDE_SCENARIO)`, route by argv. The readback process inherits the main turn's environment, so the scenario env var cannot be the key; `--output-format json` is only ever passed by the readback call:

```js
// The readback call (src/main/brain/readback.ts) is the only caller that asks for plain
// json output; it inherits FAKE_CLAUDE_SCENARIO from the app, so it is keyed on argv.
if (argValue('--output-format') === 'json') return runReadback()
```

And the function (reuse the existing stdin reader if the file has one; otherwise this):

```js
async function runReadback() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const input = Buffer.concat(chunks).toString('utf8')
  if (!process.argv.includes('--system-prompt') || !process.argv.includes('--no-session-persistence')) {
    process.stderr.write('fake-claude: readback call is missing --system-prompt or --no-session-persistence\n')
    process.exit(2)
  }
  if (process.env.FAKE_CLAUDE_READBACK === 'fail') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'fake failure' }) + '\n')
    return
  }
  if (process.env.FAKE_CLAUDE_READBACK === 'hang') {
    await new Promise((r) => setTimeout(r, 60000))
    return
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Readback: ' + input.slice(0, 40) }) + '\n')
}
```

- [ ] **Step 7: Write the failing tests for the `Readback` class**

Append to `src/main/brain/readback.test.ts`:

```ts
function deps(over: Partial<ReadbackDeps> & { scenarioEnv?: Record<string, string> } = {}): ReadbackDeps {
  const scratchDir = join(mkdtempSync(join(tmpdir(), 'readback-')), 'scratch')
  const spawnFn = ((_cmd: string, args: readonly string[], options: Record<string, unknown>) =>
    nodeSpawn(process.execPath, [fakeCliScript, ...args], { ...options, env: { ...(options.env as NodeJS.ProcessEnv), ...(over.scenarioEnv ?? {}) } })
  ) as unknown as ReadbackDeps['spawn']
  return { cliPath: 'claude.exe', persona: 'I am the persona.', scratchDir, spawn: spawnFn, ...over }
}

describe('Readback', () => {
  it('returns the readback text from the fake CLI and creates the scratch cwd', async () => {
    const d = deps()
    const r = await new Readback(d).run('Hello there, this is the plain reply.')
    expect(r).toEqual({ ok: true, text: 'Readback: Hello there, this is the plain reply.' })
    expect(existsSync(d.scratchDir)).toBe(true)
  })
  it('reports a failing result instead of throwing', async () => {
    const r = await new Readback(deps({ scenarioEnv: { FAKE_CLAUDE_READBACK: 'fail' } })).run('x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('is_error')
  })
  it('times out, kills the child, and reports the timeout', async () => {
    const r = await new Readback(deps({ scenarioEnv: { FAKE_CLAUDE_READBACK: 'hang' }, timeoutMs: 300 })).run('x')
    expect(r).toEqual({ ok: false, reason: 'timeout after 300 ms' })
  }, 10000)
  it('reports ENOENT when the CLI is missing', async () => {
    const r = await new Readback({ cliPath: 'C:/definitely/missing/claude.exe', persona: 'p', scratchDir: join(tmpdir(), 'readback-none') }).run('x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('ENOENT')
  })
  it('passes the truncated input on stdin', async () => {
    const r = await new Readback(deps()).run('y'.repeat(READBACK_MAX_CHARS + 10))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe('Readback: ' + 'y'.repeat(40))
  })
})
```

- [ ] **Step 8: Run the class tests to verify they fail**

Run: `npx vitest run src/main/brain/readback.test.ts`
Expected: FAIL, `Readback` is not exported.

- [ ] **Step 9: Implement the `Readback` class**

Append to `src/main/brain/readback.ts`:

```ts
export class Readback {
  private readonly children = new Set<ChildProcess>()
  constructor(private readonly deps: ReadbackDeps) {}

  run(text: string): Promise<ReadbackResult> {
    return new Promise((resolve) => {
      const spawnFn = this.deps.spawn ?? nodeSpawn
      const env = this.deps.env ?? childEnv(process.env)
      const timeoutMs = this.deps.timeoutMs ?? READBACK_TIMEOUT_MS
      try { mkdirSync(this.deps.scratchDir, { recursive: true }) } catch { /* the spawn below reports a missing cwd */ }
      const args = [...(this.deps.argsPrefix ?? []), ...buildReadbackArgs(this.deps.persona)]
      let child: ChildProcess
      try {
        child = spawnFn(this.deps.cliPath, args, { cwd: this.deps.scratchDir, env, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (e) {
        resolve({ ok: false, reason: (e as Error).message }); return
      }
      this.children.add(child)
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (r: ReadbackResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.children.delete(child)
        resolve(r)
      }
      const timer = setTimeout(() => { killTree(child); finish({ ok: false, reason: `timeout after ${timeoutMs} ms` }) }, timeoutMs)
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      child.on('error', (e: NodeJS.ErrnoException) => finish({ ok: false, reason: `${e.code ?? 'spawn error'}: ${e.message}` }))
      child.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          const tail = stderr.trim().split('\n').slice(-3).join(' | ')
          finish({ ok: false, reason: `exit code ${code ?? 'null'}${tail ? ': ' + tail : ''}` }); return
        }
        finish(parseReadbackOutput(stdout))
      })
      child.stdin?.on('error', () => { /* the child exited before reading; close() reports it */ })
      child.stdin?.end(truncateInput(text))
    })
  }

  stopAll(): void {
    for (const child of this.children) killTree(child)
    this.children.clear()
  }
}
```

- [ ] **Step 10: Run all tests and typecheck**

Run: `npx vitest run` and `npm run typecheck`
Expected: all green (182 existing plus the new ones), no leftover node processes (the hang scenario is killed by the timeout).

- [ ] **Step 11: Commit**

```bash
git add src/main/brain/process.ts src/main/brain/readback.ts src/main/brain/readback.test.ts src/main/brain/claude-cli.ts test/fake-claude.cjs
git -c user.name="phellwege" -c user.email="phellwege1@gmail.com" commit -m "feat: readback call: tool-less haiku restatement of a reply through the CLI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Message ids, controller trigger, config, wiring

**Files:**
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/chat.ts`, `src/main/chat.test.ts`, `src/main/config.ts`, `src/main/config.test.ts`, `src/main/index.ts`, `packs/mechanicus/persona.md`

**Interfaces:**
- Consumes: `Readback`, `ReadbackResult` from Task 1; `appendLog(logDir, 'main', line)` and `toHologram(channel, payload)` in `src/main/index.ts`.
- Produces:

```ts
// src/shared/ipc.ts
export interface ChatDonePayload { id: number; error?: string; expression?: Expression }
export interface ChatReadbackPayload { id: number; text: string }
CH.chatReadback = 'chat:readback'
BuddyBridge.onChatReadback(cb: (p: ChatReadbackPayload) => void): () => void

// src/main/chat.ts
export interface ChatOut { ...; readback(p: ChatReadbackPayload): void }
// ChatController deps gain: readback?: { run(text: string): Promise<ReadbackResult> }; log?: (line: string) => void
```

- [ ] **Step 1: Write the failing controller tests**

In `src/main/chat.test.ts`, extend `fakeOut()` with `readbacks: [] as unknown[]` and `readback(p: unknown) { o.readbacks.push(p) }`, then add:

```ts
function fakeReadback(result: { ok: true; text: string } | { ok: false; reason: string }) {
  const r = { calls: [] as string[], async run(text: string) { r.calls.push(text); return result } }
  return r
}

describe('ChatController readback', () => {
  it('numbers replies and fires one readback with the joined reply text after a clean done', async () => {
    const out = fakeOut(); const rb = fakeReadback({ ok: true, text: 'So it is.' })
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' }, { type: 'done' }]),
      actions: fakeActions(), pack, out, settings: settings(), readback: rb })
    c.prompt('hi')
    await new Promise(r => setTimeout(r, 20))
    expect(out.doneArgs.at(-1)).toMatchObject({ id: 1 })
    expect(rb.calls).toEqual(['Hello'])
    expect(out.readbacks).toEqual([{ id: 1, text: 'So it is.' }])
  })
  it('gives the second reply id 2', async () => {
    const out = fakeOut(); const rb = fakeReadback({ ok: true, text: 'x' })
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'done' }]),
      actions: fakeActions(), pack, out, settings: settings(), readback: rb })
    c.prompt('one'); await new Promise(r => setTimeout(r, 20))
    c.prompt('two'); await new Promise(r => setTimeout(r, 20))
    expect(out.doneArgs.map(d => (d as { id: number }).id)).toEqual([1, 2])
    expect(out.readbacks).toEqual([{ id: 1, text: 'x' }, { id: 2, text: 'x' }])
  })
  it('skips the readback on an error turn, an empty reply, and when no readback is configured', async () => {
    const rb = fakeReadback({ ok: true, text: 'x' })
    for (const events of [
      [{ type: 'text', delta: 'a' }, { type: 'done', error: 'boom' }] as BrainEvent[],
      [{ type: 'text', delta: '   ' }, { type: 'done' }] as BrainEvent[],
    ]) {
      const out = fakeOut()
      const c = new ChatController({ brain: scriptedBrain(events), actions: fakeActions(), pack, out, settings: settings(), readback: rb })
      c.prompt('hi'); await new Promise(r => setTimeout(r, 20))
      expect(out.readbacks).toEqual([])
    }
    expect(rb.calls).toEqual([])
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'done' }]), actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('hi'); await new Promise(r => setTimeout(r, 20))
    expect(out.readbacks).toEqual([])
  })
  it('logs a failed readback and sends nothing', async () => {
    const out = fakeOut(); const lines: string[] = []
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'done' }]),
      actions: fakeActions(), pack, out, settings: settings(), readback: fakeReadback({ ok: false, reason: 'timeout after 20000 ms' }), log: (l) => lines.push(l) })
    c.prompt('hi'); await new Promise(r => setTimeout(r, 20))
    expect(out.readbacks).toEqual([])
    expect(lines).toEqual(['readback failed: timeout after 20000 ms'])
  })
})
```

Also update every existing assertion on `out.doneArgs` that uses `toEqual` with an exact object to include `id` (search the file for `doneArgs`; `toMatchObject` assertions need no change).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/chat.test.ts`
Expected: FAIL, `readback` is not a known dep and `out.readbacks` stays empty.

- [ ] **Step 3: IPC and preload**

`src/shared/ipc.ts`: add `chatReadback: 'chat:readback'` to `CH`; change `ChatDonePayload` to `{ id: number; error?: string; expression?: Expression }`; add `export interface ChatReadbackPayload { id: number; text: string }`; add `onChatReadback(cb: (p: ChatReadbackPayload) => void): () => void` to `BuddyBridge` next to `onChatDone`.

`src/preload/index.ts`: add `onChatReadback: on(CH.chatReadback),` next to `onChatDone`.

- [ ] **Step 4: Controller**

`src/main/chat.ts`:
- Import `ChatReadbackPayload` from `../shared/ipc` and `ReadbackResult` from `./brain/readback`.
- `ChatOut` gains `readback(p: ChatReadbackPayload): void`.
- The constructor deps type gains `readback?: { run(text: string): Promise<ReadbackResult> }` and `log?: (line: string) => void`.
- Add `private messageSerial = 0`.
- In `ask()`: `const id = ++this.messageSerial` and `let reply = ''` at the top; on a text event, also `reply += ev.delta`; both `out.done` calls pass `{ id, error, expression }`; right after the `done` branch's `out.done` (inside the `else if (ev.type === 'done')` block), add:

```ts
          if (!ev.error && reply.trim() && this.deps.readback) void this.readback(id, reply)
```

- Add the method:

```ts
  // Fire and forget: the next turn may start while this runs, and a failure only logs.
  private async readback(id: number, text: string): Promise<void> {
    let result: ReadbackResult
    try { result = await this.deps.readback!.run(text) } catch (e) { result = { ok: false, reason: (e as Error).message } }
    if (result.ok) this.deps.out.readback({ id, text: result.text })
    else this.deps.log?.(`readback failed: ${result.reason}`)
  }
```

- [ ] **Step 5: Run the controller tests to verify they pass**

Run: `npx vitest run src/main/chat.test.ts`
Expected: PASS.

- [ ] **Step 6: Config flag with a test**

`src/main/config.test.ts`: add a case that a config file with `"readback": "yes"` loads with `readback === true` (the default) and that `"readback": false` is kept. Follow the existing test's temp-file pattern.

`src/main/config.ts`: add `readback: boolean` to `Config` (after `permissionTimeoutSec`), `readback: true` to the defaults, and `readback: (v) => typeof v === 'boolean'` to the validators. Run `npx vitest run src/main/config.test.ts`.

- [ ] **Step 7: Main wiring and the persona file**

`src/main/index.ts`:
- Import `Readback` from `./brain/readback`.
- In `out`, add `readback: (p: ChatReadbackPayload) => toHologram(CH.chatReadback, p)` (import the type).
- After `useEcho` is known and before the controller is built:

```ts
  // BUDDY_READBACK=0 is a test override, like BUDDY_BRAIN=echo.
  const readbackEnabled = config.readback && process.env.BUDDY_READBACK !== '0' && !useEcho
  const readback = readbackEnabled ? new Readback({
    cliPath, persona: pack.persona.prompt, scratchDir: join(app.getPath('userData'), 'readback'), argsPrefix,
  }) : undefined
```

- Pass `readback` and `log: (line) => appendLog(logDir, 'main', line)` into `new ChatController({...})`.
- In the existing `before-quit` handler that calls `chatRef?.stop()`, add `readback?.stopAll()`.
- Log one startup line: `appendLog(logDir, 'main', \`readback ${readbackEnabled ? 'on' : 'off'}\`)`.

`packs/mechanicus/persona.md`: delete the final paragraph (the one starting "You have a body on the user's screen." through "Format code in fenced blocks."). The character text above it is unchanged. Confirm `npx vitest run src/main/pack.mechanicus.test.ts` still passes.

- [ ] **Step 8: Run everything**

Run: `npm run typecheck`, `npx vitest run`, `npm run build`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/chat.ts src/main/chat.test.ts src/main/config.ts src/main/config.test.ts src/main/index.ts packs/mechanicus/persona.md
git -c user.name="phellwege" -c user.email="phellwege1@gmail.com" commit -m "feat: replies carry ids and trigger a readback after a clean done; readback config flag

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Renderer reflow, styles, e2e, smoke step

**Files:**
- Modify: `src/renderer/hologram/main.ts`, `src/renderer/hologram/styles.css`, `e2e/brain.spec.ts`, `scripts/smoke-claude.mjs`

**Interfaces:**
- Consumes: `ChatDonePayload.id` and `.readback`, `ChatStatusPayload.readback`, `ChatReadbackPayload { id, text?, failed? }`, `window.buddy.onChatReadback` from Task 2 (the last three added by the controller after Task 2 landed); the fake CLI's readback behavior from Task 1 (`Readback: ` plus the first 40 characters of the reply).
- Produces: bubble DOM while waiting: `.msg.buddy.waiting > .face-slot? + .text > (.dots, .plain[hidden])`; after a readback: `.msg.buddy > .face-slot? + .text > (.readback, button.plain-toggle, .plain[hidden])`; after a failure: `.text > .plain` visible, no toggle. The toggle is a bare chevron (down when collapsed, up when expanded) with a "plain text" tooltip, no text label.

- [ ] **Step 1: Write the failing e2e cases**

Append to `e2e/brain.spec.ts` (reuse its `launch(scenario)` helper; the text scenario's reply is `Hello`, so the fake readback is `Readback: Hello`). Give `launch` an optional second parameter `extraEnv: Record<string, string> = {}` spread into the launch env after the existing entries. Use the file's actual input selectors if they differ from `#input` (check `src/renderer/hologram/index.html`).

```ts
test('a reply settles to an in-character headline with the plain text folded under the arrow', async () => {
  const { hologram } = await launch('text')
  await hologram.fill('#input', 'hi')
  await hologram.press('#input', 'Enter')
  const lastReply = hologram.locator('.msg.buddy').last()
  await expect(lastReply.locator('.readback')).toContainText('Readback: Hello', { timeout: 15000 })
  await expect(lastReply.locator('.dots')).toHaveCount(0)
  await expect(lastReply.locator('.plain')).toBeHidden()
  await expect(lastReply.locator('.face')).toHaveCount(1)
  await lastReply.locator('.plain-toggle').click()
  await expect(lastReply.locator('.plain')).toBeVisible()
  await expect(lastReply.locator('.plain')).toContainText('Hello')
})

test('while the readback is pending the bubble shows dots and hides the text', async () => {
  const { hologram } = await launch('text', { FAKE_CLAUDE_READBACK: 'hang' })
  await hologram.fill('#input', 'hi')
  await hologram.press('#input', 'Enter')
  const lastReply = hologram.locator('.msg.buddy').last()
  await expect(lastReply.locator('.face')).toHaveCount(1, { timeout: 15000 })
  await expect(lastReply.locator('.dots')).toBeVisible()
  await expect(lastReply.locator('.plain')).toBeHidden()
  await expect(lastReply.locator('.readback')).toHaveCount(0)
})

test('a failed readback settles the bubble to plain text with no arrow', async () => {
  const { hologram } = await launch('text', { FAKE_CLAUDE_READBACK: 'fail' })
  await hologram.fill('#input', 'hi')
  await hologram.press('#input', 'Enter')
  const lastReply = hologram.locator('.msg.buddy').last()
  await expect(lastReply.locator('.plain')).toBeVisible({ timeout: 15000 })
  await expect(lastReply.locator('.plain')).toContainText('Hello')
  await expect(lastReply.locator('.dots')).toHaveCount(0)
  await expect(lastReply.locator('.plain-toggle')).toHaveCount(0)
})

test('with readback off the bubble streams plain and has no dots or toggle', async () => {
  const { hologram } = await launch('text', { BUDDY_READBACK: '0' })
  await hologram.fill('#input', 'hi')
  await hologram.press('#input', 'Enter')
  const lastReply = hologram.locator('.msg.buddy').last()
  await expect.poll(() => lastReply.textContent(), { timeout: 15000 }).toContain('Hello')
  await expect(lastReply.locator('.dots')).toHaveCount(0)
  await expect(lastReply.locator('.plain-toggle')).toHaveCount(0)
  await expect(lastReply.locator('.readback')).toHaveCount(0)
})
```

The `FAKE_CLAUDE_READBACK` variable reaches the readback child because the app hands its own environment to the CLI; the `hang` variant keeps the readback pending for the app's 20 s timeout, longer than the assertions need.

- [ ] **Step 2: Run the e2e to verify it fails**

Run: `npm run test:e2e -- e2e/brain.spec.ts`
Expected: the first three new cases FAIL (`.readback`, `.dots`, `.plain` never appear); the last may already pass. Kill nothing but the test's own Electron (the test closes it in `afterEach`).

- [ ] **Step 3: Renderer**

`src/renderer/hologram/main.ts`. State:

```ts
// Whether main will follow replies with a readback (from chat:status). Decides whether a
// new reply bubble starts in the waiting state.
let readbackOn = false
// Bubbles waiting for their readback, by message id. Cleared when it lands, fails, or after
// 30 s (the fallback settles the bubble to plain text).
const awaitingReadback = new Map<number, { bubble: HTMLDivElement; timer: number }>()
```

In the `onChatStatus` handler (find it; it updates the status row), add `readbackOn = p.readback === true`.

Waiting-state bubble creation. Where `onChatDelta` and `onChatActivity` do `current = add('buddy', '')`, call a new helper instead:

```ts
function newReply(): HTMLDivElement {
  const bubble = add('buddy', '')
  if (readbackOn) {
    const textEl = bubble.querySelector('.text') as HTMLElement
    const dots = document.createElement('div'); dots.className = 'dots'
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'))
    const plain = document.createElement('div'); plain.className = 'plain'; plain.hidden = true
    textEl.append(dots, plain)
    bubble.classList.add('waiting')
  }
  return bubble
}
```

`flush()` must render the buffer into the right place: if the bubble has a `.plain` child (waiting state), render into that `.plain`; otherwise into `.text` as today:

```ts
function replyTarget(bubble: HTMLDivElement): HTMLElement | null {
  return (bubble.querySelector('.plain') as HTMLElement | null) ?? (bubble.querySelector('.text') as HTMLElement | null)
}
```

Settling helpers:

```ts
function settlePlain(bubble: HTMLDivElement): void {
  // Readback failed, timed out, or the turn errored: show the plain text, no arrow.
  bubble.querySelector('.dots')?.remove()
  const plain = bubble.querySelector('.plain') as HTMLElement | null
  if (plain) plain.hidden = false
  bubble.classList.remove('waiting')
}

function settleReadback(bubble: HTMLDivElement, text: string): void {
  const textEl = bubble.querySelector('.text') as HTMLElement | null
  if (!textEl) return
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 4
  bubble.querySelector('.dots')?.remove()
  let plain = bubble.querySelector('.plain') as HTMLElement | null
  if (!plain) {
    // Not created in the waiting state (readback was switched on mid-session): fold the
    // rendered reply as-is so highlighted code and links-as-text stay intact.
    plain = document.createElement('div'); plain.className = 'plain'
    while (textEl.firstChild) plain.appendChild(textEl.firstChild)
    textEl.appendChild(plain)
  }
  plain.hidden = true
  const headline = document.createElement('div'); headline.className = 'readback'
  headline.innerHTML = renderMarkdown(text)
  // A bare arrow (Peter's call): no label, a tooltip carries the meaning.
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'plain-toggle'
  toggle.title = 'plain text'; toggle.setAttribute('aria-label', 'show plain text')
  const label = (): void => { toggle.textContent = plain!.hidden ? '\u25BE' : '\u25B4' }
  label()
  toggle.addEventListener('click', () => { plain!.hidden = !plain!.hidden; label() })
  textEl.insertBefore(toggle, plain)
  textEl.insertBefore(headline, toggle)
  bubble.classList.remove('waiting')
  if (atBottom) log.scrollTop = log.scrollHeight
}
```

The two arrow literals are the JavaScript unicode escapes for the small down-pointing triangle (U+25BE) and the small up-pointing triangle (U+25B4).

In the `onChatDone` handler, before `current = null`:

```ts
  if (current) {
    if (p.error || !p.readback) settlePlain(current)
    else {
      const bubble = current
      const timer = window.setTimeout(() => { awaitingReadback.delete(p.id); settlePlain(bubble) }, 30000)
      awaitingReadback.set(p.id, { bubble, timer })
    }
  }
```

Add the listener:

```ts
window.buddy.onChatReadback(({ id, text, failed }) => {
  const entry = awaitingReadback.get(id)
  if (!entry) return
  awaitingReadback.delete(id); clearTimeout(entry.timer)
  if (failed || !text) settlePlain(entry.bubble)
  else settleReadback(entry.bubble, text)
})
```

`src/renderer/hologram/styles.css`:

```css
.dots { display: inline-flex; gap: 4px; align-items: center; height: 1.35em; }
.dots span { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: 0.35; animation: dotpulse 1.2s ease-in-out infinite; }
.dots span:nth-child(2) { animation-delay: 0.2s; }
.dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dotpulse { 0%, 80%, 100% { opacity: 0.35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
.readback { }
.plain-toggle { display: block; margin-top: 2px; padding: 0 4px; border: none; background: none; color: var(--accent); font: inherit; font-size: 12px; line-height: 1; opacity: 0.7; cursor: pointer; }
.plain-toggle:hover { opacity: 1; }
.plain { margin-top: 4px; padding-top: 4px; border-top: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); }
.msg.buddy.waiting .plain { border-top: none; padding-top: 0; margin-top: 0; }
```

The toggle's chevron is its whole text; the `.activity::before` rule does not apply to it.

- [ ] **Step 4: Run the e2e to verify it passes**

Run: `npm run test:e2e`
Expected: all cases PASS (5 existing plus 4 new). Then `npm run typecheck` and `npx vitest run`.

- [ ] **Step 5: Smoke step**

In `scripts/smoke-claude.mjs`, after the main turn's result is printed, spawn one readback call with the same flag list as `buildReadbackArgs` (duplicate it with a comment pointing at `src/main/brain/readback.ts`, as the script already does for the main flags), system prompt `"You are a terse narrator.\n\n" + the instruction text`, the main turn's result text on stdin, cwd a temp dir, and print `smoke-claude: readback: <text>` or the failure reason. Do not run the script.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/hologram/main.ts src/renderer/hologram/styles.css e2e/brain.spec.ts scripts/smoke-claude.mjs
git -c user.name="phellwege" -c user.email="phellwege1@gmail.com" commit -m "feat: readback headline in the bubble with the plain reply under a toggle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- Spec 3.1 flow: Task 2 (trigger on clean done, overlap allowed) and Task 3 (single reflow, toggle per bubble, failure leaves the bubble plain). Spec 3.2 skip rules: Task 2 (error, empty, no readback dep for echo and missing CLI, config flag). `/stop` does not touch readbacks (the controller never tracks them); quit kills them (Task 2 `stopAll`).
- Spec 4: Task 1 (flags, stdin, truncation, scratch cwd, env, timeout, JSON parse, stderr tail). Spec 4.2: Task 2 (persona paragraph). Spec 4.3: flags pinned in Task 1's arg builder.
- Spec 5: Task 2. Spec 6: Task 3 (map, reflow, scroll, styles). Spec 7: Task 2. Spec 8: Tasks 1 and 2 (null becomes `{ ok: false, reason }`, logged by the controller). Spec 9: Task 1 unit, Task 2 controller and config, Task 3 e2e and smoke.
- Type consistency: `ReadbackResult` is the same shape in Tasks 1 and 2; `ChatDonePayload.id` and `ChatReadbackPayload` are defined in Task 2 and consumed in Task 3; `BUDDY_READBACK=0` is set in Task 2 and used in Task 3's second e2e.
