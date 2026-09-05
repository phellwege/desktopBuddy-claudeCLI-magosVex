# Plan B: Claude Code Brain Implementation Plan

> **Amendment (2026-09-04):** permissions go through the CLI's own `--permission-prompt-tool`
> MCP tool now, not the `PermissionRequest` hook described in Task 5/6 below. See spec section
> 6.4 (amended) for the current design. Task 5 and Task 6 below are historical: they describe
> the hook-based design as it was implemented and later withdrawn, and are left unedited as a
> record of that history rather than rewritten to match the current code.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code, running on the user's subscription through the installed CLI, answers in the hologram, sees files through its own tools, drives the character through a small MCP tool set, asks before running anything beyond reading, and stamps each reply with an expression face.

**Architecture:** `ClaudeCliBrain` implements the existing `Brain` seam by spawning `claude.exe` per turn in stream-json print mode and mapping its output through a pure parser to `BrainEvent`s. Main hosts a local HTTP server with a bearer token that serves the buddy MCP tools and the permission-hook endpoint. Two prerequisites (arrival timeout, navigation block) and two UX fixes (emotes while projecting, per-message faces) land first so the model-driven body is safe and visible.

**Tech Stack:** Electron + TypeScript, vitest, Playwright; `@modelcontextprotocol/sdk` (Streamable HTTP server); Node `child_process` and `http`; zod.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-04-plan-b-brain-design.md`. Displayed text is Claude Code's output unaltered; the system prompt append is only the tools note in spec 6.1; no persona text reaches the CLI.
- No Anthropic API key anywhere. The child environment is the parent's minus `CLAUDECODE` and `ANTHROPIC_API_KEY`.
- Renderers have no Node access; all IPC goes through `src/shared/ipc.ts`'s `CH` table and the preload bridge; every `on*` bridge method returns an unsubscribe function.
- Expression names: `neutral | happy | disbelief | irritation | anger | love | sadness | cringe | begging`. Pack map: neutral faces_0, happy faces_1, disbelief faces_2, irritation faces_3, anger faces_4, love faces_6, sadness faces_7, cringe faces_8, begging faces_9. faces_5 unused.
- Mood axis unchanged: `calm | happy | thinking | confused | alarmed`.
- Config fields already exist in `src/main/config.ts`: `cliPath` (default `%USERPROFILE%\.local\bin\claude.exe`), `workspace` (`C:\repo`), `extraDirs`, `model` (null), `allowedTools` (`["Read", "Glob", "Grep", "mcp__buddy__*"]`), `permissionTimeoutSec` (120).
- Test commands: `npx vitest run`, `npm run typecheck`, `npm run build`, `npm run test:e2e` (the e2e must keep passing with the echo brain; `BUDDY_BRAIN=echo` forces it).
- No em dashes in code, comments, or docs. Application code never names the Mechanicus. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Existing seams (do not rename): `Brain`, `BrainEvent`, `BrainContext` in `src/main/brain/types.ts`; `ChatController` in `src/main/chat.ts` (commands switch, `turnSerial`, `settings`); `Actions` in `src/main/actions.ts`; `Buddy` in `src/main/buddy.ts`; `ChatDonePayload`, `ChatSystemPayload`, `ChatPermissionPayload` in `src/shared/ipc.ts`; the hologram's `add(cls, html)`, `flush()`, and permission card in `src/renderer/hologram/main.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/main/buddy.ts` | projecting rule: emotes play and return to project; sleep closes the panel first |
| `src/main/chat.ts` | command confirmations; expression event handling; permission answer routing |
| `src/shared/types.ts` | `Expression` type, `EXPRESSIONS` list, `Animations.faces` |
| `src/main/pack.ts` | `faces` block validation and fallback |
| `src/shared/ipc.ts`, `src/preload/index.ts` | `expression` on done and system payloads; `pack:loaded` to the hologram |
| `src/renderer/hologram/face.ts` (new) | `HoloFace` renderer: tinted, scanlined, flickering face canvas |
| `src/renderer/hologram/main.ts`, `styles.css` | face inside each reply bubble |
| `src/main/brain/echo.ts` | emits an expression event |
| `src/main/actions.ts` | arrival timeout |
| `src/main/windows.ts` | navigation block on the hologram |
| `src/renderer/hologram/markdown.ts` | links render as text |
| `src/main/brain/stream.ts` (new) | pure stream-json line parser and activity labels |
| `src/main/brain/prompt.ts` (new) | tools note builder |
| `src/main/server.ts` (new) | local HTTP: MCP tools + `/permission`, bearer token |
| `src/hook/permission-hook.cjs` (new) | the CLI hook script |
| `src/main/brain/claude-cli.ts` (new) | `ClaudeCliBrain` |
| `src/main/index.ts` | brain selection, server start, auth status line |
| `test/fake-claude.cjs` (new), `test/fixtures/stream/*.jsonl` (new) | fake CLI and parser fixtures |
| `e2e/brain.spec.ts` (new) | fake-CLI end-to-end |
| `scripts/smoke-claude.mjs` (new) | on-demand real-CLI smoke |

---

### Task 1: Emotes and sleep while projecting; command confirmations

**Files:**
- Modify: `src/main/buddy.ts` (`emote`, `sleep`, `oneShotDone`, `animation`), `src/main/buddy.test.ts`, `src/main/chat.ts` (commands switch), `src/main/chat.test.ts`

**Interfaces:**
- Consumes: `Buddy.emote(kind): 'started' | 'queued' | 'dropped'`, `Buddy.sleep()`, `Buddy.closePanel()`, `ChatController` commands switch and `this.deps.out.system(text)`.
- Produces: while `projecting`, `emote()` returns `'started'`, plays the one-shot, and `oneShotDone()` returns the activity to `projecting`; `sleep()` while the panel is open closes the panel (activity leaves projecting, `panelOpen` false) and then sleeps immediately if restful; command confirmation lines exactly: `/goto` "moving to N%" (or "running to N%"), `/mood` "mood: X", `/emote` "emote: X", `/sleep` "sleeping", `/wake` "awake", `/stop` the pack's `stopped` line (fallback "stopped"), `/new` "new session", `/cd` "workspace: PATH", `/model` "model: NAME" (or "model: default" when cleared).

- [ ] **Step 1: Failing state-machine tests** (append to `src/main/buddy.test.ts`; use the file's existing `mk`/`seq` helpers and the `view()` accessors the other tests use)

```ts
it('an emote plays while projecting and returns to the project pose', () => {
  const b = mk({ rng: seq([0]) })
  b.tick(0); b.openPanel()
  expect(b.emote('happy')).toBe('started')
  expect(b.view().animation).toBe('emote_happy')
  b.oneShotDone()
  expect(b.view().activity).toBe('projecting')
  expect(b.view().animation).toBe('project')
})

it('sleep while the panel is open closes the panel and sleeps', () => {
  const b = mk({ rng: seq([0]) })
  b.tick(0); b.openPanel()
  b.sleep()
  expect(b.getState().panelOpen).toBe(false)
  expect(b.getState().asleep).toBe(true)
  expect(b.view().animation).toBe('sleep')
})
```

The existing test asserting that an emote is dropped while projecting must be updated to the new behavior (started, then back to projecting). `closePanel()` must notify the host that the panel closed: `Buddy` already emits view changes; main's `hidePanel` is driven by `Actions.closePanel`, so `sleep()` must call the same path. Implement `sleep()` as: if `panelOpen`, call `this.closePanel()` first (which sets `panelOpen` false and leaves projecting), then continue with the existing sleep logic. Main already hides the window when `panelOpen` flips false through `buddy.onChange` (verify in `src/main/index.ts`; if it only hides on `Actions.closePanel`, add an `onChange` check there: when `state.panelOpen` becomes false and the hologram is visible, hide it).

- [ ] **Step 2: Run, expect failures; implement in `src/main/buddy.ts`**

In `emote()`: replace `if (this.activity === 'projecting') return 'dropped'` with: if projecting, set `this.resumeActivity = 'projecting'`, start the emote as `beginEmote` does for restful states, and return `'started'`. In `oneShotDone()`'s emote-resume branch, resuming to `'projecting'` must keep `panelOpen` true and not call `applyThinkingIfRestful` unless mood is thinking (then the project pose becomes `emote_thinking` through `animation()` as today). Keep the `thinking` mood behavior.

- [ ] **Step 3: Failing chat tests** (append to `src/main/chat.test.ts`, using the file's fake `out`/`actions`/`brain` fixture)

```ts
it('every slash command confirms with one system line', async () => {
  const { ctrl, out } = setup()
  await ctrl.prompt('/goto 20'); expect(out.system).toHaveBeenLastCalledWith('moving to 20%')
  await ctrl.prompt('/run 80'); expect(out.system).toHaveBeenLastCalledWith('running to 80%')
  await ctrl.prompt('/mood happy'); expect(out.system).toHaveBeenLastCalledWith('mood: happy')
  await ctrl.prompt('/emote alarmed'); expect(out.system).toHaveBeenLastCalledWith('emote: alarmed')
  await ctrl.prompt('/sleep'); expect(out.system).toHaveBeenLastCalledWith('sleeping')
  await ctrl.prompt('/wake'); expect(out.system).toHaveBeenLastCalledWith('awake')
  await ctrl.prompt('/new'); expect(out.system).toHaveBeenLastCalledWith('new session')
  await ctrl.prompt('/cd C:\\x'); expect(out.system).toHaveBeenLastCalledWith('workspace: C:\\x')
  await ctrl.prompt('/model sonnet'); expect(out.system).toHaveBeenLastCalledWith('model: sonnet')
  await ctrl.prompt('/stop'); expect(out.system).toHaveBeenLastCalledWith('stopped')
})
```

If `setup()` does not exist under that name, use the file's existing fixture builder and adapt the name in the test only. `/stop`'s line comes from `deps.lines?.stopped` when the controller has pack lines, else "stopped"; give the controller an optional `lines` dep with `pickLine` semantics already used by `EchoBrain`.

- [ ] **Step 4: Implement the confirmations in `src/main/chat.ts`, run both test files, `npm run typecheck`, commit**

```bash
git add src/main/buddy.ts src/main/buddy.test.ts src/main/chat.ts src/main/chat.test.ts src/main/index.ts
git commit -m "feat: emotes play and sleep works while the panel is open; slash commands confirm

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Expression faces in reply bubbles

**Files:**
- Modify: `src/shared/types.ts`, `src/main/pack.ts`, `src/main/pack.test.ts`, `packs/mechanicus/animations.json`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/brain/types.ts`, `src/main/brain/echo.ts`, `src/main/chat.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/renderer/hologram/main.ts`, `src/renderer/hologram/styles.css`
- Create: `src/renderer/hologram/face.ts`, `src/renderer/hologram/face.test.ts`

**Interfaces:**
- Produces: `export type Expression = 'neutral' | 'happy' | 'disbelief' | 'irritation' | 'anger' | 'love' | 'sadness' | 'cringe' | 'begging'` and `export const EXPRESSIONS: readonly Expression[]` in `src/shared/types.ts`; `Animations.faces?: Partial<Record<Expression, string>>` resolved by the loader so `pack.faces: Record<Expression, string> | null` (null when the pack has no `faces` block; missing names fall back to `neutral`'s frame). `BrainEvent` gains `{ type: 'expression'; name: Expression }`. `ChatDonePayload.expression?: Expression`, `ChatSystemPayload.expression?: Expression`. `CH.packLoaded` is also sent to the hologram window with the same `PackLoadedPayload` plus `faces: Record<Expression, string> | null`. `HoloFace` in `face.ts`: `constructor(atlasImage: HTMLImageElement, atlas: Atlas, faces: Record<Expression, string>, accent: string)`, `render(expression: Expression, size = 56): HTMLCanvasElement` returning a canvas with the tinted, scanlined face; flicker is CSS (`.face { animation: holoflicker 3.1s infinite }` with opacity keyframes 0.62 to 0.78).

- [ ] **Step 1: Types, loader, pack data**

`src/shared/types.ts`: add `Expression`, `EXPRESSIONS`, and `faces?` on `Animations`. `src/main/pack.ts`: `RawAnimationsSchema` accepts an optional `faces` record of string to string; validation errors for a face name not in `EXPRESSIONS` or a frame not in the atlas; resolution fills missing names with `neutral`'s frame (error if `neutral` itself is missing when the block exists). `packs/mechanicus/animations.json`: add the `faces` block from Global Constraints. Tests in `src/main/pack.test.ts`: block absent gives `faces: null`; block with only `neutral` and `happy` gives every expression, with `disbelief` equal to `neutral`'s frame; unknown expression name errors; unknown frame errors; the Mechanicus pack test asserts nine mapped faces.

- [ ] **Step 2: Events and IPC**

`src/main/brain/types.ts`: add the `expression` event. `src/main/brain/echo.ts`: before `done`, yield `{ type: 'expression', name: Math.random() < 0.1 ? 'happy' : 'neutral' }` (inject the rng through the constructor so the test can force both). `src/main/chat.ts`: track `currentExpression` per turn (reset to `'neutral'` at turn start, set by the event), pass it in `out.done({ expression })`; system lines from the controller pass `expression: 'neutral'`. `src/shared/ipc.ts`: payload fields; `src/main/ipc.ts`: forward. `src/main/index.ts`: send `pack:loaded` (with `faces`) to the hologram on its `hologram:ready` as well as to the overlay. Test: `chat.test.ts` asserts the done payload carries the expression from a fake brain that yields `expression` then `done`, and `neutral` when none was yielded.

- [ ] **Step 3: Failing face test** (`src/renderer/hologram/face.test.ts`, jsdom environment as `markdown.test.ts` uses)

```ts
import { describe, it, expect } from 'vitest'
import { scanlineRows, tintAlpha } from './face'

describe('HoloFace helpers', () => {
  it('scanlines every third row', () => { expect(scanlineRows(9)).toEqual([0, 3, 6]) })
  it('tint alpha is constant and translucent', () => { expect(tintAlpha()).toBeCloseTo(0.55) })
})
```

jsdom has no canvas 2D context; keep the drawing untested at unit level and test the pure helpers only. The e2e (Task 7) asserts a `.face` canvas exists in a reply bubble.

- [ ] **Step 4: `src/renderer/hologram/face.ts`**

```ts
import type { Atlas } from '../../shared/types'
import type { Expression } from '../../shared/types'

export function scanlineRows(height: number): number[] { const rows: number[] = []; for (let y = 0; y < height; y += 3) rows.push(y); return rows }
export function tintAlpha(): number { return 0.55 }

export class HoloFace {
  constructor(private image: HTMLImageElement, private atlas: Atlas, private faces: Record<Expression, string>, private accent: string) {}
  render(expression: Expression, size = 56): HTMLCanvasElement {
    const f = this.atlas.frames[this.faces[expression] ?? this.faces.neutral]
    const c = document.createElement('canvas'); c.className = 'face'
    const scale = size / Math.max(f.w, f.h)
    c.width = Math.round(f.w * scale); c.height = Math.round(f.h * scale)
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(this.image, f.x, f.y, f.w, f.h, 0, 0, c.width, c.height)
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillStyle = this.accent; ctx.globalAlpha = tintAlpha(); ctx.fillRect(0, 0, c.width, c.height)
    ctx.globalAlpha = 0.25; ctx.fillStyle = '#000'
    for (const y of scanlineRows(c.height)) ctx.fillRect(0, y, c.width, 1)
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
    return c
  }
}
```

- [ ] **Step 5: Hologram wiring and CSS**

`src/renderer/hologram/main.ts`: on `pack:loaded`, load the atlas image with the same blob-URL loader the overlay uses and build `HoloFace` when `faces` is non-null; `add('buddy', ...)` creates the bubble with a `.row` wrapper: face slot on the left (empty until known), text on the right; on `chat:done` render the face for the payload's expression into the current bubble's slot; on `chat:system` render `neutral` (or the payload's expression) into the system bubble's slot; when there is no `HoloFace`, no slot is added. `styles.css`: `.msg.buddy, .msg.system { display: flex; gap: 10px; align-items: flex-start }`, `.face { flex: 0 0 auto; animation: holoflicker 3.1s ease-in-out infinite }`, `@keyframes holoflicker { 0%,100% { opacity: .72 } 37% { opacity: .64 } 61% { opacity: .78 } }`.

- [ ] **Step 6: Run `npx vitest run`, `npm run typecheck`, `npm run build`, commit**

```bash
git add src packs/mechanicus/animations.json
git commit -m "feat: expression face in each reply bubble, chosen per message

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Arrival timeout and navigation block

**Files:**
- Modify: `src/main/actions.ts`, `src/main/actions.test.ts`, `src/main/windows.ts`, `src/main/windows.test.ts`, `src/renderer/hologram/markdown.ts`, `src/renderer/hologram/markdown.test.ts`

**Interfaces:**
- Produces: `Actions.goTo` resolves on arrival or after `arrivalTimeoutMs(distance, speed)` = `Math.ceil(distance / speed * 1000) + 2000`, exported from `actions.ts`; on timeout it calls `buddy.arrived()` and `host.log('arrival timeout ...')` (add `log(line: string): void` to the `ActionHost` interface, wired to `appendLog` in main). `createHologramWindow` blocks `will-navigate` and denies `setWindowOpenHandler`. `renderMarkdown` renders links as `text (url)` plain text.

- [ ] **Step 1: Failing tests**

```ts
// actions.test.ts
it('goTo resolves through the arrival timeout when the renderer never reports', async () => {
  vi.useFakeTimers()
  const { actions, buddy, host } = setup()
  buddy.tick(0)
  const p = actions.goTo(0.9)
  vi.advanceTimersByTime(arrivalTimeoutMs(0.4, RUN_SPEED) + 1)
  await p
  expect(buddy.getState().activity).toBe('idle')
  expect(host.log).toHaveBeenCalledWith(expect.stringContaining('arrival timeout'))
  vi.useRealTimers()
})
// markdown.test.ts
it('links render as plain text with the url', () => {
  const html = renderMarkdown('see [docs](https://example.com)')
  expect(html).not.toContain('<a ')
  expect(html).toContain('docs (https://example.com)')
})
// windows.test.ts (fake BrowserWindow as the existing tests do)
it('hologram window blocks navigation and new windows', () => { /* assert will-navigate handler calls preventDefault and setWindowOpenHandler returns { action: 'deny' } */ })
```

Fill the windows test with the fake the file already uses: register handlers into a map, invoke `will-navigate` with a fake event whose `preventDefault` is a spy, and call the registered open handler expecting `{ action: 'deny' }`.

- [ ] **Step 2: Implement; run the three files; typecheck; commit**

```bash
git add src/main/actions.ts src/main/actions.test.ts src/main/windows.ts src/main/windows.test.ts src/renderer/hologram/markdown.ts src/renderer/hologram/markdown.test.ts src/main/index.ts
git commit -m "feat: arrival timeout for commanded moves; hologram blocks navigation; links render as text

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Stream parser, activity labels, tools note

