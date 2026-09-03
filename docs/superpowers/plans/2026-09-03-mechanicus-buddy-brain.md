# Mechanicus Buddy, Plan B: Claude CLI Brain, Tools, Permissions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the echo brain with Claude Code, driven headlessly through the locally installed CLI on the user's subscription, with the character's actions exposed to Claude as MCP tools and tool permissions approved from the hologram.

**Architecture:** `ClaudeCliBrain` spawns `claude.exe` once per turn with stream-json output and resumes the session by id. A local HTTP server in the main process hosts a Streamable HTTP MCP endpoint for the buddy tools and a permission endpoint that a hook script posts to. The `ChatController` from Plan A gains permission cards, activity rows, and mood coupling.

**Tech Stack:** Everything from Plan A, plus `@modelcontextprotocol/sdk` and Node's built-in `http`. The Claude Code CLI 2.1.220 or newer at `%USERPROFILE%\.local\bin\claude.exe`.

Spec: `docs/superpowers/specs/2026-09-03-mechanicus-buddy-design.md`, sections 11 to 14. Prerequisite: Plan A complete.

## Global Constraints

- No API key, ever. The child process environment strips `ANTHROPIC_API_KEY` and `CLAUDECODE`.
- CLI flags per spec 11.3. Pre-approved tools: `Read Glob Grep mcp__buddy__*`. Permission mode `manual`.
- MCP and permission endpoints bind `127.0.0.1` on a random port and require `Authorization: Bearer <token>` generated per app launch.
- Permission requests unanswered after `config.permissionTimeoutSec` (default 120) are denied. The hook's own timeout is that value plus 10 seconds.
- One CLI process per turn. `stop()` kills it; the session id survives.
- No em dashes in user-facing text. Application code never names the Mechanicus.
- Tests never spend quota: they use `test/fake-claude.cjs`. One real-CLI check is a manual task.

## File Structure

```
src/main/brain/types.ts        Modify: add errorKind to the done event
src/main/brain/stream.ts       parseLine, toolLabel, StreamReducer (pure, tested with fixtures)
src/main/brain/args.ts         buildCliArgs (pure, tested)
src/main/brain/claude-cli.ts   ClaudeCliBrain: spawn, pipe, reduce, stop
src/main/server.ts             LocalServer: http server, MCP endpoint, permission endpoint, token
src/main/tools.ts              buddy tool definitions bound to BuddyActions
src/hook/permission-hook.cjs   reads hook JSON, posts to the server, prints the decision
src/main/chat.ts               Modify: permission routing, mood coupling, error kinds
src/main/index.ts              Modify: start the server, build ClaudeCliBrain, pass config
test/fake-claude.cjs           scripted CLI stand-in
test/fixtures/stream/*.jsonl   captured stream-json shapes
e2e/brain.spec.ts              Playwright scenario with the fake CLI
```

---

### Task 1: Stream parser and tool labels

**Files:**
- Modify: `src/main/brain/types.ts`
- Create: `src/main/brain/stream.ts`, `src/main/brain/stream.test.ts`, `test/fixtures/stream/text.jsonl`, `test/fixtures/stream/tool.jsonl`, `test/fixtures/stream/error.jsonl`

**Interfaces:**
- Consumes: `BrainEvent` from Plan A.
- Produces:

```ts
// types.ts: the done event gains an optional kind
| { type: 'done'; sessionId?: string; error?: string; errorKind?: 'auth' | 'missing' | 'exit' | 'result' }

// stream.ts
export function parseLine(line: string): Record<string, unknown> | null    // null on blank or invalid JSON
export function toolLabel(name: string, input: Record<string, unknown>): string
export class StreamReducer {
  feed(line: string): BrainEvent[]           // stateful across lines
  end(exitCode: number | null, stderrTail: string): BrainEvent[]   // emits done if the stream never did
  get sessionId(): string | undefined
  get usedBuddyTool(): boolean               // true if any mcp__buddy__ tool_use was seen
}
```

Reduction rules (spec 11.4): `system` init records `session_id`; `stream_event` text deltas emit `text` and set a flag so later `assistant` text blocks are not emitted twice; `assistant` `tool_use` blocks emit `activity` (skipped for `mcp__buddy__*`, which sets `usedBuddyTool`); `user` `tool_result` blocks emit the matching `activity` with `done: true`; `result` emits `done` with `error` when `is_error` or `subtype !== 'success'`, `errorKind: 'auth'` if the text mentions login or authentication, else `'result'`. `end()` without a prior result emits `done` with `errorKind: 'exit'`.

- [ ] **Step 1: Add `errorKind` to `src/main/brain/types.ts`** (replace the `done` variant with the line above).

- [ ] **Step 2: Write the fixtures**

`test/fixtures/stream/text.jsonl`:

```
{"type":"system","subtype":"init","cwd":"C:\\repo","session_id":"sess-1","tools":["Read","Glob","Grep","Bash"],"model":"claude-sonnet-5"}
{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}}}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The Omnissiah "}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"provides."}}}
{"type":"stream_event","event":{"type":"content_block_stop","index":0}}
{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"The Omnissiah provides."}]},"session_id":"sess-1"}
{"type":"result","subtype":"success","is_error":false,"result":"The Omnissiah provides.","session_id":"sess-1","total_cost_usd":0.004,"duration_ms":1800,"num_turns":1}
```

`test/fixtures/stream/tool.jsonl`:

```
{"type":"system","subtype":"init","cwd":"C:\\repo","session_id":"sess-2","tools":["Read","Grep","mcp__buddy__set_mood"],"model":"claude-sonnet-5"}
{"type":"assistant","message":{"id":"msg_2","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"C:\\repo\\mechanicus-buddy\\src\\main\\buddy.ts"}}]},"session_id":"sess-2"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"export class Buddy {}"}]},"session_id":"sess-2"}
{"type":"assistant","message":{"id":"msg_3","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"mcp__buddy__set_mood","input":{"mood":"happy"}}]},"session_id":"sess-2"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"ok"}]},"session_id":"sess-2"}
{"type":"assistant","message":{"id":"msg_4","role":"assistant","content":[{"type":"text","text":"A state machine. Adequate."}]},"session_id":"sess-2"}
{"type":"result","subtype":"success","is_error":false,"result":"A state machine. Adequate.","session_id":"sess-2","total_cost_usd":0.01,"duration_ms":4000,"num_turns":3}
```

`test/fixtures/stream/error.jsonl`:

```
{"type":"system","subtype":"init","cwd":"C:\\repo","session_id":"sess-3","tools":[],"model":"claude-sonnet-5"}
{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Not logged in. Please run /login","session_id":"sess-3"}
```

- [ ] **Step 3: Write the failing tests**