**Files:**
- Create: `src/main/brain/stream.ts`, `src/main/brain/stream.test.ts`, `src/main/brain/prompt.ts`, `src/main/brain/prompt.test.ts`, `test/fixtures/stream/text.jsonl`, `test/fixtures/stream/tool.jsonl`, `test/fixtures/stream/error.jsonl`, `test/fixtures/stream/auth.jsonl`, `test/fixtures/stream/truncated.jsonl`

**Interfaces:**
- Produces:

```ts
// src/main/brain/stream.ts
export interface ParsedInit { sessionId: string; model?: string }
export type StreamOutput = BrainEvent | { type: 'init'; init: ParsedInit } | { type: 'ignore' }
export function parseStreamLine(line: string, buddyToolPrefix = 'mcp__buddy__'): StreamOutput[]
export function activityLabel(toolName: string, input: unknown): string   // "reading src/a.ts", "searching for TODO", "running: git status", "editing x.ts", "<tool>" fallback; max 80 chars
export function isAuthError(text: string): boolean                        // /authenticat|log ?in|unauthorized|api key/i
// src/main/brain/prompt.ts
export const EXPRESSION_NOTE: string
export function toolsNote(): string   // the exact text of spec 6.1, single paragraph
```

Fixtures are newline-delimited JSON in the real CLI shapes:
- `text.jsonl`: `{"type":"system","subtype":"init","session_id":"s1","model":"m"}`, two `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}` lines ("Hel", "lo"), one `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}`, and `{"type":"result","subtype":"success","is_error":false,"session_id":"s1","result":"Hello"}`.
- `tool.jsonl`: init; an `assistant` message with `{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/a.ts"}}`; a `user` message with `{"type":"tool_result","tool_use_id":"t1","content":"..."}`; an `assistant` message with a `tool_use` named `mcp__buddy__set_mood` (must produce no activity); a text delta; result success.
- `error.jsonl`: init; `{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"s1","result":"boom"}`.
- `auth.jsonl`: `{"type":"result","subtype":"error","is_error":true,"result":"Not logged in. Please run /login"}`.
- `truncated.jsonl`: init and one delta, no result.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseStreamLine, activityLabel, isAuthError } from './stream'
import { toolsNote } from './prompt'

const lines = (name: string) => readFileSync(join(__dirname, '../../../test/fixtures/stream', name), 'utf8').split('\n').filter(Boolean)
const events = (name: string) => lines(name).flatMap(l => parseStreamLine(l))

describe('parseStreamLine', () => {
  it('turns a text turn into init, deltas, and done', () => {
    const ev = events('text.jsonl')
    expect(ev[0]).toEqual({ type: 'init', init: { sessionId: 's1', model: 'm' } })
    expect(ev.filter(e => e.type === 'text').map(e => (e as any).delta).join('')).toBe('Hello')
    expect(ev.at(-1)).toEqual({ type: 'done', sessionId: 's1' })
  })
  it('emits activity for tools, closes it on the result, and skips buddy tools', () => {
    const ev = events('tool.jsonl')
    const acts = ev.filter(e => e.type === 'activity') as any[]
    expect(acts).toHaveLength(2)
    expect(acts[0]).toMatchObject({ id: 't1', label: 'reading src/a.ts', toolName: 'Read' })
    expect(acts[1]).toMatchObject({ id: 't1', done: true })
  })
  it('maps an error result to done with error', () => {
    expect(events('error.jsonl').at(-1)).toEqual({ type: 'done', sessionId: 's1', error: 'boom' })
  })
  it('flags auth errors', () => { expect(isAuthError('Not logged in. Please run /login')).toBe(true); expect(isAuthError('boom')).toBe(false) })
  it('ignores unknown and malformed lines', () => {
    expect(parseStreamLine('{"type":"weird"}')).toEqual([{ type: 'ignore' }])
    expect(parseStreamLine('not json')).toEqual([{ type: 'ignore' }])
  })
})
describe('activityLabel', () => {
  it('labels the common tools', () => {
    expect(activityLabel('Read', { file_path: 'src/a.ts' })).toBe('reading src/a.ts')
    expect(activityLabel('Grep', { pattern: 'TODO' })).toBe('searching for TODO')
    expect(activityLabel('Glob', { pattern: '**/*.ts' })).toBe('finding **/*.ts')
    expect(activityLabel('Bash', { command: 'git status' })).toBe('running: git status')
    expect(activityLabel('Edit', { file_path: 'x.ts' })).toBe('editing x.ts')
    expect(activityLabel('Write', { file_path: 'x.ts' })).toBe('writing x.ts')
    expect(activityLabel('Other', {})).toBe('Other')
    expect(activityLabel('Bash', { command: 'x'.repeat(200) }).length).toBeLessThanOrEqual(80)
  })
})
describe('toolsNote', () => {
  it('names every tool and the love rule, and no persona', () => {
    const n = toolsNote()
    for (const t of ['go_to', 'set_mood', 'emote', 'sleep', 'wake', 'get_state', 'set_expression']) expect(n).toContain(t)
    expect(n).toContain('love')
    expect(n.toLowerCase()).not.toContain('omnissiah')
  })
})
```

- [ ] **Step 2: Implement `stream.ts` and `prompt.ts`; run; typecheck; commit**

```bash
git add src/main/brain/stream.ts src/main/brain/stream.test.ts src/main/brain/prompt.ts src/main/brain/prompt.test.ts test/fixtures/stream
git commit -m "feat: stream-json parser, activity labels, and the tools note

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Local server: MCP tools and the permission endpoint