`src/main/brain/stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StreamReducer, parseLine, toolLabel } from './stream'

const fixture = (n: string) => readFileSync(join(__dirname, '../../../test/fixtures/stream', n), 'utf8').split(/\r?\n/)
const run = (n: string) => { const r = new StreamReducer(); const ev = fixture(n).flatMap(l => r.feed(l)); return { r, ev } }

describe('parseLine', () => {
  it('returns null on blank and invalid lines', () => {
    expect(parseLine('')).toBeNull(); expect(parseLine('{nope')).toBeNull()
  })
})

describe('toolLabel', () => {
  it('describes common tools', () => {
    expect(toolLabel('Read', { file_path: 'C:\\repo\\a\\b\\c.ts' })).toBe('reading b/c.ts')
    expect(toolLabel('Glob', { pattern: '**/*.ts' })).toBe('finding **/*.ts')
    expect(toolLabel('Grep', { pattern: 'TODO' })).toBe('searching for TODO')
    expect(toolLabel('Bash', { command: 'git status' })).toBe('running: git status')
    expect(toolLabel('Edit', { file_path: 'x/y.md' })).toBe('editing x/y.md')
    expect(toolLabel('Bash', { command: 'x'.repeat(100) })).toHaveLength('running: '.length + 61)
    expect(toolLabel('Mystery', {})).toBe('Mystery')
  })
})

describe('StreamReducer', () => {
  it('emits deltas once, then done with the session id', () => {
    const { r, ev } = run('text.jsonl')
    const text = ev.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')
    expect(text).toBe('The Omnissiah provides.')
    expect(ev.at(-1)).toEqual({ type: 'done', sessionId: 'sess-1' })
    expect(r.sessionId).toBe('sess-1')
  })
  it('emits activity for tools, skips buddy tools, and falls back to assistant text', () => {
    const { r, ev } = run('tool.jsonl')
    const acts = ev.filter(e => e.type === 'activity') as Array<{ id: string; label: string; done?: boolean }>
    expect(acts).toEqual([
      { type: 'activity', id: 'toolu_1', label: 'reading main/buddy.ts', toolName: 'Read', done: false },
      { type: 'activity', id: 'toolu_1', label: 'reading main/buddy.ts', toolName: 'Read', done: true },
    ])
    expect(r.usedBuddyTool).toBe(true)
    expect(ev.find(e => e.type === 'text')).toEqual({ type: 'text', delta: 'A state machine. Adequate.' })
  })
  it('classifies an auth error', () => {
    const { ev } = run('error.jsonl')
    expect(ev.at(-1)).toEqual({ type: 'done', sessionId: 'sess-3', error: 'Not logged in. Please run /login', errorKind: 'auth' })
  })
  it('end() reports a missing result as an exit error', () => {
    const r = new StreamReducer()
    r.feed(fixture('text.jsonl')[0]!)
    expect(r.end(1, 'boom')).toEqual([{ type: 'done', sessionId: 'sess-1', error: 'exit code 1: boom', errorKind: 'exit' }])
    expect(r.end(0, '')).toEqual([])
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run src/main/brain/stream.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 5: Write `src/main/brain/stream.ts`**

```ts
import type { BrainEvent } from './types'

export function parseLine(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t) return null
  try { const v = JSON.parse(t); return v && typeof v === 'object' ? v as Record<string, unknown> : null }
  catch { return null }
}

const shortPath = (p: unknown): string => {
  const parts = String(p ?? '').split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}
const trunc = (s: unknown, n = 60): string => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t }

export function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read': return `reading ${shortPath(input.file_path)}`
    case 'Glob': return `finding ${trunc(input.pattern)}`
    case 'Grep': return `searching for ${trunc(input.pattern)}`
    case 'Bash': return `running: ${trunc(input.command)}`
    case 'Edit': case 'Write': case 'MultiEdit': return `editing ${shortPath(input.file_path)}`
    case 'WebFetch': return `fetching ${trunc(input.url)}`
    case 'WebSearch': return `searching web: ${trunc(input.query)}`
    default: return name
  }
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string }

export class StreamReducer {
  private session: string | undefined
  private sawDelta = false
  private ended = false
  private buddyTool = false
  private readonly tools = new Map<string, { label: string; toolName: string }>()

  get sessionId(): string | undefined { return this.session }
  get usedBuddyTool(): boolean { return this.buddyTool }

  feed(line: string): BrainEvent[] {
    const m = parseLine(line)
    if (!m) return []
    const out: BrainEvent[] = []
    if (typeof m.session_id === 'string') this.session = m.session_id
    switch (m.type) {
      case 'stream_event': {
        const ev = m.event as { type?: string; delta?: { type?: string; text?: string } } | undefined
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          this.sawDelta = true
          out.push({ type: 'text', delta: ev.delta.text })
        }
        break
      }
      case 'assistant': {
        const blocks = ((m.message as { content?: Block[] })?.content ?? [])
        for (const b of blocks) {
          if (b.type === 'text' && !this.sawDelta && b.text) out.push({ type: 'text', delta: b.text })
          if (b.type === 'tool_use' && b.id && b.name) {
            if (b.name.startsWith('mcp__buddy__')) { this.buddyTool = true; continue }
            const label = toolLabel(b.name, b.input ?? {})
            this.tools.set(b.id, { label, toolName: b.name })
            out.push({ type: 'activity', id: b.id, label, toolName: b.name, done: false })
          }
        }
        break
      }
      case 'user': {
        const blocks = ((m.message as { content?: Block[] })?.content ?? [])
        for (const b of blocks) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            const t = this.tools.get(b.tool_use_id)
            if (t) out.push({ type: 'activity', id: b.tool_use_id, label: t.label, toolName: t.toolName, done: true })
          }
        }
        break
      }
      case 'result': {
        this.ended = true
        const isError = m.is_error === true || m.subtype !== 'success'
        if (!isError) { out.push({ type: 'done', sessionId: this.session }); break }
        const text = typeof m.result === 'string' && m.result ? m.result : String(m.subtype ?? 'error')
        const auth = /log ?in|authenticat|credential|unauthorized/i.test(text)
        out.push({ type: 'done', sessionId: this.session, error: text, errorKind: auth ? 'auth' : 'result' })
        break
      }
    }
    return out
  }

  end(exitCode: number | null, stderrTail: string): BrainEvent[] {
    if (this.ended) return []
    this.ended = true
    if (exitCode === 0 && !stderrTail) return []
    return [{ type: 'done', sessionId: this.session, error: `exit code ${exitCode}: ${stderrTail.trim()}`.trim(), errorKind: 'exit' }]
  }
}
```

Note on `end(0, '')`: a clean exit with no `result` line and no stderr is treated as silently complete; the brain (Task 2) always emits a final `done` itself if the reducer produced none, so the panel never hangs.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/main/brain/stream.test.ts`
Expected: 7 PASS. The `toolLabel` truncation test expects 60 characters plus one ellipsis character.

- [ ] **Step 7: Commit**

```bash
git add src/main/brain/types.ts src/main/brain/stream.ts src/main/brain/stream.test.ts test/fixtures/stream
git commit -m "feat: stream-json reducer and tool labels for the CLI brain

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: CLI argument builder, fake CLI, and `ClaudeCliBrain`

**Files:**
- Create: `src/main/brain/args.ts`, `src/main/brain/args.test.ts`, `test/fake-claude.cjs`, `src/main/brain/claude-cli.ts`, `src/main/brain/claude-cli.test.ts`

**Interfaces:**
- Consumes: `StreamReducer` (Task 1), `Brain`, `BrainContext`, `BrainEvent`.
- Produces:

```ts
// args.ts (pure)
export interface CliArgOptions { sessionId: string | null; newSessionId: string; personaPrompt: string; mcpUrl: string;
  token: string; allowedTools: string[]; model: string | null; extraDirs: string[]; hookCommand: string; hookTimeoutSec: number }
export const TOOLS_NOTE: string
export function mcpConfigJson(url: string, token: string): string
export function settingsJson(hookCommand: string, timeoutSec: number): string
export function buildCliArgs(o: CliArgOptions): string[]

// claude-cli.ts
export interface CliBrainOptions { cliPath: string; cliArgsPrefix?: string[]; personaPrompt: string; mcpUrl: string; token: string;
  allowedTools: string[]; extraDirs: string[]; hookCommand: string; hookTimeoutSec: number; log?: (line: string) => void }
export class ClaudeCliBrain implements Brain { constructor(opts: CliBrainOptions) }
```

`test/fake-claude.cjs` accepts the real flags and picks a scenario from the prompt on stdin: default echoes the prompt as streamed deltas; a prompt containing `read a file` adds a `Read` tool_use and result; `fail auth` emits an auth error result; `be happy` calls the buddy MCP `set_mood` tool over HTTP (used in Task 3); `run something` spawns the permission hook from `--settings` and obeys its decision (used in Task 3). When `--resume` is present the echoed text starts with `resumed:`.

- [ ] **Step 1: Write the failing args tests**

`src/main/brain/args.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildCliArgs, mcpConfigJson, settingsJson, TOOLS_NOTE } from './args'

const base = { sessionId: null, newSessionId: 'new-1', personaPrompt: 'Be snarky.', mcpUrl: 'http://127.0.0.1:5000/mcp',
  token: 'tok', allowedTools: ['Read', 'mcp__buddy__*'], model: null, extraDirs: [], hookCommand: 'node hook.cjs --port 5000 --token tok', hookTimeoutSec: 130 }

describe('buildCliArgs', () => {
  it('starts a new session with --session-id and resumes with --resume', () => {
    const a = buildCliArgs(base)
    expect(a.slice(0, 5)).toEqual(['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'])
    expect(a).toContain('--session-id'); expect(a[a.indexOf('--session-id') + 1]).toBe('new-1')
    const b = buildCliArgs({ ...base, sessionId: 'old-9' })
    expect(b).not.toContain('--session-id'); expect(b[b.indexOf('--resume') + 1]).toBe('old-9')
  })
  it('appends the persona and the tools note as one system prompt argument', () => {
    const a = buildCliArgs(base)
    const prompt = a[a.indexOf('--append-system-prompt') + 1]!
    expect(prompt.startsWith('Be snarky.')).toBe(true)
    expect(prompt).toContain(TOOLS_NOTE)
  })
  it('passes mcp config, strict flag, allowed tools, manual mode, settings', () => {
    const a = buildCliArgs(base)
    expect(JSON.parse(a[a.indexOf('--mcp-config') + 1]!)).toEqual(JSON.parse(mcpConfigJson(base.mcpUrl, base.token)))
    expect(a).toContain('--strict-mcp-config')
    const i = a.indexOf('--allowedTools'); expect(a.slice(i + 1, i + 3)).toEqual(['Read', 'mcp__buddy__*'])
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('manual')
    const s = JSON.parse(a[a.indexOf('--settings') + 1]!)
    expect(s.hooks.PermissionRequest[0].hooks[0]).toEqual({ type: 'command', command: base.hookCommand, timeout: 130 })
  })
  it('omits --model when null and includes --add-dir when dirs exist', () => {
    expect(buildCliArgs(base)).not.toContain('--model')
    const a = buildCliArgs({ ...base, model: 'sonnet', extraDirs: ['D:\\x', 'D:\\y'] })
    expect(a[a.indexOf('--model') + 1]).toBe('sonnet')
    const i = a.indexOf('--add-dir'); expect(a.slice(i + 1, i + 3)).toEqual(['D:\\x', 'D:\\y'])
  })
  it('mcpConfigJson carries the bearer header', () => {
    expect(JSON.parse(mcpConfigJson('http://127.0.0.1:1/mcp', 'abc'))).toEqual({ mcpServers: { buddy: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer abc' } } } })
    expect(JSON.parse(settingsJson('cmd', 5)).hooks.PermissionRequest[0].hooks[0].timeout).toBe(5)
  })
})
```

- [ ] **Step 2: Write `src/main/brain/args.ts`**

```ts
export interface CliArgOptions {
  sessionId: string | null; newSessionId: string; personaPrompt: string; mcpUrl: string; token: string
  allowedTools: string[]; model: string | null; extraDirs: string[]; hookCommand: string; hookTimeoutSec: number
}

export const TOOLS_NOTE = [
  'Body tools (MCP server "buddy"): set_mood(mood: calm|happy|thinking|confused|alarmed) changes your standing mood;',
  'emote(kind: happy|thinking|confused|alarmed|look|hop) plays a one-off reaction; go_to(x: 0..100, run?: boolean)',
  'walks or runs to that percent of the screen width; sleep() and wake(); get_state() returns your current state.',
  'Use them naturally and sparingly. Do not describe using them.',
].join(' ')

export function mcpConfigJson(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { buddy: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } })
}

export function settingsJson(hookCommand: string, timeoutSec: number): string {
  return JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: hookCommand, timeout: timeoutSec }] }] } })
}

export function buildCliArgs(o: CliArgOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose']
  if (o.sessionId) args.push('--resume', o.sessionId); else args.push('--session-id', o.newSessionId)
  args.push('--append-system-prompt', `${o.personaPrompt.trim()}\n\n${TOOLS_NOTE}`)
  args.push('--mcp-config', mcpConfigJson(o.mcpUrl, o.token), '--strict-mcp-config')
  args.push('--allowedTools', ...o.allowedTools)
  args.push('--permission-mode', 'manual')
  args.push('--settings', settingsJson(o.hookCommand, o.hookTimeoutSec))
  if (o.model) args.push('--model', o.model)
  if (o.extraDirs.length) args.push('--add-dir', ...o.extraDirs)
  return args
}
```

Run: `npx vitest run src/main/brain/args.test.ts`
Expected: 5 PASS.

- [ ] **Step 3: Write `test/fake-claude.cjs`**

```js
#!/usr/bin/env node
// Scripted stand-in for claude.exe in print mode. Never talks to Anthropic.
const http = require('node:http')
const { spawn } = require('node:child_process')

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const resumed = argv.includes('--resume')
const sessionId = flag('--resume') || flag('--session-id') || 'fake-session'
const delay = Number(process.env.FAKE_DELAY_MS || 0)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function streamText(text) {
  for (const part of text.split(/(?<=\s)/)) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } })
    if (delay) await sleep(delay)
  }
  out({ type: 'assistant', message: { id: 'msg', role: 'assistant', content: [{ type: 'text', text }] }, session_id: sessionId })
}
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, total_cost_usd: 0, duration_ms: 1, num_turns: 1 })

function mcpCall(method, params) {
  const cfg = JSON.parse(flag('--mcp-config'))
  const { url, headers } = cfg.mcpServers.buddy
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', reject); req.end(body)
  })
}

function askPermission(toolName, toolInput) {
  const settings = JSON.parse(flag('--settings'))
  const command = settings.hooks.PermissionRequest[0].hooks[0].command
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, windowsHide: true })
    let data = ''; child.stdout.on('data', c => data += c)
    child.on('close', () => { try { resolve(JSON.parse(data).hookSpecificOutput.decision) } catch { resolve('deny') } })
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: toolInput, tool_use_id: 'toolu_p', session_id: sessionId, cwd: process.cwd(), permission_mode: 'manual' }))
  })
}