**Files:**
- Create: `src/main/server.ts`, `src/main/server.test.ts`, `src/hook/permission-hook.cjs`, `src/hook/permission-hook.test.ts`
- Modify: `package.json` (add `@modelcontextprotocol/sdk`, pinned)

**Interfaces:**
- Produces:

```ts
// src/main/server.ts
export interface ServerDeps {
  actions: BuddyActions
  setExpression(name: Expression): void
  onPermission(req: PermissionRequest): Promise<{ allow: boolean; reason: string }>   // main shows the card; resolves on answer or timeout
  permissionTimeoutMs: number
}
export interface PermissionRequest { id: string; toolName: string; input: unknown; summary: string }
export interface LocalServer { port: number; token: string; mcpConfig(): string; hookSettings(hookPath: string): string; close(): Promise<void> }
export async function startLocalServer(deps: ServerDeps): Promise<LocalServer>
export function summarizeToolInput(toolName: string, input: unknown): string   // same rules as activityLabel but untruncated command or path
```

`mcpConfig()` returns the JSON string `{"mcpServers":{"buddy":{"type":"http","url":"http://127.0.0.1:PORT/mcp","headers":{"Authorization":"Bearer TOKEN"}}}}`. `hookSettings(hookPath)` returns `{"hooks":{"PermissionRequest":[{"hooks":[{"type":"command","command":"node \"HOOKPATH\" --port PORT --token TOKEN","timeout":SEC}]}]}}` with `SEC = permissionTimeoutMs / 1000 + 10`. Every request must carry `Authorization: Bearer TOKEN` or receive 401. Tools per spec 6.3 with zod input schemas; `go_to` awaits `actions.goTo(x / 100, { run })`; `emote` awaits `actions.emote(kind)`; `sleep` calls `actions.closePanel()` then `actions.sleep()`; `get_state` returns `JSON.stringify(actions.getState())`; `set_expression` validates against `EXPRESSIONS`. `POST /permission` with the hook's JSON body (`tool_name`, `tool_input`, `tool_use_id`) resolves via `deps.onPermission` and answers `{ decision: 'allow' | 'deny', reason }`; the server itself enforces the timeout with a deny.

The hook (`src/hook/permission-hook.cjs`, plain Node, no dependencies): parse `--port` and `--token` from argv, read all of stdin, POST it to `http://127.0.0.1:PORT/permission` with the bearer header and a request timeout of the settings timeout minus 5 s, print `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":"allow"|"deny","decisionReason":"..."}}`; on any error print the deny form with the error message as the reason and exit 0.

- [ ] **Step 1: Install and failing tests**

`npm install @modelcontextprotocol/sdk` (pin the resolved version). Tests in `server.test.ts` start the server with a fake `actions` (spies returning resolved promises) and use `fetch`:
- a request without the token gets 401;
- `POST /mcp` JSON-RPC `initialize` then `tools/list` (with the proper `Accept: application/json, text/event-stream` and `MCP-Protocol-Version` headers the SDK's Streamable HTTP transport expects; read the SDK README for the exact client handshake or use the SDK's own `Client` with `StreamableHTTPClientTransport` pointed at the server, which is simpler) lists the seven tools;
- `tools/call go_to {x: 20}` calls `actions.goTo(0.2, { run: false })`;
- `tools/call set_expression {expression: 'love'}` calls `setExpression('love')`; `{expression: 'nope'}` returns an error result;
- `POST /permission` resolves allow when `onPermission` resolves allow, and deny after the timeout when it never resolves (fake timers or a 200 ms timeout in the test).
Tests in `permission-hook.test.ts` spawn the hook with `node` against a tiny in-test HTTP server: prints allow JSON when the server answers allow; prints deny JSON when the server is unreachable.