async function main() {
  let prompt = ''
  for await (const chunk of process.stdin) prompt += chunk
  prompt = prompt.trim()
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, tools: ['Read', 'Bash'], model: flag('--model') || 'fake-model' })
  const prefix = resumed ? 'resumed: ' : ''
  if (/fail auth/i.test(prompt)) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in. Please run /login', session_id: sessionId }); return
  }
  if (/read a file/i.test(prompt)) {
    out({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\repo\\x\\file.ts' } }] }, session_id: sessionId })
    if (delay) await sleep(delay)
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents' }] }, session_id: sessionId })
  }
  if (/be happy/i.test(prompt)) {
    await mcpCall('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } })
    const r = await mcpCall('tools/call', { name: 'set_mood', arguments: { mood: 'happy' } })
    if (r.status !== 200) { await streamText(`mcp failed: ${r.status} ${r.data}`); result('mcp failed'); return }
  }
  if (/run something/i.test(prompt)) {
    const decision = await askPermission('Bash', { command: 'git status' })
    const text = decision === 'allow' ? `${prefix}Executed git status.` : `${prefix}Denied. As expected.`
    await streamText(text); result(text); return
  }
  const text = `${prefix}You said: ${prompt}`
  await streamText(text); result(text)
}
main().catch(e => { process.stderr.write(String(e)); process.exit(1) })
```

- [ ] **Step 4: Write the failing brain tests**

`src/main/brain/claude-cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { ClaudeCliBrain } from './claude-cli'
import type { BrainEvent } from './types'

const FAKE = join(__dirname, '../../../test/fake-claude.cjs')
const opts = { cliPath: process.execPath, cliArgsPrefix: [FAKE], personaPrompt: 'Persona.', mcpUrl: 'http://127.0.0.1:1/mcp',
  token: 't', allowedTools: ['Read'], extraDirs: [], hookCommand: 'node nope.cjs', hookTimeoutSec: 5 }
const ctx = (sessionId: string | null) => ({ state: {} as never, workspace: process.cwd(), model: null, sessionId })
async function collect(it: AsyncIterable<BrainEvent>) { const ev: BrainEvent[] = []; for await (const e of it) ev.push(e); return ev }
const text = (ev: BrainEvent[]) => ev.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')

describe('ClaudeCliBrain', () => {
  it('streams text and reports the session id', async () => {
    const ev = await collect(new ClaudeCliBrain(opts).respond('hello', ctx(null)))
    expect(text(ev)).toBe('You said: hello')
    const done = ev.at(-1) as { type: string; sessionId?: string }
    expect(done.type).toBe('done'); expect(done.sessionId).toMatch(/[0-9a-f-]{36}/)
  })
  it('resumes with the given session id', async () => {
    const ev = await collect(new ClaudeCliBrain(opts).respond('again', ctx('sess-old')))
    expect(text(ev)).toBe('resumed: You said: again')
    expect((ev.at(-1) as { sessionId?: string }).sessionId).toBe('sess-old')
  })
  it('emits activity for a tool call', async () => {
    const ev = await collect(new ClaudeCliBrain(opts).respond('please read a file', ctx(null)))
    const acts = ev.filter(e => e.type === 'activity')
    expect(acts).toHaveLength(2)
    expect((acts[1] as { done?: boolean }).done).toBe(true)
  })
  it('classifies auth failures', async () => {
    const ev = await collect(new ClaudeCliBrain(opts).respond('fail auth', ctx(null)))
    expect(ev.at(-1)).toMatchObject({ type: 'done', errorKind: 'auth' })
  })
  it('reports a missing CLI', async () => {
    const ev = await collect(new ClaudeCliBrain({ ...opts, cliPath: 'C:\\nope\\claude.exe', cliArgsPrefix: [] }).respond('x', ctx(null)))
    expect(ev.at(-1)).toMatchObject({ type: 'done', errorKind: 'missing' })
  })
  it('stop() kills the process and still ends the stream', async () => {
    const brain = new ClaudeCliBrain(opts)
    const it = brain.respond('hello', ctx(null))[Symbol.asyncIterator]()
    process.env.FAKE_DELAY_MS = '200'
    const first = await it.next()
    expect(first.done).toBe(false)
    brain.stop()
    let last = first.value
    for (;;) { const n = await it.next(); if (n.done) break; last = n.value }
    delete process.env.FAKE_DELAY_MS
    expect(last.type).toBe('done')
  })
})
```

- [ ] **Step 5: Write `src/main/brain/claude-cli.ts`**

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { buildCliArgs } from './args'
import { StreamReducer } from './stream'
import type { Brain, BrainContext, BrainEvent } from './types'

export interface CliBrainOptions {
  cliPath: string; cliArgsPrefix?: string[]; personaPrompt: string; mcpUrl: string; token: string
  allowedTools: string[]; extraDirs: string[]; hookCommand: string; hookTimeoutSec: number; log?: (line: string) => void
}

class AsyncQueue<T> {
  private items: T[] = []
  private waiters: Array<(v: IteratorResult<T>) => void> = []
  private closed = false
  push(v: T): void { const w = this.waiters.shift(); if (w) w({ value: v, done: false }); else this.items.push(v) }
  close(): void { this.closed = true; for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true }) }
  next(): Promise<IteratorResult<T>> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false })
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
    return new Promise(r => this.waiters.push(r))
  }
}

export class ClaudeCliBrain implements Brain {
  private child: ChildProcess | null = null
  constructor(private readonly o: CliBrainOptions) {}

  async *respond(prompt: string, ctx: BrainContext): AsyncIterable<BrainEvent> {
    const newSessionId = randomUUID()
    const args = [...(this.o.cliArgsPrefix ?? []), ...buildCliArgs({
      sessionId: ctx.sessionId, newSessionId, personaPrompt: this.o.personaPrompt, mcpUrl: this.o.mcpUrl, token: this.o.token,
      allowedTools: this.o.allowedTools, model: ctx.model, extraDirs: this.o.extraDirs,
      hookCommand: this.o.hookCommand, hookTimeoutSec: this.o.hookTimeoutSec,
    })]
    const env = { ...process.env }
    delete env.CLAUDECODE; delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_ENTRYPOINT
    const queue = new AsyncQueue<BrainEvent>()
    const reducer = new StreamReducer()
    let sawDone = false
    let spawnFailed = false
    let stderr = ''
    const emit = (evs: BrainEvent[]) => { for (const e of evs) { if (e.type === 'done') sawDone = true; queue.push(e) } }

    let child: ChildProcess
    try {
      child = spawn(this.o.cliPath, args, { cwd: ctx.workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      yield { type: 'done', error: (e as Error).message, errorKind: 'missing' }; return
    }
    this.child = child
    child.on('error', (e: NodeJS.ErrnoException) => {
      spawnFailed = true
      emit([{ type: 'done', error: e.message, errorKind: e.code === 'ENOENT' ? 'missing' : 'exit' }]); queue.close()
    })
    child.stderr?.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-2000); this.o.log?.(`[stderr] ${c}`) })
    const rl = createInterface({ input: child.stdout! })
    rl.on('line', (line) => { this.o.log?.(line); emit(reducer.feed(line)) })
    rl.on('close', () => {
      if (spawnFailed || sawDone) { queue.close(); return }
      const code = child.exitCode
      emit(reducer.end(code, code === 0 ? '' : stderr))
      if (!sawDone) emit([{ type: 'done', sessionId: reducer.sessionId ?? (ctx.sessionId ?? newSessionId), errorKind: code === 0 ? undefined : 'exit', error: code === 0 ? undefined : `exit code ${code}` }])
      queue.close()
    })
    child.stdin?.end(prompt)

    for (;;) {
      const n = await queue.next()
      if (n.done) break
      const ev = n.value
      if (ev.type === 'done' && !ev.sessionId) ev.sessionId = reducer.sessionId ?? (ctx.sessionId ?? newSessionId)
      yield ev
      if (ev.type === 'done') break
    }
    this.child = null
  }

  stop(): void {
    const c = this.child
    if (!c) return
    try { c.kill() } catch { /* already gone */ }
    if (process.platform === 'win32' && c.pid) {
      try { spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { windowsHide: true }) } catch { /* ignore */ }
    }
  }
}
```

Run: `npx vitest run src/main/brain/claude-cli.test.ts`
Expected: 6 PASS. The `stop()` test relies on `readline` closing when the killed process's stdout ends, which then emits the exit `done`.

- [ ] **Step 6: Commit**

```bash
git add src/main/brain/args.ts src/main/brain/args.test.ts src/main/brain/claude-cli.ts src/main/brain/claude-cli.test.ts test/fake-claude.cjs
git commit -m "feat: ClaudeCliBrain spawning the CLI per turn, with a fake CLI for tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Local server with the buddy MCP tools and the permission endpoint, plus the hook script

**Files:**
- Create: `src/main/tools.ts`, `src/main/server.ts`, `src/main/server.test.ts`, `src/hook/permission-hook.cjs`

**Interfaces:**
- Consumes: `BuddyActions` (Plan A Task 9), `toolLabel` (Task 1).
- Produces:

```ts
// tools.ts
export function registerBuddyTools(server: McpServer, actions: BuddyActions): void
// server.ts
export interface PermissionRequestInfo { id: string; toolName: string; input: Record<string, unknown>; summary: string }
export interface LocalServerOptions { actions: BuddyActions; onPermission: (req: PermissionRequestInfo) => void; permissionTimeoutMs: number }
export class LocalServer {
  readonly token: string
  constructor(opts: LocalServerOptions)
  start(): Promise<void>                 // 127.0.0.1, random port
  stop(): Promise<void>
  get port(): number
  get mcpUrl(): string                   // http://127.0.0.1:<port>/mcp
  answer(id: string, allow: boolean): boolean
  get pendingCount(): number
}
export function permissionSummary(toolName: string, input: Record<string, unknown>): string
```

The hook script is run by the CLI as `node "<repo>/src/hook/permission-hook.cjs" --port P --token T --timeout MS`. It is referenced by its source path because packaging is out of scope for slice 1. The MCP endpoint is stateless: a fresh `McpServer` and transport per request, so the CLI's `initialize` and `tools/call` need no shared session.

- [ ] **Step 1: Install the MCP SDK**

```bash
npm install @modelcontextprotocol/sdk@latest
npm run typecheck
```

If typecheck reports zod type conflicts inside the SDK's tool registration, the installed SDK expects zod 3: run `npm install zod@^3.25` and re-run typecheck. Plan A's pack schema is compatible with both zod 3 and 4.

- [ ] **Step 2: Write `src/main/tools.ts`**

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BuddyActions } from './actions'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const MOODS = ['calm', 'happy', 'thinking', 'confused', 'alarmed'] as const
const EMOTES = ['happy', 'thinking', 'confused', 'alarmed', 'look', 'hop'] as const

export function registerBuddyTools(server: McpServer, actions: BuddyActions): void {
  server.registerTool('go_to',
    { description: 'Walk or run to a horizontal position, 0 (left edge) to 100 (right edge). Returns on arrival.',
      inputSchema: { x: z.number().min(0).max(100), run: z.boolean().optional() } },
    async ({ x, run }) => { await actions.goTo(x / 100, { run }); return text(`arrived at ${x}%`) })
  server.registerTool('set_mood',
    { description: 'Set your standing mood. Plays the matching reaction once.', inputSchema: { mood: z.enum(MOODS) } },
    async ({ mood }) => { actions.setMood(mood); return text(`mood is now ${mood}`) })
  server.registerTool('emote',
    { description: 'Play a one-off reaction without changing mood.', inputSchema: { kind: z.enum(EMOTES) } },
    async ({ kind }) => { await actions.emote(kind); return text(`emoted ${kind}`) })
  server.registerTool('sleep', { description: 'Lie down and sleep until woken.', inputSchema: {} },
    async () => { actions.sleep(); return text('sleeping') })
  server.registerTool('wake', { description: 'Wake up.', inputSchema: {} },
    async () => { actions.wake(); return text('awake') })
  server.registerTool('get_state', { description: 'Your current position, facing, activity, and mood.', inputSchema: {} },
    async () => text(JSON.stringify(actions.getState())))
}
```

If your SDK version lacks `registerTool`, use `server.tool(name, description, shape, handler)` with the same arguments in that order.

- [ ] **Step 3: Write the failing server tests**

`src/main/server.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LocalServer, permissionSummary, type PermissionRequestInfo } from './server'
import type { BuddyActions } from './actions'

const calls: string[] = []
const actions = {
  goTo: async (x: number, o?: { run?: boolean }) => { calls.push(`goTo ${x} ${o?.run ?? false}`) },
  setMood: (m: string) => { calls.push(`mood ${m}`) },
  emote: async (k: string) => { calls.push(`emote ${k}`) },
  say() {}, openPanel() {}, closePanel() {}, sleep: () => calls.push('sleep'), wake: () => calls.push('wake'),
  getState: () => ({ x: 0.25, facing: 'left', activity: 'idle', mood: 'calm', panelOpen: false, asleep: false }),
} as unknown as BuddyActions

const requests: PermissionRequestInfo[] = []
let server: LocalServer
beforeAll(async () => {
  server = new LocalServer({ actions, onPermission: r => requests.push(r), permissionTimeoutMs: 300 })
  await server.start()
})
afterAll(async () => { await server.stop() })

async function client() {
  const c = new Client({ name: 'test', version: '0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(server.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }))
  return c
}

describe('LocalServer MCP', () => {
  it('lists and calls the buddy tools', async () => {
    const c = await client()
    const names = (await c.listTools()).tools.map(t => t.name).sort()
    expect(names).toEqual(['emote', 'get_state', 'go_to', 'set_mood', 'sleep', 'wake'])
    await c.callTool({ name: 'set_mood', arguments: { mood: 'happy' } })
    await c.callTool({ name: 'go_to', arguments: { x: 40, run: true } })
    const st = await c.callTool({ name: 'get_state', arguments: {} }) as { content: Array<{ text: string }> }
    expect(JSON.parse(st.content[0]!.text).x).toBe(0.25)
    expect(calls).toEqual(['mood happy', 'goTo 0.4 true'])
    await c.close()
  })
  it('rejects requests without the bearer token', async () => {
    const r = await fetch(server.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
    expect(r.status).toBe(401)
  })
})

describe('LocalServer permissions', () => {
  const post = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/permission`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) })
  it('surfaces a request and returns the answer', async () => {
    const p = post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_use_id: 't1' })
    await new Promise(r => setTimeout(r, 20))
    expect(requests.at(-1)).toMatchObject({ toolName: 'Bash', summary: 'git status' })
    expect(server.pendingCount).toBe(1)
    expect(server.answer(requests.at(-1)!.id, true)).toBe(true)
    expect(await (await p).json()).toEqual({ decision: 'allow', reason: 'operator sanctioned' })
    expect(server.answer('nope', true)).toBe(false)
  })
  it('denies after the timeout', async () => {
    const r = await post({ tool_name: 'Write', tool_input: { file_path: 'a.txt' } })
    expect(await r.json()).toEqual({ decision: 'deny', reason: 'timed out' })
  })
  it('the hook script round-trips a decision', async () => {
    const hook = join(__dirname, '../hook/permission-hook.cjs')
    const child = spawn(process.execPath, [hook, '--port', String(server.port), '--token', server.token, '--timeout', '5000'], { windowsHide: true })
    let out = ''; child.stdout.on('data', c => out += c)
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, tool_use_id: 't2' }))
    await new Promise(r => setTimeout(r, 100))
    server.answer(requests.at(-1)!.id, false)
    await new Promise<void>(r => child.on('close', () => r()))
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: 'deny', decisionReason: 'operator denied' } })
  })
  it('the hook denies when the server is unreachable', async () => {
    const hook = join(__dirname, '../hook/permission-hook.cjs')
    const child = spawn(process.execPath, [hook, '--port', '1', '--token', 'x', '--timeout', '1000'], { windowsHide: true })
    let out = ''; child.stdout.on('data', c => out += c)
    child.stdin.end('{}')
    await new Promise<void>(r => child.on('close', () => r()))
    expect(JSON.parse(out).hookSpecificOutput.decision).toBe('deny')
  })
})