- [ ] **Step 2: Implement; run; typecheck; build (make sure `src/hook/permission-hook.cjs` is copied to `out/hook/` by the build: add a `copy` step in `electron.vite.config.ts` via a small plugin or use `publicDir`; the brain references `join(app.getAppPath(), 'out', 'hook', 'permission-hook.cjs')` in builds and the `src` path in dev, exposed by a helper `hookScriptPath()` in `server.ts`); commit**

```bash
git add package.json package-lock.json src/main/server.ts src/main/server.test.ts src/hook electron.vite.config.ts
git commit -m "feat: local MCP tool server and permission endpoint with a per-launch bearer token; permission hook script

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: ClaudeCliBrain and wiring

**Files:**
- Create: `src/main/brain/claude-cli.ts`, `src/main/brain/claude-cli.test.ts`, `test/fake-claude.cjs`
- Modify: `src/main/index.ts`, `src/main/chat.ts` (permission answer routing, expression from the server), `src/main/config.ts` (type validation with logged fallback), `src/main/config.test.ts`

**Interfaces:**
- Consumes: `parseStreamLine`, `activityLabel`, `isAuthError`, `toolsNote`, `LocalServer`, `Brain`.
- Produces:

```ts
export interface ClaudeCliDeps {
  cliPath: string; workspace: string; extraDirs: string[]; model: string | null; allowedTools: string[]
  server: LocalServer; hookPath: string
  lines: { authError?: string[]; cliMissing?: string[]; error?: string[] }
  onMood(mood: Mood | 'restore'): void
  spawn?: typeof import('node:child_process').spawn      // injectable for tests
  env?: NodeJS.ProcessEnv
}
export function buildArgs(d: ClaudeCliDeps, sessionId: string | null, newSessionId: string): string[]
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv    // drops CLAUDECODE and ANTHROPIC_API_KEY
export class ClaudeCliBrain implements Brain { constructor(deps: ClaudeCliDeps); respond(prompt, ctx): AsyncIterable<BrainEvent>; stop(): void }
```

`respond`: pick `sessionId = ctx.sessionId` (resume) or a fresh uuid (`--session-id`); spawn with `buildArgs`, `cwd = workspace`, `env = childEnv(deps.env ?? process.env)`; write the prompt to stdin and end it; read stdout line by line (split on `\n`, keep a remainder); for each `parseStreamLine` output: `init` records the session id; `text` yields; `activity` yields and on the first one calls `onMood('thinking')`; `done` yields with the session id and ends; ignore otherwise. On `exit` without a `done`: yield `done` with error `exit code N: <last 5 stderr lines>`. On spawn error `ENOENT`: yield `status` with the `cliMissing` line and `done` with the error. When a `done` carries an error and `isAuthError`, prefix the status with the `authError` line. After `done`, call `onMood('restore')`. `stop()` kills the child (`taskkill /PID /T /F` on win32 via `spawn`, else `kill`).

`test/fake-claude.cjs`: parses the same flags, reads stdin, and picks a scenario from the env `FAKE_CLAUDE_SCENARIO` (`text`, `tool`, `mcp`, `permission`, `auth`, `crash`), printing the corresponding fixture lines with 20 ms gaps; `mcp` also performs a JSON-RPC `tools/call` of `set_mood {mood: 'happy'}` and `set_expression {expression: 'happy'}` against the URL and token parsed from `--mcp-config`; `permission` spawns the real hook script (path taken from `--settings` JSON) with a fake `Bash` request on stdin and prints an `assistant` `tool_use` for `Bash` followed by a result whose text includes the hook's decision; `crash` prints init and exits 2 with "fake crash" on stderr.

- [ ] **Step 1: Failing tests** (`claude-cli.test.ts`): `buildArgs` produces the exact flag list from spec 6.1 for a first turn and a resumed turn; `childEnv` drops the two variables; `ClaudeCliBrain` with `spawn` pointed at `node test/fake-claude.cjs` yields the expected event sequences for each scenario (`text`: init handled, deltas, done with session id; `tool`: activity then done; `auth`: status with the authError line and done with error; `crash`: done with error containing "exit code 2"); `stop()` mid-`text` ends the iteration with a done carrying an error mentioning stopped.

- [ ] **Step 2: Implement `claude-cli.ts` and `fake-claude.cjs`; run; typecheck**

- [ ] **Step 3: Wire main** (`src/main/index.ts`): start the local server before the first turn with `onPermission` bound to the hologram card (send `chat:permission`, resolve on `chat:permissionAnswer` or the server's timeout), `setExpression` bound to the chat controller's current turn; choose the brain: `BUDDY_BRAIN=echo` env or a missing `cliPath` file selects `EchoBrain` and posts a system line "echo brain (cli not found at PATH)"; otherwise `ClaudeCliBrain`. Run `claude auth status` once at startup (spawn, 5 s timeout, parse `loggedIn` if JSON) and put "cli: logged in" or "cli: not logged in" into the status row text; never block startup on it. `ChatController.permissionAnswer(id, allow)` now resolves the server's pending request. `config.ts`: validate field types at load (string, string[], number, null-or-string) with a logged fallback per field. `config.test.ts`: a wrong-typed `scale` falls back with a log line.

- [ ] **Step 4: Run `npx vitest run`, `npm run typecheck`, `npm run build`, `npm run test:e2e` (echo brain); commit**

```bash
git add src test/fake-claude.cjs
git commit -m "feat: Claude Code CLI brain with sessions, tools, permissions, and mood coupling; config validation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: End to end with the fake CLI, and the smoke script

**Files:**
- Create: `e2e/brain.spec.ts`, `scripts/smoke-claude.mjs`
- Modify: `package.json` scripts (`test:e2e` runs both specs; `smoke:claude`), `playwright.config.ts` if needed

**Interfaces:**
- Consumes: `BUDDY_TEST=1` hook, `BUDDY_BRAIN`, a new env `BUDDY_CLI_PATH` honored by main (overrides `config.cliPath`) so the e2e can point at `node test/fake-claude.cjs` through a small `.cmd` shim `test/fake-claude.cmd` (Windows needs an executable; the shim runs `node "%~dp0fake-claude.cjs" %*`).

- [ ] **Step 1: `e2e/brain.spec.ts`**

Launch with `BUDDY_TEST=1`, `BUDDY_CLI_PATH=<abs path to test/fake-claude.cmd>`, `FAKE_CLAUDE_SCENARIO=text`; click the character; type "hello" and Enter; `expect.poll` that the last `.msg.buddy` contains "Hello" and has a `.face` canvas. Relaunch with `FAKE_CLAUDE_SCENARIO=tool`: an `.activity` row appears with "reading src/a.ts" and later carries the done class. Relaunch with `FAKE_CLAUDE_SCENARIO=permission`: the `#permission` card becomes visible with tool name "Bash"; click Deny; the buddy message then contains "deny". Relaunch with `FAKE_CLAUDE_SCENARIO=mcp`: after the turn, `globalThis.__buddy.getState().mood` is `happy` (read through `app.evaluate`). Each test closes the app in `afterEach` as `body.spec.ts` does.