describe('permissionSummary', () => {
  it('picks the salient input', () => {
    expect(permissionSummary('Bash', { command: 'git status' })).toBe('git status')
    expect(permissionSummary('Edit', { file_path: 'C:\\a\\b.ts' })).toBe('C:\\a\\b.ts')
    expect(permissionSummary('Other', { q: 1 })).toBe('{"q":1}')
  })
})
```

- [ ] **Step 4: Write `src/hook/permission-hook.cjs`**

```js
#!/usr/bin/env node
// PermissionRequest hook for Claude Code: forwards the request to the buddy app and prints its decision.
const http = require('node:http')
const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const port = Number(flag('--port'))
const token = flag('--token') || ''
const timeoutMs = Number(flag('--timeout') || 120000)

function reply(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision, decisionReason: reason } }))
  process.exit(0)
}
let input = ''
process.stdin.on('data', (c) => { input += c })
process.stdin.on('end', () => {
  const body = input.trim() || '{}'
  const req = http.request({ host: '127.0.0.1', port, path: '/permission', method: 'POST', timeout: timeoutMs,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(body) } },
    (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { const j = JSON.parse(data); reply(j.decision === 'allow' ? 'allow' : 'deny', j.reason || '') }
        catch { reply('deny', 'bad response from buddy') }
      })
    })
  req.on('timeout', () => { req.destroy(); reply('deny', 'timed out waiting for operator') })
  req.on('error', (e) => reply('deny', `buddy unreachable: ${e.message}`))
  req.end(body)
})
```

- [ ] **Step 5: Write `src/main/server.ts`**

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { BuddyActions } from './actions'
import { registerBuddyTools } from './tools'

export interface PermissionRequestInfo { id: string; toolName: string; input: Record<string, unknown>; summary: string }
export interface LocalServerOptions { actions: BuddyActions; onPermission: (req: PermissionRequestInfo) => void; permissionTimeoutMs: number }

export function permissionSummary(toolName: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.url === 'string') return input.url
  if (typeof input.pattern === 'string') return input.pattern
  return JSON.stringify(input)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c: Buffer) => { data += c.toString() })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
}

export class LocalServer {
  readonly token = randomBytes(24).toString('hex')
  private server: Server | null = null
  private _port = 0
  private readonly pending = new Map<string, { resolve: (d: { decision: 'allow' | 'deny'; reason: string }) => void; timer: NodeJS.Timeout }>()

  constructor(private readonly o: LocalServerOptions) {}
  get port(): number { return this._port }
  get mcpUrl(): string { return `http://127.0.0.1:${this._port}/mcp` }
  get pendingCount(): number { return this.pending.size }

  start(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res) })
    return new Promise((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const a = this.server!.address()
        this._port = typeof a === 'object' && a ? a.port : 0
        resolve()
      })
    })
  }
  stop(): Promise<void> {
    for (const [id] of this.pending) this.answer(id, false)
    return new Promise((resolve) => { this.server ? this.server.close(() => resolve()) : resolve() })
  }

  answer(id: string, allow: boolean): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve({ decision: allow ? 'allow' : 'deny', reason: allow ? 'operator sanctioned' : 'operator denied' })
    return true
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${this.token}`) { json(res, 401, { error: 'unauthorized' }); return }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req)
        const parsed = body ? JSON.parse(body) : undefined
        const mcp = new McpServer({ name: 'buddy', version: '1.0.0' })
        registerBuddyTools(mcp, this.o.actions)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => { void transport.close(); void mcp.close() })
        await mcp.connect(transport)
        await transport.handleRequest(req, res, parsed)
        return
      }
      if (url.pathname === '/permission' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { tool_name?: string; tool_input?: Record<string, unknown> }
        const toolName = body.tool_name ?? 'unknown'
        const input = body.tool_input ?? {}
        const id = randomUUID()
        const decision = await new Promise<{ decision: 'allow' | 'deny'; reason: string }>((resolve) => {
          const timer = setTimeout(() => { this.pending.delete(id); resolve({ decision: 'deny', reason: 'timed out' }) }, this.o.permissionTimeoutMs)
          this.pending.set(id, { resolve, timer })
          this.o.onPermission({ id, toolName, input, summary: permissionSummary(toolName, input) })
        })
        json(res, 200, decision)
        return
      }
      json(res, 404, { error: 'not found' })
    } catch (e) {
      json(res, 500, { error: (e as Error).message })
    }
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/main/server.test.ts`
Expected: 7 PASS. If `listTools` hangs, confirm the client transport was given the `Accept` headers by the SDK (it sets them) and that `handleRequest` received `parsed` rather than a raw string.