- [ ] **Step 2: `scripts/smoke-claude.mjs`**

Spawns the real `claude.exe` from config with `-p --output-format stream-json --max-turns 1` and the prompt "Reply with exactly: OK" and prints whether a `result` arrived and its text; exits non-zero on failure. `npm run smoke:claude` runs it. Not part of any automated suite.

- [ ] **Step 3: Run everything, commit**

```bash
git add e2e scripts package.json playwright.config.ts test/fake-claude.cmd src/main/index.ts
git commit -m "test: fake-CLI end to end for the brain; on-demand real-CLI smoke

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- Spec coverage: section 3 (Task 1), 4 (Task 2), 5 (Task 3), 6.1 and 6.2 (Tasks 4 and 6), 6.3 and 6.4 (Task 5, wired in 6), 6.5 (Task 6), 7 (Tasks 5 and 6), 8 (Tasks 4 to 7), 9 (no new config).
- Placeholders: the windows test in Task 3 describes its body in prose because the file's fake is project-specific; the implementer has the existing `windows.test.ts` to copy from. All other steps carry code or exact strings.
- Types: `Expression` and `EXPRESSIONS` (Task 2) are used by Tasks 4 to 7 under the same names; `LocalServer.mcpConfig()`/`hookSettings()` (Task 5) are consumed by `buildArgs` (Task 6); `BrainEvent.expression` (Task 2) is produced by the server path in Task 6 through `setExpression` and by the echo brain.