- [ ] **Step 7: Commit**

```bash
git add src/main/tools.ts src/main/server.ts src/main/server.test.ts src/hook/permission-hook.cjs package.json package-lock.json
git commit -m "feat: local MCP server with buddy tools, permission endpoint, hook script

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Wire the brain, server, permission cards, and mood coupling into the app

**Files:**
- Modify: `src/main/chat.ts`, `src/main/chat.test.ts`, `src/main/index.ts`

**Interfaces:**
- Consumes: `ClaudeCliBrain` (Task 2), `LocalServer`, `PermissionRequestInfo` (Task 3), `ChatController` (Plan A Task 10), `ChatPermissionPayload` (Plan A Task 7).
- Produces:

```ts
// chat.ts additions
export interface ChatOut { ...; permission(p: ChatPermissionPayload): void }
constructor deps gain: permissions?: { answer(id: string, allow: boolean): boolean }
permissionRequest(req: PermissionRequestInfo): void       // opens the panel and shows the card
permissionAnswer(id: string, allow: boolean): void        // now real
```

Behavior added to `ChatController.ask()`: on the first `activity` event of a turn, remember the current mood and call `setMood('thinking')`, and publish status with `session: 'thinking'`; on `done`, if the mood is still `thinking`, restore the remembered mood (if Claude changed it through a tool, leave it); map `errorKind` to pack lines: `auth` to `authError`, `missing` to `cliMissing`, anything else to `error` followed by the raw message; publish status with the error text.

- [ ] **Step 1: Add the failing tests to `src/main/chat.test.ts`**

Extend `fakeOut()` with `permissions: [] as unknown[]` and `permission(p: unknown) { o.permissions.push(p) }`. Extend `fakeActions()` so `getState` returns a mutable object whose `mood` is updated by `setMood` (`a.state = {...}; setMood: m => { a.calls.push(...); a.state.mood = m }`, `getState: () => a.state`) and add `opened: 0` incremented by `openPanel`. Then add:

```ts
describe('ChatController brain coupling', () => {
  it('sets thinking on the first activity and restores the mood on done', async () => {
    const out = fakeOut(); const a = fakeActions()
    const c = new ChatController({ brain: scriptedBrain([
      { type: 'activity', id: 't1', label: 'reading x', toolName: 'Read' },
      { type: 'activity', id: 't1', label: 'reading x', toolName: 'Read', done: true },
      { type: 'text', delta: 'ok' }, { type: 'done', sessionId: 's' }]), actions: a, pack, out, settings: settings() })
    c.prompt('look at x')
    await new Promise(r => setTimeout(r, 10))
    expect(a.calls).toEqual(['mood thinking', 'mood calm'])
    expect(out.statuses.some(s => (s as { session: string }).session === 'thinking')).toBe(true)
  })
  it('keeps a mood Claude set through a tool', async () => {
    const out = fakeOut(); const a = fakeActions()
    const brain: Brain = { async *respond() { yield { type: 'activity', id: 't', label: 'l', toolName: 'Read' }; a.setMood('happy'); yield { type: 'done' } }, stop() {} }
    new ChatController({ brain, actions: a, pack, out, settings: settings() }).prompt('x')
    await new Promise(r => setTimeout(r, 10))
    expect(a.calls).toEqual(['mood thinking', 'mood happy'])
  })
  it('maps error kinds to pack lines', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'done', error: 'Not logged in', errorKind: 'auth' }]), actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('x'); await new Promise(r => setTimeout(r, 10))
    expect(out.systems.at(-1)).toContain('claude login')
    expect((out.statuses.at(-1) as { error?: string }).error).toContain('Not logged in')
  })
  it('surfaces permission requests and forwards answers', () => {
    const out = fakeOut(); const a = fakeActions(); const answers: string[] = []
    const c = new ChatController({ brain: scriptedBrain([]), actions: a, pack, out, settings: settings(),
      permissions: { answer: (id, allow) => { answers.push(`${id}:${allow}`); return true } } })
    c.permissionRequest({ id: 'p1', toolName: 'Bash', input: { command: 'git status' }, summary: 'git status' })
    expect(a.opened).toBe(1)
    expect(out.permissions[0]).toMatchObject({ id: 'p1', toolName: 'Bash', summary: 'git status' })
    c.permissionAnswer('p1', false)
    expect(answers).toEqual(['p1:false'])
    expect(out.systems.at(-1)).toBeDefined()
  })
})
```

The fixture pack has no `authError` line, so add `"authError": ["Run claude login."]` and `"permissionAsk": ["Sanction?"]`, `"permissionDenied": ["Denied."]` to `test/fixtures/pack-min/manifest.json` lines.

- [ ] **Step 2: Update `src/main/chat.ts`**

Add to the imports: `import type { ChatPermissionPayload } from '../shared/ipc'` and `import type { PermissionRequestInfo } from './server'`. Add `permission(p: ChatPermissionPayload): void` to `ChatOut`. Add `permissions?: { answer(id: string, allow: boolean): boolean }` to the constructor deps type. Replace `ask()` and the two permission methods with:

```ts
  private async ask(text: string): Promise<void> {
    this.running = true
    let prevMood: Mood | null = null
    const line = (k: LineKey, fallback: string) => pickLine(this.deps.pack, k) ?? fallback
    try {
      const ctx = { state: this.deps.actions.getState(), workspace: this.settings.workspace,
        model: this.settings.model, sessionId: this.settings.sessionId }
      for await (const ev of this.deps.brain.respond(text, ctx)) {
        if (ev.type === 'text') this.deps.out.delta(ev.delta)
        else if (ev.type === 'activity') {
          if (prevMood === null) {
            prevMood = this.deps.actions.getState().mood
            this.deps.actions.setMood('thinking')
            this.deps.out.status({ ...this.status(), session: 'thinking' })
          }
          this.deps.out.activity({ id: ev.id, label: ev.label, done: ev.done ?? false })
        }
        else if (ev.type === 'status') this.deps.out.system(ev.text)
        else if (ev.type === 'done') {
          if (ev.sessionId) this.settings.sessionId = ev.sessionId
          if (prevMood !== null && this.deps.actions.getState().mood === 'thinking') this.deps.actions.setMood(prevMood)
          if (ev.error) {
            const msg = ev.errorKind === 'auth' ? line('authError', 'Not logged in. Run claude login.')
              : ev.errorKind === 'missing' ? line('cliMissing', 'Claude CLI not found.')
              : `${line('error', 'Error.')} ${ev.error}`
            this.deps.out.system(msg)
            this.deps.out.status({ ...this.status(), error: ev.error.slice(0, 120) })
          } else {
            this.settingsChanged()
          }
          this.deps.out.done({ error: ev.error })
        }
      }
    } catch (e) {
      this.deps.out.system(`${line('error', 'Error.')} ${(e as Error).message}`)
      this.deps.out.done({ error: (e as Error).message })
    } finally {
      this.running = false
    }
  }

  permissionRequest(req: PermissionRequestInfo): void {
    if (!this.deps.actions.getState().panelOpen) this.deps.actions.openPanel()
    this.deps.out.permission({ id: req.id, toolName: req.toolName, summary: req.summary,
      line: pickLine(this.deps.pack, 'permissionAsk') ?? 'Allow this tool?' })
  }

  permissionAnswer(id: string, allow: boolean): void {
    this.deps.permissions?.answer(id, allow)
    if (!allow) this.deps.out.system(pickLine(this.deps.pack, 'permissionDenied') ?? 'Denied.')
  }
```

Import `Mood` and `LineKey` from `../shared/types`. Note `settingsChanged()` on a successful `done` also refreshes the status row from `thinking` back to the session id.

Run: `npx vitest run src/main/chat.test.ts`
Expected: 10 PASS.

- [ ] **Step 3: Update `src/main/index.ts`**

Add imports:

```ts
import { appendFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { expandEnv } from './config'
import { LocalServer } from './server'
import { ClaudeCliBrain } from './brain/claude-cli'
import type { Brain } from './brain/types'
```

After `const actions = new Actions(buddy, host)` and before the `ChatController` construction, add:

```ts
  const logDir = join(app.getPath('userData'), 'logs'); mkdirSync(logDir, { recursive: true })
  const log = (line: string) => { try { appendFileSync(join(logDir, 'cli.log'), line + '\n') } catch { /* ignore */ } }

  let chat!: ChatController
  const server = new LocalServer({ actions, onPermission: (r) => chat.permissionRequest(r),
    permissionTimeoutMs: config.permissionTimeoutSec * 1000 })
  await server.start()

  if (spawnSync('node', ['--version'], { windowsHide: true }).status !== 0) {
    dialog.showErrorBox('Node.js required', 'The permission hook runs with "node" on PATH. Install Node.js and restart.')
  }
  const hookPath = join(app.getAppPath(), 'src', 'hook', 'permission-hook.cjs')
  const hookCommand = `node "${hookPath}" --port ${server.port} --token ${server.token} --timeout ${config.permissionTimeoutSec * 1000}`
  const fake = process.env.BUDDY_FAKE_CLI === '1'
  const brain: Brain = new ClaudeCliBrain({
    cliPath: fake ? 'node' : expandEnv(config.cliPath),
    cliArgsPrefix: fake ? [join(app.getAppPath(), 'test', 'fake-claude.cjs')] : [],
    personaPrompt: pack.persona.prompt, mcpUrl: server.mcpUrl, token: server.token,
    allowedTools: config.allowedTools, extraDirs: config.extraDirs,
    hookCommand, hookTimeoutSec: config.permissionTimeoutSec + 10, log,
  })
```

Change the `ChatController` construction to `chat = new ChatController({ brain, actions, pack, out, permissions: server, settings: ..., onSettingsChange: ... })` (drop `const` and the `EchoBrain` import; keep `EchoBrain` available behind `process.env.BUDDY_ECHO === '1'` if you want an offline mode: `const brain: Brain = process.env.BUDDY_ECHO === '1' ? new EchoBrain(pack, actions) : new ClaudeCliBrain(...)`). Add to `out`: `permission: (p: ChatPermissionPayload) => hologram.webContents.send(CH.chatPermission, p)` and add `ChatPermissionPayload` to the `../shared/ipc` type import. `logDir` already exists from Plan A Task 11, so drop the duplicate `mkdirSync` line above if it is already there. Add `app.on('before-quit', () => { void server.stop() })`.

- [ ] **Step 4: Typecheck, unit tests, commit**

Run: `npm run typecheck && npx vitest run`
Expected: exit 0, all pass.

```bash
git add src/main/chat.ts src/main/chat.test.ts src/main/index.ts test/fixtures/pack-min/manifest.json
git commit -m "feat: wire the Claude CLI brain, MCP server, and permission cards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Verify against the real CLI, then lock it with a fake-CLI end-to-end test

**Files:**
- Create: `e2e/brain.spec.ts`
- Modify (only if the inline settings fallback is needed): `src/main/brain/args.ts`, `src/main/brain/claude-cli.ts`

- [ ] **Step 1: Real CLI, no tools**

Run `npm run dev`, click him, type `introduce yourself in two sentences`. Expected: text streams in the persona voice, the status row shows the session id afterwards, `%APPDATA%\mechanicus-buddy\logs\cli.log` holds the stream-json lines. If the status row shows the `authError` line, run `claude login` in a terminal and try again.

- [ ] **Step 2: Real CLI, pre-approved tools**

Type `list the typescript files under src/main and pick one to describe`. Expected: activity rows such as `finding **/*.ts` and `reading main/buddy.ts` appear and dim when done; he holds the thinking pose while they run; no permission card.

- [ ] **Step 3: Real CLI, body tools**

Type `you just found a bug, react accordingly, then walk to the left edge`. Expected: a mood or emote plays mid-reply and he walks left; the panel follows.

- [ ] **Step 4: Real CLI, permission card**

Type `run git status in the workspace`. Expected: the hologram shows the `permissionAsk` line, `Bash: git status`, and Sanction and Deny buttons. Deny: he reports it was denied. Repeat and Sanction: the command runs and the output is summarized.

If no card appears and the reply says the tool was denied or not permitted, the inline `--settings` hook did not register. Apply the fallback: in `args.ts` change `settingsJson(...)` usage so `buildCliArgs` takes `settingsArg: string` and passes it verbatim after `--settings`; in `claude-cli.ts` write the JSON to `join(tmpdir(), \`buddy-settings-${process.pid}.json\`)` once in the constructor and pass that path. Re-run this step. Record which mode worked in `docs/superpowers/specs/2026-09-03-mechanicus-buddy-design.md` section 17 item 1.

- [ ] **Step 5: Write `e2e/brain.spec.ts`**

```ts
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}
const state = (app: ElectronApplication) => app.evaluate(() => (globalThis as { __buddy?: { getState(): { mood: string; panelOpen: boolean } } }).__buddy!.getState())
async function send(page: Page, text: string) { await page.locator('#input').fill(text); await page.locator('#input').press('Enter') }

test('fake CLI: activity rows, MCP mood tool, permission deny and allow', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, BUDDY_TEST: '1', BUDDY_FAKE_CLI: '1', FAKE_DELAY_MS: '20' } })
  await windowByUrl(app, 'overlay')
  await app.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  const h = await windowByUrl(app, 'hologram')

  await send(h, 'please read a file')
  await expect(h.locator('.activity')).toContainText('reading x/file.ts', { timeout: 15000 })
  await expect(h.locator('.activity.done')).toHaveCount(1, { timeout: 15000 })
  await expect(h.locator('.msg.buddy').last()).toContainText('You said: please read a file')

  await send(h, 'be happy')
  await expect.poll(async () => (await state(app)).mood, { timeout: 15000 }).toBe('happy')

  await send(h, 'run something')
  await expect(h.locator('#permission')).toBeVisible({ timeout: 15000 })
  await expect(h.locator('#perm-detail')).toContainText('git status')
  await h.locator('#perm-deny').click()
  await expect(h.locator('.msg.buddy').last()).toContainText('Denied', { timeout: 15000 })

  await send(h, 'run something')
  await expect(h.locator('#permission')).toBeVisible({ timeout: 15000 })
  await h.locator('#perm-allow').click()
  await expect(h.locator('.msg.buddy').last()).toContainText('Executed git status', { timeout: 15000 })

  await send(h, 'fail auth')
  await expect(h.locator('.msg.system').last()).toContainText('claude login', { timeout: 15000 })
  await app.close()
})
```

- [ ] **Step 6: Run both e2e suites**

Run: `npm run test:e2e`
Expected: 2 passed (`body.spec.ts` from Plan A and `brain.spec.ts`).

- [ ] **Step 7: Commit**

```bash
git add e2e/brain.spec.ts src/main/brain docs/superpowers/specs
git commit -m "test: fake-CLI end-to-end for tools, MCP mood, and permissions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Done criteria for Plan B

- `npx vitest run` green, including stream, args, claude-cli, server, and the extended chat tests.
- `npm run test:e2e` green for both specs without spending quota.
- Manual steps 1 to 4 of Task 5 passed against the real CLI, and the settings mode that worked is recorded in the spec.
- `%APPDATA%\mechanicus-buddy\logs\cli.log` shows the stream for each turn, and the process list shows no lingering `claude.exe` after `/stop`.