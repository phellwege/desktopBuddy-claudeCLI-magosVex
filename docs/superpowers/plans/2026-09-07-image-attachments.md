# Image Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste a clipboard image, a copied file, or an image path into the panel (or drop a file on it), see it staged as a chip, and have the CLI brain receive it inline as an image content block, as the prompt or as a mid-rite steer.

**Architecture:** The brain's user line gains an array form (image blocks, each followed by a `[Image #N: name]` caption, then the text). Main normalizes every image through one module (`images.ts`) behind an injectable codec that wraps Electron's `nativeImage` in production, and holds staged attachments by id in an `AttachmentStore`. The panel stages chips and sends ids with the prompt; the chat controller builds the content and hands it to `respond` or `steer`.

**Tech Stack:** Electron 44 (`nativeImage`, `webUtils`, `ipcMain.handle`), TypeScript strict with `noUncheckedIndexedAccess`, Vitest (node environment), Playwright `_electron`, the fake CLI at `test/fake-claude.cjs`.

Spec: `docs/superpowers/specs/2026-09-07-image-attachments-design.md`. Section numbers below refer to it.

## Global Constraints

- Formats: `image/png`, `image/jpeg`, `image/gif`, `image/webp`; extensions `.png .jpg .jpeg .gif .webp`, case-insensitive (spec 5, 6).
- `MAX_EDGE = 2576`, `MAX_BYTES = 3 * 1024 * 1024` (encoded, before base64), `MAX_STAGED = 20`, thumbnail height 40 px (spec 5). No config field.
- Caption text is exactly `[Image #N: name]`, 1-based, per message; blocks are image, caption, image, caption, then the operator's text last, omitted when empty (spec 4).
- Refusal reasons are exactly: `not an image`, `not an image file`, `cannot decode`, `too large`, `no such file`, `too many images` (spec 10).
- Channels: `image:stageBytes`, `image:stagePath` (invoke), `image:discard` (send); `chat:prompt` gains `images?: string[]` (spec 7).
- Unit tests never touch Electron or spawn the real CLI: the codec, the filesystem and `spawn` are injected; the e2e suite drives `test/fake-claude.cjs` and must set `BUDDY_USER_DATA` to a temp profile (a spec without it shares the live profile with a running buddy and crashes it).
- No em dashes anywhere (code comments, docs, README, commit messages). Use commas, colons, hyphens.
- Commits use the repo's own identity (`git config user.email` must be `phellwege1@gmail.com`; never pass `-c user.email=` with a work address). End each commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work in a git worktree on branch `image-attachments`; the worktree gets a `node_modules` junction to the main tree (`cmd //c mklink /J <worktree>\node_modules C:\repo\mechanicus-buddy\node_modules`) as earlier rounds did; do not run `npm ci` in the worktree. Never run `npm run dev` from a worktree cwd. Renderer edits under a running dev server hot-reload the live panel, so the running buddy is left alone; the e2e suite builds its own copy.
- Run from the worktree root: `npm test` (Vitest), `npm run typecheck`, `npm run test:e2e` (builds first).

## File Structure

Task 0 first: it makes the e2e suite safe to run beside a running buddy (four specs launch on the live profile today), which every later task relies on.

Create:
- `src/shared/images.ts`: `ImageMediaType`, `ImageAttachment`, `StagedImage` types shared by main and the renderer.
- `src/main/brain/content.ts`: `UserContent`, `UserBlock`, `buildUserContent`, `describeContent`, `caption`.
- `src/main/brain/content.test.ts`.
- `src/main/images.ts`: codec interface, `sniffMediaType`, `normalizeImage`, `loadImagePath`, `AttachmentStore`, the caps.
- `src/main/images.test.ts`.
- `src/main/images-electron.ts`: `electronCodec` over `nativeImage` (the only file here that imports Electron for images).
- `src/shared/imagePaths.ts`: `findImagePaths`, `fromFileUrl`.
- `src/shared/imagePaths.test.ts`.
- `test/fixtures/images/probe.png`: a 300 by 120 PNG, three coloured squares over the text MAGOS 42.
- `e2e/images.spec.ts`.
- `scripts/smoke-image.mjs`: the by-hand probe against the real CLI.

Modify:
- `src/main/brain/types.ts`: `Brain.respond` and `steer` take `UserContent`.
- `src/main/brain/claude-cli.ts`: `userLine(content)`, signatures.
- `src/main/brain/claude-cli.test.ts`: `userLine` array case, the `images` scenario test.
- `src/main/brain/stream.test.ts`: non-init `system` lines parse to `ignore`.
- `test/fake-claude.cjs`: content arrays on stdin, scenario `images`.
- `src/main/brain/echo.ts`, `echo.test.ts`: the images sentence.
- `src/main/brain/prompt.ts`, `prompt.test.ts`: the attachments sentence in the tools note.
- `src/main/chat.ts`, `chat.test.ts`: `prompt(text, images)`.
- `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/index.ts`: channels, bridge, handlers, store wiring.
- `src/renderer/hologram/index.html`, `styles.css`, `main.ts`: the chip strip, paste, drop, send.
- `README.md`, `package.json` (the `smoke:image` script).

---

### Task 0: Every e2e spec runs on its own profile

**Files:**
- Modify: `e2e/body.spec.ts`, `e2e/brain.spec.ts`, `e2e/mutter.spec.ts`, `e2e/travel.spec.ts`

**Interfaces:**
- Consumes: the `BUDDY_USER_DATA` hook in `src/main/index.ts` (an isolated profile directory). `e2e/dictation.spec.ts` already uses it and is the pattern to copy.

Why first: an app launched without `BUDDY_USER_DATA` shares the live profile (config, state, logs, renderer storage, GPU cache) with a buddy already running from `npm run dev`; two instances on one profile fail the GPU cache and the live instance's hologram crashes. Every later task runs the e2e suite beside a running buddy, so the suite must be safe first.

- [ ] **Step 1: Give each launch a temp profile**

In each of the four specs, find the `electron.launch({ args: ['.'], env: cleanEnv({ ... }) })` call (in `brain.spec.ts` it is inside `launch(scenario, extraEnv)`; the other three have their own launch helper or a `beforeEach`). Add, keeping every existing env entry as it is:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

let userDataDir: string | undefined

// Inside the launch helper, before electron.launch:
userDataDir = mkdtempSync(join(tmpdir(), 'buddy-e2e-'))
// In the env object passed to cleanEnv:
      BUDDY_USER_DATA: userDataDir,
// In the existing afterEach (or afterAll where one app is shared across tests), after the app is closed:
  if (userDataDir) { rmSync(userDataDir, { recursive: true, force: true }); userDataDir = undefined }
```

Where a spec launches more than once inside one test, mint a fresh directory per launch and remove the previous one at the same point the previous app is closed. `join` is already imported from `node:path` in every spec; add it if not.

- [ ] **Step 2: Verify no spec is left out**

Run: `grep -L BUDDY_USER_DATA e2e/*.spec.ts`
Expected: no output.

- [ ] **Step 3: Run the suite beside a running buddy**

Run: `npm run test:e2e`
Expected: every spec passes as before. A buddy running from the main tree's dev server must still be alive afterwards: `Get-Process electron` in PowerShell shows the same process count as before the run, and its panel still opens on a click.

- [ ] **Step 4: Commit**

```bash
git add e2e/body.spec.ts e2e/brain.spec.ts e2e/mutter.spec.ts e2e/travel.spec.ts
git commit -m "e2e: every spec launches on its own temp profile, never the live one" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Wire shape: content blocks on the user line

**Files:**
- Create: `src/shared/images.ts`, `src/main/brain/content.ts`, `src/main/brain/content.test.ts`
- Modify: `src/main/brain/types.ts:10-17`, `src/main/brain/claude-cli.ts:69-73,124,278-283`, `src/main/brain/claude-cli.test.ts:79-83`, `src/main/brain/stream.test.ts`

**Interfaces:**
- Produces: `ImageMediaType`, `ImageAttachment { id, name, mediaType, data, width, height, bytes }`, `StagedImage { id, name, width, height, thumb }` in `src/shared/images.ts`; `UserBlock`, `UserContent = string | UserBlock[]`, `buildUserContent(text: string, images: readonly ImageAttachment[]): UserContent`, `describeContent(content: UserContent): { text: string; imageNames: string[] }`, `caption(index: number, name: string): string` in `src/main/brain/content.ts`; `userLine(content: UserContent): string`; `Brain.respond(prompt: UserContent, ctx)`, `Brain.steer?(content: UserContent): boolean`.

- [ ] **Step 1: Write the shared types**

Create `src/shared/images.ts`:

```ts
// Image attachment types shared by main and the renderer. No runtime dependencies.
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export function isImageMediaType(v: unknown): v is ImageMediaType {
  return typeof v === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(v)
}
// One image ready for the wire. data is base64; bytes is the encoded size before base64.
export interface ImageAttachment { id: string; name: string; mediaType: ImageMediaType; data: string; width: number; height: number; bytes: number }
// What the panel holds per chip. thumb is a data URL. width and height are 0 for an
// image the codec could not decode (gif, webp), which is passed through as it came.
export interface StagedImage { id: string; name: string; width: number; height: number; thumb: string }
```

- [ ] **Step 2: Write the failing content tests**

Create `src/main/brain/content.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildUserContent, caption, describeContent } from './content'
import type { ImageAttachment } from '../../shared/images'

const img = (id: string, name: string): ImageAttachment => ({ id, name, mediaType: 'image/png', data: 'QUJD', width: 2, height: 1, bytes: 3 })

describe('buildUserContent', () => {
  it('is the plain string when there are no images', () => {
    expect(buildUserContent('hello', [])).toBe('hello')
  })
  it('puts each image block before its caption, and the text last', () => {
    expect(buildUserContent('what are these?', [img('a', 'shot.png'), img('b', 'two.png')])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'text', text: '[Image #1: shot.png]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'text', text: '[Image #2: two.png]' },
      { type: 'text', text: 'what are these?' },
    ])
  })
  it('omits the trailing text block when the text is empty', () => {
    const blocks = buildUserContent('', [img('a', 'shot.png')])
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toEqual({ type: 'text', text: caption(1, 'shot.png') })
  })
})

describe('describeContent', () => {
  it('passes a string through with no images', () => {
    expect(describeContent('hi')).toEqual({ text: 'hi', imageNames: [] })
  })
  it('separates the operator text from the captions', () => {
    const content = buildUserContent('look', [img('a', 'shot.png'), img('b', 'two.png')])
    expect(describeContent(content)).toEqual({ text: 'look', imageNames: ['shot.png', 'two.png'] })
  })
  it('reads empty text from an images-only message', () => {
    expect(describeContent(buildUserContent('', [img('a', 'x.png')]))).toEqual({ text: '', imageNames: ['x.png'] })
  })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run src/main/brain/content.test.ts`
Expected: FAIL, cannot find module `./content`.

- [ ] **Step 4: Write content.ts**

Create `src/main/brain/content.ts`:

```ts
// The user message the brain writes to the CLI: plain text, or, when images ride along,
// an array of Messages API content blocks (spec 2026-09-07-image-attachments-design, 4).
import type { ImageAttachment, ImageMediaType } from '../../shared/images'

export type UserBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
export type UserContent = string | UserBlock[]

export function caption(index: number, name: string): string { return `[Image #${index}: ${name}]` }

// Images first, each followed by its caption, then the operator's text. With no images the
// content is the plain string, so nothing already on the wire changes shape.
export function buildUserContent(text: string, images: readonly ImageAttachment[]): UserContent {
  if (images.length === 0) return text
  const blocks: UserBlock[] = []
  images.forEach((img, i) => {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
    blocks.push({ type: 'text', text: caption(i + 1, img.name) })
  })
  if (text.length > 0) blocks.push({ type: 'text', text })
  return blocks
}

const CAPTION = /^\[Image #\d+: (.*)\]$/
// The operator's own words and the attached image names, read back out of content built
// above. The echo brain uses it; the real CLI gets the blocks as they are.
export function describeContent(content: UserContent): { text: string; imageNames: string[] } {
  if (typeof content === 'string') return { text: content, imageNames: [] }
  const texts: string[] = []
  const imageNames: string[] = []
  for (const block of content) {
    if (block.type !== 'text') continue
    const m = CAPTION.exec(block.text)
    if (m) imageNames.push(m[1] ?? '')
    else texts.push(block.text)
  }
  return { text: texts.join(' '), imageNames }
}
```

- [ ] **Step 5: Run the content tests**

Run: `npx vitest run src/main/brain/content.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Add the failing userLine and stream tests**

In `src/main/brain/claude-cli.test.ts`, replace the `describe('userLine', ...)` block (lines 79-83) with:

```ts
describe('userLine', () => {
  it('is one stream-json user message per line, newline terminated', () => {
    expect(userLine('hi there')).toBe('{"type":"user","message":{"role":"user","content":"hi there"}}\n')
  })
  it('serializes content blocks as the message content, unchanged', () => {
    const blocks = [
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'QUJD' } },
      { type: 'text' as const, text: '[Image #1: a.png]' },
    ]
    expect(userLine(blocks)).toBe('{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"QUJD"}},{"type":"text","text":"[Image #1: a.png]"}]}}\n')
  })
})
```

In `src/main/brain/stream.test.ts`, inside `describe('parseStreamLine', ...)`, after the `'ignores unknown and malformed lines'` test, add:

```ts
  it('ignores the system lines that are not init, and the top-level rate limit line', () => {
    for (const subtype of ['thinking_tokens', 'post_turn_summary']) {
      expect(parseStreamLine(JSON.stringify({ type: 'system', subtype, session_id: 's1' }))).toEqual([{ type: 'ignore' }])
    }
    expect(parseStreamLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }))).toEqual([{ type: 'ignore' }])
  })
```

- [ ] **Step 7: Run them to see the userLine case fail**

Run: `npx vitest run src/main/brain/claude-cli.test.ts src/main/brain/stream.test.ts`
Expected: the stream test passes already (the parser ignores unknown subtypes); the new `userLine` test fails on the type of the argument at typecheck time and on the output at runtime, since `userLine` stringifies whatever it gets; if it happens to pass at runtime, that is fine, the signature change in the next step is what the test pins.

- [ ] **Step 8: Change the signatures**

In `src/main/brain/types.ts`, replace the `Brain` interface:

```ts
import type { BuddyState, Expression } from '../../shared/types'
import type { UserContent } from './content'

export interface BrainContext { state: BuddyState; workspace: string; model: string | null; sessionId: string | null }
export type BrainEvent =
  | { type: 'text'; delta: string }
  | { type: 'activity'; id: string; label: string; toolName: string; done?: boolean }
  | { type: 'status'; text: string; expression?: Expression }
  | { type: 'expression'; name: Expression }
  | { type: 'done'; sessionId?: string; error?: string; stopped?: boolean }
export interface Brain {
  // prompt is the operator's text, or content blocks when images ride along (content.ts).
  respond(prompt: UserContent, ctx: BrainContext): AsyncIterable<BrainEvent>
  stop(): void
  // Hands a further user message to the turn that is running right now (the CLI gives it
  // to the model at its next tool boundary, or runs it as the next turn). Returns false
  // when there is nothing running that can take it; the caller then refuses the prompt.
  steer?(content: UserContent): boolean
}
```

In `src/main/brain/claude-cli.ts`:

Add the import after line 13:

```ts
import type { UserContent } from './content'
```

Replace `userLine` (lines 69-73):

```ts
// One stream-json user message, newline terminated: the shape the CLI reads from stdin
// under --input-format stream-json, both for the prompt and for a steer. content is the
// operator's text, or content blocks when images ride along (measured against 2.1.261:
// the CLI accepts the array form on stdin as the prompt and as a later line).
export function userLine(content: UserContent): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}
```

Change the `respond` signature (line 124) to `async *respond(prompt: UserContent, ctx: BrainContext): AsyncIterable<BrainEvent> {` and the `steer` signature (line 278) to `steer(content: UserContent): boolean {`, with its write becoming `child.stdin.write(userLine(content))`.

- [ ] **Step 9: Typecheck and run the brain tests**

Run: `npm run typecheck && npx vitest run src/main/brain`
Expected: typecheck clean (the echo brain still compiles: a `string` parameter accepts... no, `EchoBrain.respond(prompt: string)` no longer satisfies `Brain`; if typecheck reports `echo.ts`, change its parameter type to `UserContent` now and leave the body for Task 3, since `describeContent` is not used yet: replace `${prompt}` in the template with `${typeof prompt === 'string' ? prompt : ''}`). All brain tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/shared/images.ts src/main/brain/content.ts src/main/brain/content.test.ts src/main/brain/types.ts src/main/brain/claude-cli.ts src/main/brain/claude-cli.test.ts src/main/brain/stream.test.ts src/main/brain/echo.ts
git commit -m "brain: user lines carry content blocks, images captioned [Image #N: name] before the text" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The fake CLI reads content arrays and reports them

**Files:**
- Modify: `test/fake-claude.cjs:17-65` (stdin reader), the scenario switch in `main()`
- Modify: `src/main/brain/claude-cli.test.ts` (add a test)

**Interfaces:**
- Consumes: `userLine` array form from Task 1.
- Produces: scenario `images` whose first turn's text is `images=<n> media=<types> text=<joined text blocks>` and, only when steers arrived, a second turn `steerImages=<n> steerText=<texts joined by |>` with session id `s2`.

- [ ] **Step 1: Write the failing brain test**

Append to `src/main/brain/claude-cli.test.ts`, inside `describe('ClaudeCliBrain', ...)`:

```ts
  it('writes content blocks to the fake as the prompt, and steers blocks into the running turn', async () => {
    const brain = new ClaudeCliBrain(baseDeps({ spawn: fakeSpawn('images') }))
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'QUJD' } }
    const prompt = [image, { type: 'text' as const, text: '[Image #1: a.png]' }, { type: 'text' as const, text: 'what is it' }]
    const iterator = brain.respond(prompt, { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null })[Symbol.asyncIterator]()
    const events: BrainEvent[] = []
    // The first yielded event is the fake's first text delta; its result line is still
    // 20 ms away, so stdin is open and the steer goes down before it.
    const first = await iterator.next()
    if (!first.done) events.push(first.value)
    expect(brain.steer([image, { type: 'text', text: '[Image #1: b.png]' }])).toBe(true)
    for (let r = await iterator.next(); !r.done; r = await iterator.next()) events.push(r.value)
    const text = events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')
    expect(text).toContain('images=1 media=image/png text=[Image #1: a.png] what is it')
    expect(text).toContain('steerImages=1 steerText=[Image #1: b.png]')
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 's2', error: undefined })
  }, 10000)
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/main/brain/claude-cli.test.ts -t "content blocks"`
Expected: FAIL, the fake runs the default `text` scenario and the reply is `Hello`.

- [ ] **Step 3: Teach the fake to read arrays**

In `test/fake-claude.cjs`, replace the block from the comment `// stdin is line-delimited.` through the end of `readPrompt()` (lines 17-65) with:

```js
// stdin is line-delimited. The brain writes stream-json user lines, {"type":"user",
// "message":{"role":"user","content":...}}, and keeps the pipe open so it can steer a
// running turn with further lines (docs/superpowers/specs/2026-09-07-mid-turn-steering-design.md).
// content is a string, or an array of Messages API blocks when images ride along
// (docs/superpowers/specs/2026-09-07-image-attachments-design.md): text blocks are joined
// with a space, captions included; image blocks are counted and their media types kept.
// The first line is the prompt and starts the scenario; later lines land in `steers`
// (their text) and `steerMessages` (the whole reading); EOF flips `stdinEnded`. A first
// line that is not JSON is taken as a plain-text prompt, which is what an older caller (or
// a test fake) writes.
const steers = []
const steerMessages = []
let promptMessage = null
let stdinEnded = false
let onStdinEnd = () => {}

function userMessage(line) {
  try {
    const msg = JSON.parse(line)
    const content = msg && msg.message && msg.message.content
    if (typeof content === 'string') return { text: content, images: 0, media: [] }
    if (Array.isArray(content)) {
      const texts = []
      const media = []
      for (const block of content) {
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        if (block.type === 'image' && block.source && typeof block.source.media_type === 'string') media.push(block.source.media_type)
      }
      return { text: texts.join(' '), images: media.length, media }
    }
    return { text: line, images: 0, media: [] }
  } catch {
    return { text: line, images: 0, media: [] }
  }
}

function readPrompt() {
  return new Promise((resolve) => {
    let buf = ''
    let first = null
    const take = (line) => {
      const m = userMessage(line)
      if (first === null) { first = m; promptMessage = m; resolve(m.text) } else { steers.push(m.text); steerMessages.push(m) }
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
      // EOF with nothing taken (empty or whitespace-only stdin): run the scenario with an
      // empty prompt, as the old EOF-only reader did, rather than leaving main() awaiting
      // a promise that never settles and the process exiting with no output.
      if (first === null) { first = { text: '', images: 0, media: [] }; promptMessage = first; resolve('') }
      stdinEnded = true
      onStdinEnd()
    })
  })
}
```

Add the scenario after `runLinger()`:

```js
// Reports what the prompt carried (image count, media types, joined text), then, once
// stdin has closed and only if steers arrived, a second turn reporting what they carried.
// Lets the brain tests pin the wire shape without reading the child's stdin directly.
async function runImages() {
  const p = promptMessage || { text: '', images: 0, media: [] }
  await emit([
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `images=${p.images} media=${p.media.join(',')} text=${p.text}` } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'ok' },
  ])
  await waitStdinEnd()
  if (steerMessages.length === 0) return
  const steerImages = steerMessages.reduce((n, m) => n + m.images, 0)
  await emit([
    { type: 'system', subtype: 'init', session_id: 's2', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ` steerImages=${steerImages} steerText=${steerMessages.map((m) => m.text).join('|')}` } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's2', result: 'ok' },
  ])
}
```

In `main()`'s switch, add `case 'images': await runImages(); break` before `case 'text':`.

- [ ] **Step 4: Run the brain tests**

Run: `npx vitest run src/main/brain/claude-cli.test.ts`
Expected: PASS, including every earlier scenario (they read `prompt` as text and `steers` as texts, unchanged).

- [ ] **Step 5: Commit**

```bash
git add test/fake-claude.cjs src/main/brain/claude-cli.test.ts
git commit -m "test: fake CLI reads content arrays and the images scenario reports what came down stdin" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The echo brain names the images, the tools note mentions them

**Files:**
- Modify: `src/main/brain/echo.ts:13-22`, `src/main/brain/echo.test.ts`, `src/main/brain/prompt.ts:8-15`, `src/main/brain/prompt.test.ts`

**Interfaces:**
- Consumes: `describeContent`, `buildUserContent` from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/brain/echo.test.ts` inside `describe('EchoBrain', ...)`, and add `import { buildUserContent } from './content'` at the top:

```ts
  it('names the images it was handed', async () => {
    const b = new EchoBrain(pack, actions, { delayMs: 0, rng: () => 0 })
    const content = buildUserContent('look', [{ id: 'a', name: 'shot.png', mediaType: 'image/png', data: 'QUJD', width: 1, height: 1, bytes: 3 }])
    const events = []
    for await (const e of b.respond(content, ctx)) events.push(e)
    const text = events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')
    expect(text).toContain('You said: "look"')
    expect(text).toContain('I see 1 image(s): shot.png.')
  })
```

In `src/main/brain/prompt.test.ts`, add inside the existing test after the `love` assertion:

```ts
    expect(n).toContain('[Image #N: name]')
    expect(n).toContain('do not read them from disk')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/main/brain/echo.test.ts src/main/brain/prompt.test.ts`
Expected: FAIL on the image sentence and on the note text.

- [ ] **Step 3: Implement**

In `src/main/brain/echo.ts`, add `import { describeContent, type UserContent } from './content'` and replace `respond` up to the `text` line:

```ts
  async *respond(prompt: UserContent, _ctx: BrainContext): AsyncIterable<BrainEvent> {
    this.stopped = false
    const rng = this.opts.rng ?? Math.random
    const delay = this.opts.delayMs ?? 40
    const line = pickLine(this.pack, rng() < 0.5 ? 'greeting' : 'idleMutter', rng) ?? 'Acknowledged.'
    // The echo brain is what runs on a machine with no Claude Code installed (and in the
    // e2e suite), so the tail says how to get a real brain rather than promising one.
    // Picked with a fixed roll so the rng draws below stay where the tests expect them.
    const tail = pickLine(this.pack, 'cliMissing', () => 0) ?? 'No brain is installed here; I can only repeat you.'
    // Images cannot be seen here; naming them proves they arrived, which is what the e2e
    // suite checks.
    const { text: said, imageNames } = describeContent(prompt)
    const seen = imageNames.length ? ` I see ${imageNames.length} image(s): ${imageNames.join(', ')}.` : ''
    const text = `${line} You said: "${said}".${seen} ${tail}`
```

The rest of the method is unchanged.

In `src/main/brain/prompt.ts`, replace `toolsNote`:

```ts
export function toolsNote(): string {
  return "You are a desktop assistant with a small animated body on the user's screen. Tools: " +
    'go_to moves the body to a percentage across the current screen, or onto another monitor with ' +
    'its display argument; set_mood changes its body language ' +
    '(calm, happy, thinking, confused, alarmed); emote plays a one-off reaction; sleep and wake; ' +
    'get_state reads its state and lists the attached displays; ' +
    `${EXPRESSION_NOTE} ` +
    'Images the operator attaches arrive inline in the message, each followed by a caption ' +
    '[Image #N: name]; do not read them from disk again. ' +
    'Do not narrate tool use. Keep replies concise unless asked.'
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/brain`
Expected: PASS. The `buildArgs` exact-flag tests still pass because they call `toolsNote()` themselves.

- [ ] **Step 5: Commit**

```bash
git add src/main/brain/echo.ts src/main/brain/echo.test.ts src/main/brain/prompt.ts src/main/brain/prompt.test.ts
git commit -m "brain: echo names attached images; tools note says they arrive inline" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: normalizeImage behind an injectable codec

**Files:**
- Create: `src/main/images.ts`, `src/main/images.test.ts`

**Interfaces:**
- Produces: `MAX_EDGE`, `MAX_BYTES`, `MAX_STAGED`, `THUMB_HEIGHT`, `IMAGE_EXTENSIONS`, `DecodedImage`, `ImageCodec { decode(bytes: Buffer): DecodedImage | null }`, `ImageSource { bytes: Buffer; mediaType?: string; name: string }`, `NormalizeResult`, `sniffMediaType(bytes: Buffer): ImageMediaType | null`, `normalizeImage(src: ImageSource, codec: ImageCodec): NormalizeResult`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/images.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MAX_BYTES, normalizeImage, sniffMediaType, type DecodedImage, type ImageCodec } from './images'

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const GIF_HEAD = Buffer.from('GIF89a', 'latin1')
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')])
const png = (extra = 0) => Buffer.concat([PNG_HEAD, Buffer.alloc(extra)])

// A codec whose decoded image has the size the test asks for and encodes to buffers of
// chosen lengths; every call is recorded so a test can assert which path ran.
export function fakeCodec(opts: { width: number; height: number; pngBytes?: number; jpegBytes?: number; decodes?: boolean }): ImageCodec & { calls: string[] } {
  const calls: string[] = []
  const make = (width: number, height: number): DecodedImage => ({
    width, height,
    resize(maxEdge) { calls.push(`resize ${maxEdge}`); const s = maxEdge / Math.max(width, height); return make(Math.round(width * s), Math.round(height * s)) },
    png() { calls.push('png'); return Buffer.alloc(opts.pngBytes ?? 100) },
    jpeg(quality) { calls.push(`jpeg ${quality}`); return Buffer.alloc(opts.jpegBytes ?? 50) },
    thumbnail(height) { calls.push(`thumb ${height}`); return `data:image/png;base64,thumb${height}` },
  })
  return { calls, decode(bytes) { calls.push(`decode ${bytes.length}`); return opts.decodes === false ? null : make(opts.width, opts.height) } }
}

describe('sniffMediaType', () => {
  it('recognises the four formats by their magic bytes', () => {
    expect(sniffMediaType(png())).toBe('image/png')
    expect(sniffMediaType(JPEG_HEAD)).toBe('image/jpeg')
    expect(sniffMediaType(GIF_HEAD)).toBe('image/gif')
    expect(sniffMediaType(WEBP_HEAD)).toBe('image/webp')
  })
  it('returns null for anything else', () => {
    expect(sniffMediaType(Buffer.from('hello world'))).toBeNull()
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull()
  })
})

describe('normalizeImage', () => {
  it('passes a small png through unchanged, with a thumbnail and the decoded size', () => {
    const codec = fakeCodec({ width: 800, height: 600 })
    const bytes = png(10)
    const r = normalizeImage({ bytes, name: 'a.png' }, codec)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.attachment).toMatchObject({ name: 'a.png', mediaType: 'image/png', data: bytes.toString('base64'), width: 800, height: 600, bytes: 18 })
    expect(r.staged).toEqual({ id: r.attachment.id, name: 'a.png', width: 800, height: 600, thumb: 'data:image/png;base64,thumb40' })
    expect(codec.calls).toEqual(['decode 18', 'thumb 40'])
  })
  it('gives every call a fresh id', () => {
    const codec = fakeCodec({ width: 1, height: 1 })
    const a = normalizeImage({ bytes: png(), name: 'a.png' }, codec)
    const b = normalizeImage({ bytes: png(), name: 'a.png' }, codec)
    expect(a.ok && b.ok && a.attachment.id !== b.attachment.id).toBe(true)
  })
  it('takes the caller media type over the sniff', () => {
    const r = normalizeImage({ bytes: png(), mediaType: 'image/jpeg', name: 'a.jpg' }, fakeCodec({ width: 1, height: 1 }))
    expect(r.ok && r.attachment.mediaType).toBe('image/jpeg')
  })
  it('resizes over MAX_EDGE and re-encodes as png', () => {
    const codec = fakeCodec({ width: 5000, height: 2000, pngBytes: 1000 })
    const r = normalizeImage({ bytes: png(), name: 'wide.png' }, codec)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.attachment).toMatchObject({ mediaType: 'image/png', width: 2576, height: 1030, bytes: 1000 })
    expect(codec.calls).toContain('resize 2576')
    expect(codec.calls).toContain('png')
    expect(codec.calls).not.toContain('jpeg 85')
  })
  it('falls back to jpeg 85 when the png is over the cap', () => {
    const codec = fakeCodec({ width: 5000, height: 2000, pngBytes: MAX_BYTES + 1, jpegBytes: 1000 })
    const r = normalizeImage({ bytes: png(), name: 'wide.png' }, codec)
    expect(r.ok && r.attachment.mediaType).toBe('image/jpeg')
    expect(r.ok && r.attachment.bytes).toBe(1000)
    expect(codec.calls).toContain('jpeg 85')
  })
  it('refuses when even the jpeg is over the cap', () => {
    const codec = fakeCodec({ width: 5000, height: 2000, pngBytes: MAX_BYTES + 1, jpegBytes: MAX_BYTES + 1 })
    expect(normalizeImage({ bytes: png(), name: 'huge.png' }, codec)).toEqual({ ok: false, reason: 'too large' })
  })
  it('re-encodes without resizing when only the byte cap is exceeded', () => {
    const codec = fakeCodec({ width: 1000, height: 1000, pngBytes: 500 })
    const r = normalizeImage({ bytes: png(MAX_BYTES), name: 'fat.png' }, codec)
    expect(r.ok && r.attachment.bytes).toBe(500)
    expect(codec.calls.some(c => c.startsWith('resize'))).toBe(false)
    expect(codec.calls).toContain('png')
  })
  it('refuses bytes that are not an image', () => {
    expect(normalizeImage({ bytes: Buffer.from('hello'), name: 'x.bin' }, fakeCodec({ width: 1, height: 1 }))).toEqual({ ok: false, reason: 'not an image' })
  })
  it('refuses a png or jpeg the codec cannot decode', () => {
    const codec = fakeCodec({ width: 1, height: 1, decodes: false })
    expect(normalizeImage({ bytes: png(), name: 'a.png' }, codec)).toEqual({ ok: false, reason: 'cannot decode' })
    expect(normalizeImage({ bytes: JPEG_HEAD, name: 'a.jpg' }, codec)).toEqual({ ok: false, reason: 'cannot decode' })
  })
  it('passes a gif through when the codec cannot decode it, with the raw bytes as the thumb', () => {
    const codec = fakeCodec({ width: 1, height: 1, decodes: false })
    const r = normalizeImage({ bytes: GIF_HEAD, name: 'a.gif' }, codec)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.attachment).toMatchObject({ mediaType: 'image/gif', width: 0, height: 0, data: GIF_HEAD.toString('base64') })
    expect(r.staged.thumb).toBe(`data:image/gif;base64,${GIF_HEAD.toString('base64')}`)
  })
  it('refuses a gif over the cap', () => {
    const codec = fakeCodec({ width: 1, height: 1, decodes: false })
    expect(normalizeImage({ bytes: Buffer.concat([GIF_HEAD, Buffer.alloc(MAX_BYTES)]), name: 'a.gif' }, codec)).toEqual({ ok: false, reason: 'too large' })
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/main/images.test.ts`
Expected: FAIL, cannot find module `./images`.

- [ ] **Step 3: Write images.ts**

Create `src/main/images.ts`:

```ts
// Image attachments for the brain (spec 2026-09-07-image-attachments-design, 5). Pure
// apart from the codec, which wraps Electron's nativeImage in production
// (images-electron.ts) and is faked in tests, so this file runs under plain Node.
import { randomUUID } from 'node:crypto'
import { isImageMediaType, type ImageAttachment, type ImageMediaType, type StagedImage } from '../shared/images'

// The long edge above which the API downscales on the current high-resolution models;
// nothing legible the API would have kept is thrown away.
export const MAX_EDGE = 2576
// Encoded bytes before base64: 4 MB after, under every documented cap.
export const MAX_BYTES = 3 * 1024 * 1024
export const MAX_STAGED = 20
export const THUMB_HEIGHT = 40
export const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
}

export interface DecodedImage {
  width: number
  height: number
  resize(maxEdge: number): DecodedImage
  png(): Buffer
  jpeg(quality: number): Buffer
  // A data URL for the chip.
  thumbnail(height: number): string
}
export interface ImageCodec { decode(bytes: Buffer): DecodedImage | null }
export interface ImageSource { bytes: Buffer; mediaType?: string; name: string }
export type NormalizeResult =
  | { ok: true; attachment: ImageAttachment; staged: StagedImage }
  | { ok: false; reason: string }

export function sniffMediaType(bytes: Buffer): ImageMediaType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

function finish(src: ImageSource, mediaType: ImageMediaType, encoded: Buffer, width: number, height: number, thumb: string): NormalizeResult {
  const id = randomUUID()
  return {
    ok: true,
    attachment: { id, name: src.name, mediaType, data: encoded.toString('base64'), width, height, bytes: encoded.length },
    staged: { id, name: src.name, width, height, thumb },
  }
}

// Spec 5, in order: type (caller's, else sniffed); decode; a gif or webp the codec cannot
// read passes through under the cap; within both caps the bytes pass through unchanged;
// otherwise resize to MAX_EDGE when needed and encode png, jpeg 85 when the png is over
// the cap, refuse when the jpeg still is.
export function normalizeImage(src: ImageSource, codec: ImageCodec): NormalizeResult {
  const type = isImageMediaType(src.mediaType) ? src.mediaType : sniffMediaType(src.bytes)
  if (!type) return { ok: false, reason: 'not an image' }
  const decoded = codec.decode(src.bytes)
  if (!decoded) {
    if (type === 'image/png' || type === 'image/jpeg') return { ok: false, reason: 'cannot decode' }
    if (src.bytes.length > MAX_BYTES) return { ok: false, reason: 'too large' }
    return finish(src, type, src.bytes, 0, 0, `data:${type};base64,${src.bytes.toString('base64')}`)
  }
  const longEdge = Math.max(decoded.width, decoded.height)
  if (longEdge <= MAX_EDGE && src.bytes.length <= MAX_BYTES) {
    return finish(src, type, src.bytes, decoded.width, decoded.height, decoded.thumbnail(THUMB_HEIGHT))
  }
  const scaled = longEdge > MAX_EDGE ? decoded.resize(MAX_EDGE) : decoded
  let encoded = scaled.png()
  let outType: ImageMediaType = 'image/png'
  if (encoded.length > MAX_BYTES) { encoded = scaled.jpeg(85); outType = 'image/jpeg' }
  if (encoded.length > MAX_BYTES) return { ok: false, reason: 'too large' }
  return finish(src, outType, encoded, scaled.width, scaled.height, scaled.thumbnail(THUMB_HEIGHT))
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/images.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/images.ts src/main/images.test.ts
git commit -m "images: normalize a pasted image behind an injectable codec (caps, passthrough, png then jpeg)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: loadImagePath and the AttachmentStore

**Files:**
- Modify: `src/main/images.ts`, `src/main/images.test.ts`

**Interfaces:**
- Produces: `ImageFs { readFile(path: string): Buffer }`, `nodeImageFs`, `loadImagePath(path: string, workspace: string, fs: ImageFs, codec: ImageCodec): NormalizeResult`, `class AttachmentStore { size; stage(a): { ok: true } | { ok: false; reason }; take(ids): ImageAttachment[]; discard(id); clear() }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/images.test.ts` (add `import { resolve } from 'node:path'` and extend the first import with `AttachmentStore, loadImagePath, MAX_STAGED, type ImageFs` and `type ImageAttachment` from `../shared/images`):

```ts
function fakeFs(files: Record<string, Buffer>): ImageFs {
  return { readFile: (p) => { const b = files[p]; if (!b) throw new Error('ENOENT'); return b } }
}

describe('loadImagePath', () => {
  it('resolves a relative path against the workspace and names the file by its basename', () => {
    const key = resolve('C:\\repo', 'shots/a.png')
    const r = loadImagePath('shots/a.png', 'C:\\repo', fakeFs({ [key]: png(10) }), fakeCodec({ width: 10, height: 10 }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.attachment.name).toBe('a.png')
    expect(r.attachment.mediaType).toBe('image/png')
  })
  it('takes an absolute path as it is', () => {
    const key = resolve('D:\\pics\\b.JPG')
    const r = loadImagePath('D:\\pics\\b.JPG', 'C:\\repo', fakeFs({ [key]: JPEG_HEAD }), fakeCodec({ width: 10, height: 10 }))
    expect(r.ok && r.attachment.mediaType).toBe('image/jpeg')
    expect(r.ok && r.attachment.name).toBe('b.JPG')
  })
  it('gates on the extension before reading', () => {
    let reads = 0
    const fs: ImageFs = { readFile: () => { reads++; return png() } }
    expect(loadImagePath('C:\\x\\notes.txt', 'C:\\repo', fs, fakeCodec({ width: 1, height: 1 }))).toEqual({ ok: false, reason: 'not an image file' })
    expect(reads).toBe(0)
  })
  it('reports a missing file', () => {
    expect(loadImagePath('C:\\x\\gone.png', 'C:\\repo', fakeFs({}), fakeCodec({ width: 1, height: 1 }))).toEqual({ ok: false, reason: 'no such file' })
  })
})

describe('AttachmentStore', () => {
  const att = (id: string): ImageAttachment => ({ id, name: `${id}.png`, mediaType: 'image/png', data: 'QUJD', width: 1, height: 1, bytes: 3 })
  it('takes staged attachments in the order asked and removes them', () => {
    const s = new AttachmentStore()
    s.stage(att('a')); s.stage(att('b')); s.stage(att('c'))
    expect(s.take(['c', 'a']).map(x => x.id)).toEqual(['c', 'a'])
    expect(s.size).toBe(1)
    expect(s.take(['c'])).toEqual([])
  })
  it('skips unknown ids', () => {
    const s = new AttachmentStore()
    s.stage(att('a'))
    expect(s.take(['zzz', 'a']).map(x => x.id)).toEqual(['a'])
  })
  it('discards one and clears all', () => {
    const s = new AttachmentStore()
    s.stage(att('a')); s.stage(att('b'))
    s.discard('a')
    expect(s.size).toBe(1)
    s.clear()
    expect(s.size).toBe(0)
  })
  it('refuses beyond MAX_STAGED', () => {
    const s = new AttachmentStore()
    for (let i = 0; i < MAX_STAGED; i++) expect(s.stage(att(`i${i}`))).toEqual({ ok: true })
    expect(s.stage(att('one-more'))).toEqual({ ok: false, reason: 'too many images' })
    expect(s.size).toBe(MAX_STAGED)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/main/images.test.ts`
Expected: FAIL, `loadImagePath` and `AttachmentStore` are not exported.

- [ ] **Step 3: Implement**

In `src/main/images.ts`, add `import { readFileSync } from 'node:fs'` and `import { basename, extname, isAbsolute, resolve } from 'node:path'` after the `node:crypto` import, then append:

```ts
// Disk access for a pasted path, injectable so tests never touch the real disk.
export interface ImageFs { readFile(path: string): Buffer }
export const nodeImageFs: ImageFs = { readFile: (p) => readFileSync(p) }

// A relative path resolves against the workspace, as the CLI's own Read would. The
// extension gate runs before the read so a stray .txt never hits the disk (spec 5).
export function loadImagePath(path: string, workspace: string, fs: ImageFs, codec: ImageCodec): NormalizeResult {
  const target = isAbsolute(path) ? resolve(path) : resolve(workspace, path)
  const type = IMAGE_EXTENSIONS[extname(target).toLowerCase()]
  if (!type) return { ok: false, reason: 'not an image file' }
  let bytes: Buffer
  try { bytes = fs.readFile(target) } catch { return { ok: false, reason: 'no such file' } }
  return normalizeImage({ bytes, mediaType: type, name: basename(target) }, codec)
}

// Attachments staged in the panel and not yet sent, by id. Main owns it (spec 5): the
// renderer holds ids and thumbnails only, and the bytes cross IPC once.
export class AttachmentStore {
  private readonly items = new Map<string, ImageAttachment>()
  get size(): number { return this.items.size }
  stage(attachment: ImageAttachment): { ok: true } | { ok: false; reason: string } {
    if (this.items.size >= MAX_STAGED) return { ok: false, reason: 'too many images' }
    this.items.set(attachment.id, attachment)
    return { ok: true }
  }
  // In the order asked, which is the order of the chips; unknown ids are skipped.
  take(ids: readonly string[]): ImageAttachment[] {
    const out: ImageAttachment[] = []
    for (const id of ids) {
      const a = this.items.get(id)
      if (!a) continue
      out.push(a)
      this.items.delete(id)
    }
    return out
  }
  discard(id: string): void { this.items.delete(id) }
  clear(): void { this.items.clear() }
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run src/main/images.test.ts && npm run typecheck`
Expected: PASS, 21 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/images.ts src/main/images.test.ts
git commit -m "images: load a pasted path against the workspace; staged attachments live in main by id" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: findImagePaths for pasted text

**Files:**
- Create: `src/shared/imagePaths.ts`, `src/shared/imagePaths.test.ts`

**Interfaces:**
- Produces: `findImagePaths(text: string): string[]`, `fromFileUrl(url: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/imagePaths.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { findImagePaths, fromFileUrl } from './imagePaths'

describe('findImagePaths', () => {
  it('finds a quoted Windows path with spaces, as Explorer copies it', () => {
    expect(findImagePaths('see "C:\\My Shots\\err 1.png" please')).toEqual(['C:\\My Shots\\err 1.png'])
  })
  it('finds bare Windows paths with either slash, any extension case', () => {
    expect(findImagePaths('C:\\shots\\a.png and D:/x/b.JPG')).toEqual(['C:\\shots\\a.png', 'D:/x/b.JPG'])
  })
  it('finds a UNC path', () => {
    expect(findImagePaths('\\\\nas\\share\\c.webp')).toEqual(['\\\\nas\\share\\c.webp'])
  })
  it('finds a POSIX path inside a sentence', () => {
    expect(findImagePaths('look at /Users/p/d.gif now')).toEqual(['/Users/p/d.gif'])
  })
  it('decodes a file URL and restores the drive form', () => {
    expect(findImagePaths('file:///C:/dir/my%20shot.png')).toEqual(['C:/dir/my shot.png'])
    expect(findImagePaths('file:///home/u/e.jpeg')).toEqual(['/home/u/e.jpeg'])
  })
  it('ignores other extensions and web urls', () => {
    expect(findImagePaths('C:\\a\\notes.txt https://x.y/z.png')).toEqual([])
  })
  it('dedupes and keeps first-seen order', () => {
    expect(findImagePaths('C:\\a.png "C:\\b.png" C:\\a.png')).toEqual(['C:\\a.png', 'C:\\b.png'])
  })
  it('finds nothing in plain prose', () => {
    expect(findImagePaths('the png format is fine, C: drive is full')).toEqual([])
  })
})

describe('fromFileUrl', () => {
  it('handles drive and posix forms', () => {
    expect(fromFileUrl('file:///C:/a/b.png')).toBe('C:/a/b.png')
    expect(fromFileUrl('file:///a/b.png')).toBe('/a/b.png')
    expect(fromFileUrl('file://localhost/a/b.png')).toBe('/localhost/a/b.png')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/shared/imagePaths.test.ts`
Expected: FAIL, cannot find module `./imagePaths`.

- [ ] **Step 3: Implement**

Create `src/shared/imagePaths.ts`:

```ts
// Image paths inside pasted text (spec 2026-09-07-image-attachments-design, 6). Runs in
// the renderer on a paste, never on typed text; no Node imports.
const EXT = String.raw`\.(?:png|jpe?g|gif|webp)`
// In order: a quoted path (Explorer's Copy as path puts "C:\dir\a.png" on the clipboard,
// quotes included), a file URL, a bare Windows drive or UNC path, a bare POSIX path. A
// bare path runs to the next whitespace or quote. The POSIX form must not start inside a
// URL or a Windows path, hence the lookbehind.
const PATTERN = new RegExp(
  String.raw`"([^"\r\n]+?${EXT})"` +
  String.raw`|(file:///?[^\s"']+?${EXT})` +
  String.raw`|((?:[A-Za-z]:[\\/]|\\\\)[^\s"']+?${EXT})` +
  String.raw`|(?<![\w:./\\])(/[^\s"']+?${EXT})`,
  'gi',
)

export function findImagePaths(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(PATTERN)) {
    const quoted = m[1], url = m[2], windows = m[3], posix = m[4]
    let path: string | undefined
    if (quoted !== undefined) path = quoted
    else if (url !== undefined) path = fromFileUrl(url)
    else if (windows !== undefined) path = windows
    else if (posix !== undefined) path = posix
    if (path && !found.includes(path)) found.push(path)
  }
  return found
}

// file:///C:/dir/a.png -> C:/dir/a.png ; file:///home/u/a.png -> /home/u/a.png ; percent
// escapes decoded. The two-slash host form (file://server/share) is not a path this app
// handles; it comes back as a POSIX path and fails to load, which the panel reports.
export function fromFileUrl(url: string): string {
  let rest = url.replace(/^file:\/\/\/?/i, '')
  try { rest = decodeURIComponent(rest) } catch { /* keep the raw form */ }
  if (/^[A-Za-z]:/.test(rest)) return rest
  return '/' + rest.replace(/^\/+/, '')
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/shared/imagePaths.test.ts`
Expected: PASS, 9 tests. If the `https://x.y/z.png` case matches, the lookbehind is wrong: `/z.png` is preceded by `y`, a word character, and must be excluded.

- [ ] **Step 5: Commit**

```bash
git add src/shared/imagePaths.ts src/shared/imagePaths.test.ts
git commit -m "shared: find image paths in pasted text (quoted, bare, UNC, POSIX, file URLs)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The chat controller sends images with the prompt and the steer

**Files:**
- Modify: `src/main/chat.ts:1-10,60-75,159-176`, `src/main/chat.test.ts`, `src/main/ipc.ts:8`

**Interfaces:**
- Consumes: `buildUserContent`, `UserContent` (Task 1), `ImageAttachment` (Task 1).
- Produces: `ChatController.prompt(text: string, images?: readonly ImageAttachment[]): void`; `ChatPort.prompt(text: string, images?: readonly ImageAttachment[]): void`.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/chat.test.ts` inside `describe('ChatController', ...)`, and add `import type { ImageAttachment } from '../shared/images'` at the top:

```ts
  const shot: ImageAttachment = { id: 'a', name: 'shot.png', mediaType: 'image/png', data: 'QUJD', width: 1, height: 1, bytes: 3 }
  const shotBlocks = (text: string) => [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    { type: 'text', text: '[Image #1: shot.png]' },
    ...(text ? [{ type: 'text', text }] : []),
  ]
  it('hands the brain content blocks when images ride along: images first, captions, trimmed text last', async () => {
    const out = fakeOut(); const prompts: unknown[] = []
    const brain: Brain = { async *respond(p) { prompts.push(p); yield { type: 'done' } }, stop() {} }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('  what is it  ', [shot])
    await new Promise(r => setTimeout(r, 10))
    expect(prompts).toEqual([shotBlocks('what is it')])
  })
  it('sends an images-only message with no trailing text block', async () => {
    const out = fakeOut(); const prompts: unknown[] = []
    const brain: Brain = { async *respond(p) { prompts.push(p); yield { type: 'done' } }, stop() {} }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('', [shot])
    await new Promise(r => setTimeout(r, 10))
    expect(prompts).toEqual([shotBlocks('')])
  })
  it('steers images into a running turn as content blocks', async () => {
    const out = fakeOut()
    let release!: () => void
    const steers: unknown[] = []
    const brain: Brain = {
      async *respond() { yield { type: 'text', delta: 'x' }; await new Promise<void>(r => { release = r }); yield { type: 'done' } },
      stop() {},
      steer(content) { steers.push(content); return true },
    }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('one')
    await new Promise(r => setTimeout(r, 5))
    c.prompt('and this?', [shot])
    expect(steers).toEqual([shotBlocks('and this?')])
    expect(out.systems).toEqual([])
    release()
    await new Promise(r => setTimeout(r, 5))
  })
  it('resends the same content on the stale-resume retry', async () => {
    const out = fakeOut(); const prompts: unknown[] = []
    let calls = 0
    const brain: Brain = {
      async *respond(p) {
        prompts.push(p)
        if (calls++ === 0) yield { type: 'done', error: 'No conversation found with session id old' }
        else yield { type: 'done', sessionId: 'fresh' }
      },
      stop() {},
    }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: { ...settings(), sessionId: 'old' } })
    c.prompt('again', [shot])
    await new Promise(r => setTimeout(r, 10))
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toEqual(prompts[0])
    expect(c.status().session).toBe('fresh')
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/main/chat.test.ts`
Expected: FAIL, `prompt` takes one argument and the brain receives a string.

- [ ] **Step 3: Implement**

In `src/main/chat.ts`, add the imports:

```ts
import { buildUserContent, type UserContent } from './brain/content'
import type { ImageAttachment } from '../shared/images'
```

Replace `prompt` (lines 60-75):

```ts
  // images are attachments already normalized and taken out of main's store, in chip order;
  // the renderer never sends any with a slash command, so chips survive one.
  prompt(text: string, images: readonly ImageAttachment[] = []): void {
    const parsed = parseCommand(text)
    if (parsed.ok) { this.run(parsed.command); return }
    if ('error' in parsed) { this.deps.out.system(parsed.error); return }
    const content = buildUserContent(text.trim(), images)
    if (this.running) {
      // A message typed mid-rite goes into the running turn: the CLI hands it to the model at
      // its next tool boundary, or runs it as the next turn if none is left (spec
      // 2026-09-07-mid-turn-steering-design). The panel already shows the operator's bubble,
      // so nothing is posted. Only a brain that cannot take it (the echo brain, or a turn
      // that is already draining) gets the refusal.
      if (this.deps.brain.steer?.(content)) return
      this.deps.out.system('Still working. Use /stop to abort the current rite.')
      return
    }
    void this.ask(content)
  }
```

Change `ask` (line 159) to `private async ask(content: UserContent): Promise<void> {` and its brain call (line 176) to `for await (const ev of this.deps.brain.respond(content, ctx)) {`.

In `src/main/ipc.ts` line 8, change `ChatPort` to:

```ts
export interface ChatPort { prompt(text: string, images?: readonly ImageAttachment[]): void; permissionAnswer(id: string, allow: boolean, remember?: boolean): void; stop(): void }
```

with `import type { ImageAttachment } from '../shared/images'` added to its imports.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run src/main/chat.test.ts && npm run typecheck`
Expected: PASS (the earlier steer tests still see plain strings, since no images means the plain string); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/chat.ts src/main/chat.test.ts src/main/ipc.ts
git commit -m "chat: a prompt or a steer carries staged images as content blocks" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: IPC, preload, the Electron codec, and main wiring

**Files:**
- Create: `src/main/images-electron.ts`
- Modify: `src/shared/ipc.ts:3-33,60-101`, `src/preload/index.ts`, `src/main/ipc.ts:1-30,78`, `src/main/index.ts:148-156,291-303,352-363`

**Interfaces:**
- Consumes: `normalizeImage`, `loadImagePath`, `nodeImageFs`, `AttachmentStore`, `NormalizeResult`, `ImageCodec`, `DecodedImage` (Tasks 4, 5); `ChatPort.prompt(text, images)` (Task 7).
- Produces: channels `CH.imageStageBytes`, `CH.imageStagePath`, `CH.imageDiscard`; payloads `ChatPromptPayload { text; images?: string[] }`, `StageBytesPayload { bytes: Uint8Array; mediaType?: string; name: string }`, `StagePathPayload { path: string }`, `StageResult = StagedImage | { error: string }`; bridge methods `prompt(text, imageIds?)`, `stageImageBytes(bytes, mediaType, name): Promise<StageResult>`, `stageImagePath(path): Promise<StageResult>`, `discardImage(id)`, `pathForFile(file: File): string`; `ImagePort` in `src/main/ipc.ts`; `electronCodec`.

- [ ] **Step 1: Shared channel and payload types**

In `src/shared/ipc.ts`, add to `CH` after `chatStop`:

```ts
  imageStageBytes: 'image:stageBytes',
  imageStagePath: 'image:stagePath',
  imageDiscard: 'image:discard',
```

Add after the `OriginPayload` interface:

```ts
export interface ChatPromptPayload { text: string; images?: string[] }
// A pasted bitmap: the file's bytes, its type when the clipboard knew it, a display name.
export interface StageBytesPayload { bytes: Uint8Array; mediaType?: string; name: string }
export interface StagePathPayload { path: string }
export type StageResult = StagedImage | { error: string }
```

with `import type { StagedImage } from './images'` at the top. In `BuddyBridge`, replace `prompt(text: string): void` with:

```ts
  prompt(text: string, imageIds?: string[]): void
  stageImageBytes(bytes: Uint8Array, mediaType: string | undefined, name: string): Promise<StageResult>
  stageImagePath(path: string): Promise<StageResult>
  discardImage(id: string): void
  /** The OS path behind a File from a paste or a drop; empty for a File with no path (a
   * synthetic one, or bytes an app handed over), which then goes the bytes route. */
  pathForFile(file: File): string
```

- [ ] **Step 2: Preload**

In `src/preload/index.ts`, change the electron import to `import { contextBridge, ipcRenderer, webUtils } from 'electron'`, the CH import to also bring `type ChatPromptPayload, type StageBytesPayload, type StagePathPayload`, and replace the `prompt` line with:

```ts
  prompt: (text, imageIds) => ipcRenderer.send(CH.chatPrompt, { text, images: imageIds } satisfies ChatPromptPayload),
  stageImageBytes: (bytes, mediaType, name) => ipcRenderer.invoke(CH.imageStageBytes, { bytes, mediaType, name } satisfies StageBytesPayload),
  stageImagePath: (path) => ipcRenderer.invoke(CH.imageStagePath, { path } satisfies StagePathPayload),
  discardImage: (id) => ipcRenderer.send(CH.imageDiscard, { id }),
  // webUtils works in a sandboxed preload; the File must be the renderer's own object,
  // which contextBridge passes through for this call.
  pathForFile: (file) => webUtils.getPathForFile(file),
```

- [ ] **Step 3: The Electron codec**

Create `src/main/images-electron.ts`:

```ts
// The production ImageCodec over Electron's nativeImage, kept out of images.ts so that file
// and its tests run under plain Node. nativeImage decodes PNG and JPEG; anything else
// comes back empty and images.ts passes it through or refuses it.
import { nativeImage, type NativeImage } from 'electron'
import type { DecodedImage, ImageCodec } from './images'

function wrap(img: NativeImage): DecodedImage {
  const { width, height } = img.getSize()
  return {
    width, height,
    resize(maxEdge) {
      const scale = maxEdge / Math.max(width, height)
      return wrap(img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' }))
    },
    png: () => img.toPNG(),
    jpeg: (quality) => img.toJPEG(quality),
    // Height only: nativeImage keeps the aspect ratio when one side is given.
    thumbnail: (h) => img.resize({ height: h, quality: 'good' }).toDataURL(),
  }
}

export const electronCodec: ImageCodec = {
  decode(bytes) {
    const img = nativeImage.createFromBuffer(bytes)
    return img.isEmpty() ? null : wrap(img)
  },
}
```

- [ ] **Step 4: Main IPC handlers**

In `src/main/ipc.ts`, extend the shared import to `CH, type ChatPromptPayload, type ChatStatusPayload, type OriginPayload, type PackLoadedPayload, type StageBytesPayload, type StagePathPayload, type StageResult, type ThemePayload`, and add after `ChatPort`:

```ts
// Main's side of the panel's attachment chips (spec 7): stage returns what the chip shows
// or the refusal reason; take hands the attachments to the chat controller in chip order.
export interface ImagePort {
  stageBytes(p: StageBytesPayload): StageResult
  stagePath(p: StagePathPayload): StageResult
  discard(id: string): void
  take(ids: readonly string[]): ImageAttachment[]
}
```

Add `images: ImagePort` to `IpcDeps` (after `chat: ChatPort`). Replace the `chatPrompt` line (78) and add the handlers:

```ts
  ipcMain.on(CH.chatPrompt, (_e, p: ChatPromptPayload) => d.chat.prompt(p.text, d.images.take(p.images ?? [])))
  // invoke, not send: the renderer awaits the chip it should show, or the reason.
  ipcMain.handle(CH.imageStageBytes, (_e, p: StageBytesPayload) => d.images.stageBytes(p))
  ipcMain.handle(CH.imageStagePath, (_e, p: StagePathPayload) => d.images.stagePath(p))
  ipcMain.on(CH.imageDiscard, (_e, p: { id: string }) => d.images.discard(p.id))
```

- [ ] **Step 5: Wire the store in main/index.ts**

Add the imports:

```ts
import { AttachmentStore, loadImagePath, nodeImageFs, normalizeImage, type NormalizeResult } from './images'
import { electronCodec } from './images-electron'
import type { ImagePort } from './ipc'
import type { StageResult } from '../shared/ipc'
```

Just before `const out = {` (line 148), add:

```ts
  // Attachments staged in the panel and not yet sent (spec 5). Cleared with the panel.
  const store = new AttachmentStore()
```

and change the `clear` line of `out` to:

```ts
    clear: () => { store.clear(); toHologram(CH.chatClear) },
```

After `chatRef = chat` (line 303), add:

```ts
  // The panel's chips: normalize with the real codec, stage, and answer with the chip or the
  // reason. A pasted path resolves against the workspace the chat controller holds now.
  const stageResult = (r: NormalizeResult): StageResult => {
    if (!r.ok) return { error: r.reason }
    const staged = store.stage(r.attachment)
    return staged.ok ? r.staged : { error: staged.reason }
  }
  const images: ImagePort = {
    stageBytes: (p) => stageResult(normalizeImage({
      bytes: Buffer.from(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength), mediaType: p.mediaType, name: p.name,
    }, electronCodec)),
    stagePath: (p) => stageResult(loadImagePath(p.path, chat.status().workspace, nodeImageFs, electronCodec)),
    discard: (id) => store.discard(id),
    take: (ids) => store.take(ids),
  }
```

Add `images,` to the `wireIpc({ ... })` call after `chat, status: () => chat.status(),`.

- [ ] **Step 6: Typecheck, unit tests, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean. The renderer does not compile against the new bridge methods yet (it only calls `prompt(text)`, which still typechecks with the optional second parameter).

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/images-electron.ts src/main/ipc.ts src/main/index.ts
git commit -m "ipc: stage, discard and send image attachments; nativeImage codec; store wired in main" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The panel: chips, paste, drop, send

**Files:**
- Modify: `src/renderer/hologram/index.html:16-21`, `src/renderer/hologram/styles.css` (append), `src/renderer/hologram/main.ts:1-9,90-99,240-257,270-283`

**Interfaces:**
- Consumes: bridge methods from Task 8, `findImagePaths` (Task 6), `StagedImage`, `StageResult`.

- [ ] **Step 1: Markup**

In `src/renderer/hologram/index.html`, insert between the `#permission` div and the textarea:

```html
      <div id="attachments" hidden></div>
```

- [ ] **Step 2: Styles**

Append to `src/renderer/hologram/styles.css`:

```css
#attachments { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 8px; border-top: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
#attachments[hidden] { display: none; }
.chip { position: relative; border: 1px solid var(--accent); border-radius: 3px; padding: 2px; background: rgba(0,0,0,0.3); }
.chip img { display: block; height: 40px; }
.chip .label { position: absolute; left: 3px; bottom: 3px; font-size: 11px; line-height: 1; padding: 1px 3px; background: rgba(0,0,0,0.6); color: var(--accent); letter-spacing: 0.06em; }
.chip .remove { position: absolute; top: -7px; right: -7px; width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--accent); background: var(--bg); color: var(--text); font: inherit; font-size: 11px; line-height: 1; padding: 0; cursor: pointer; }
.msg.user .thumbs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
.msg.user .thumbs img { display: block; height: 60px; border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent); border-radius: 3px; }
```

`#attachments[hidden]` is load-bearing: the `display: flex` rule would otherwise beat the `hidden` attribute.

- [ ] **Step 3: Renderer logic**

In `src/renderer/hologram/main.ts`, add the imports after line 6:

```ts
import { findImagePaths } from '../../shared/imagePaths'
import type { StageResult } from '../../shared/ipc'
import type { StagedImage } from '../../shared/images'
```

Add after the `panel`/`coneCanvas` line (11):

```ts
const strip = $<HTMLDivElement>('attachments')
// Chips waiting under the log, in send order. Main holds the bytes; this is ids and thumbs.
let staged: StagedImage[] = []
```

Add after the `add(...)` function (after line 99):

```ts
function renderChips(): void {
  strip.replaceChildren()
  staged.forEach((s, i) => {
    const chip = document.createElement('div'); chip.className = 'chip'; chip.title = s.name
    const im = document.createElement('img'); im.src = s.thumb; im.alt = s.name
    const label = document.createElement('span'); label.className = 'label'; label.textContent = `#${i + 1}`
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove'; remove.textContent = '×'; remove.title = 'remove'
    remove.addEventListener('click', () => {
      staged = staged.filter(x => x.id !== s.id)
      window.buddy.discardImage(s.id)
      renderChips(); input.focus()
    })
    chip.append(im, label, remove)
    strip.appendChild(chip)
  })
  strip.hidden = staged.length === 0
  log.scrollTop = log.scrollHeight
}
// A refusal is a local system line; it never blocks the text (spec 10).
function accept(r: StageResult): void {
  if ('error' in r) { current = null; add('system', renderMarkdown(`image: ${r.error}`)); return }
  staged.push(r)
  renderChips()
}
// A File with a path (copied in Explorer, dropped) goes by path so main reads and names it;
// one without (a snip on the clipboard, a synthetic File in tests) goes by bytes.
async function stageFile(file: File): Promise<void> {
  const path = window.buddy.pathForFile(file)
  const r = path
    ? await window.buddy.stageImagePath(path)
    : await window.buddy.stageImageBytes(new Uint8Array(await file.arrayBuffer()), file.type || undefined, file.name || 'pasted.png')
  accept(r)
}
// The operator's bubble: thumbnails above the text, either part optional.
function addUser(text: string, thumbs: string[]): void {
  const el = add('user', text ? renderMarkdown(text) : '')
  if (!text) el.querySelector('.text')?.remove()
  if (thumbs.length) {
    const row = document.createElement('div'); row.className = 'thumbs'
    for (const t of thumbs) { const im = document.createElement('img'); im.src = t; row.appendChild(im) }
    el.insertBefore(row, el.firstChild)
  }
  log.scrollTop = log.scrollHeight
}
```

In `onChatClear` (line 245), add after `pendingFaces.length = 0`:

```ts
  staged = []
  renderChips()
```

Replace the `input.addEventListener('keydown', ...)` block (lines 270-282) with:

```ts
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); if (pending) answer(false); else window.buddy.closePanel(); return }
  if (e.key === 'ArrowUp' && input.value === '') { input.value = lastInput; growInput(); return }
  if (e.key === 'Backspace' && input.value === '' && staged.length) {
    e.preventDefault()
    const last = staged.pop()
    if (last) window.buddy.discardImage(last.id)
    renderChips()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const text = input.value.trim()
    if (!text && staged.length === 0) return
    if (text.startsWith('/')) {
      // A command never consumes the chips.
      lastInput = text; input.value = ''; growInput()
      current = null
      window.buddy.prompt(text)
      return
    }
    if (text) lastInput = text
    input.value = ''; growInput()
    addUser(text, staged.map(s => s.thumb))
    current = null
    window.buddy.prompt(text, staged.map(s => s.id))
    staged = []
    renderChips()
  }
})
// Paste, in order of preference: bitmap items (a snip), files (copied in Explorer), then
// image paths inside pasted text, which the browser still inserts into the box.
input.addEventListener('paste', (e) => {
  const dt = e.clipboardData
  if (!dt) return
  const imageItems = Array.from(dt.items).filter(i => i.kind === 'file' && i.type.startsWith('image/'))
  if (imageItems.length) {
    e.preventDefault()
    for (const item of imageItems) { const f = item.getAsFile(); if (f) void stageFile(f) }
    return
  }
  if (dt.files.length) {
    e.preventDefault()
    for (const f of Array.from(dt.files)) void stageFile(f)
    return
  }
  for (const p of findImagePaths(dt.getData('text/plain'))) void window.buddy.stageImagePath(p).then(accept)
})
panel.addEventListener('dragover', (e) => e.preventDefault())
panel.addEventListener('drop', (e) => {
  e.preventDefault()
  for (const f of Array.from(e.dataTransfer?.files ?? [])) void stageFile(f)
})
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: clean. If `e.dataTransfer` is typed as possibly null and the optional chain is flagged, keep it; if `File` is unknown to the main-process typecheck of `shared/ipc.ts`, the `DOM` lib in `tsconfig.json` already covers it.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hologram/index.html src/renderer/hologram/styles.css src/renderer/hologram/main.ts
git commit -m "panel: paste or drop an image, see it as a chip, send it with the text" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: End to end against the fake brain

**Files:**
- Create: `test/fixtures/images/probe.png`, `e2e/images.spec.ts`

**Interfaces:**
- Consumes: scenario `images` (Task 2), the panel (Task 9).

- [ ] **Step 1: Generate the fixture**

From the worktree root in PowerShell (creates a 300 by 120 PNG: red, green and blue squares over the text MAGOS 42):

```powershell
New-Item -ItemType Directory -Force test\fixtures\images | Out-Null; Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap 300, 120; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::White); $g.FillRectangle([System.Drawing.Brushes]::Red, 10, 10, 80, 60); $g.FillRectangle([System.Drawing.Brushes]::Green, 110, 10, 80, 60); $g.FillRectangle([System.Drawing.Brushes]::Blue, 210, 10, 80, 60); $f = [System.Drawing.Font]::new('Arial', [single]20, [System.Drawing.FontStyle]::Bold); $g.DrawString('MAGOS 42', $f, [System.Drawing.Brushes]::Black, [single]40, [single]78); $bmp.Save((Resolve-Path test\fixtures\images).Path + '\probe.png', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); $f.Dispose(); (Get-Item test\fixtures\images\probe.png).Length
```

Expected: a file of roughly 2.4 kB.

- [ ] **Step 2: Write the spec**

Create `e2e/images.spec.ts`:

```ts
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanEnv } from './env'

// Same shape as brain.spec.ts: node.exe runs the fake CLI in front of the real flags. The
// fake's images scenario reports what the prompt carried, so the wire shape is asserted
// end to end without a real model. An isolated profile keeps this run off the live one.
const fakeCliScript = join(__dirname, '../test/fake-claude.cjs')
const fixture = join(__dirname, '../test/fixtures/images/probe.png')
const fixtureBase64 = readFileSync(fixture).toString('base64')

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}

let app: ElectronApplication | undefined
let userDataDir: string

async function launch(): Promise<Page> {
  userDataDir = mkdtempSync(join(tmpdir(), 'buddy-e2e-images-'))
  app = await electron.launch({
    args: ['.'],
    env: cleanEnv({
      BUDDY_TEST: '1',
      BUDDY_USER_DATA: userDataDir,
      BUDDY_CLI_PATH: process.execPath,
      BUDDY_CLI_ARGS: JSON.stringify([fakeCliScript]),
      FAKE_CLAUDE_SCENARIO: 'images',
    }),
  })
  const hologram = await windowByUrl(app, 'hologram')
  await hologram.waitForLoadState('networkidle')
  await app.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  await hologram.locator('#input').waitFor()
  return hologram
}

test.afterEach(async () => {
  if (app) { const toClose = app; app = undefined; await toClose.close() }
  rmSync(userDataDir, { recursive: true, force: true })
})

// A synthetic paste: a ClipboardEvent whose DataTransfer holds a File built from the
// fixture. Such a File has no OS path, so it takes the bytes route, as a snip does.
async function pasteFile(hologram: Page): Promise<void> {
  await hologram.locator('#input').focus()
  await hologram.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const file = new File([bytes], 'probe.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    document.getElementById('input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, fixtureBase64)
}

test('a pasted bitmap becomes a chip, rides with the text, and shows in the bubble', async () => {
  const hologram = await launch()
  await pasteFile(hologram)
  await expect(hologram.locator('#attachments .chip')).toHaveCount(1)
  await expect(hologram.locator('#attachments .chip .label')).toHaveText('#1')

  await hologram.locator('#input').fill('what is this')
  await hologram.locator('#input').press('Enter')

  await expect(hologram.locator('.msg.user .thumbs img')).toHaveCount(1)
  await expect(hologram.locator('#attachments')).toBeHidden()
  const reply = hologram.locator('.msg.buddy').last()
  await expect.poll(() => reply.textContent(), { timeout: 15000 }).toContain('images=1 media=image/png text=[Image #1: probe.png] what is this')
})

test('a pasted path stages the file by path', async () => {
  const hologram = await launch()
  await hologram.locator('#input').focus()
  await hologram.evaluate((path) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', `look at ${path} please`)
    document.getElementById('input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, fixture)
  await expect(hologram.locator('#attachments .chip')).toHaveCount(1)
  await expect(hologram.locator('#attachments .chip')).toHaveAttribute('title', 'probe.png')
})

test('a dropped file stages, Backspace on an empty box removes the last chip', async () => {
  const hologram = await launch()
  await hologram.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
    document.getElementById('panel')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, fixtureBase64)
  await expect(hologram.locator('#attachments .chip')).toHaveCount(1)
  await hologram.locator('#input').focus()
  await hologram.locator('#input').press('Backspace')
  await expect(hologram.locator('#attachments .chip')).toHaveCount(0)
  await expect(hologram.locator('#attachments')).toBeHidden()
})

test('a refused file posts a reason and stages nothing', async () => {
  const hologram = await launch()
  await hologram.locator('#input').focus()
  await hologram.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'junk.png', { type: 'image/png' }))
    document.getElementById('input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await expect(hologram.locator('.msg.system').last()).toContainText('image: cannot decode')
  await expect(hologram.locator('#attachments .chip')).toHaveCount(0)
})
```

- [ ] **Step 3: Run the spec**

Run: `npm run build && npx playwright test e2e/images.spec.ts`
Expected: 4 passed. Failure notes: if the chip never appears on the bitmap test, read the userData `logs/hologram.log` for a renderer error; if `ClipboardEvent` rejects `clipboardData`, dispatch a generic `Event('paste')` with a `clipboardData` property defined via `Object.defineProperty` instead, and keep the assertions.

- [ ] **Step 4: Run the whole e2e suite**

Run: `npm run test:e2e`
Expected: every earlier spec still passes; `brain.spec.ts` still sees `Hello` from the default scenario because the fake's `prompt` text is unchanged for strings.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/images/probe.png e2e/images.spec.ts
git commit -m "e2e: paste, path, drop and refusal of image attachments against the fake brain" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The by-hand smoke, the README, the full run

**Files:**
- Create: `scripts/smoke-image.mjs`
- Modify: `package.json` (scripts), `README.md:69-73`

- [ ] **Step 1: The smoke script**

Create `scripts/smoke-image.mjs`:

```js
#!/usr/bin/env node
// One-off smoke test against the REAL Claude Code CLI: does stream-json stdin accept an
// image content block, as the prompt and as a later user line? Spends two haiku turns on
// the subscription; never run by any test. `npm run smoke:image`. Measured 2026-09-07 on
// 2.1.261: both answered with the squares' colours and the text MAGOS 42.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function expandEnv(s) {
  return s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] ?? m)
}
const cliPath = expandEnv(process.env.BUDDY_CLI_PATH || '%USERPROFILE%\\.local\\bin\\claude.exe')
const here = dirname(fileURLToPath(import.meta.url))
const png = readFileSync(join(here, '../test/fixtures/images/probe.png')).toString('base64')
const question = 'Answer in one line: what colours are the three squares from left to right, and what text is written under them? If you see no image, say NO IMAGE.'
const imageLine = JSON.stringify({ type: 'user', message: { role: 'user', content: [
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
  { type: 'text', text: '[Image #1: probe.png]' },
  { type: 'text', text: question },
] } }) + '\n'

function run(mode) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
      '--model', 'haiku', '--setting-sources', 'project', '--session-id', randomUUID(), '--tools', '', '--strict-mcp-config']
    const env = { ...process.env }
    delete env.CLAUDECODE; delete env.ANTHROPIC_API_KEY
    const child = spawn(cliPath, args, { cwd: here, env })
    child.stdin.on('error', () => {})
    if (mode === 'prompt') { child.stdin.write(imageLine); child.stdin.end() }
    else {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Reply with exactly the word READY and nothing else.' } }) + '\n')
      setTimeout(() => { child.stdin.write(imageLine); child.stdin.end() }, 300)
    }
    let rest = ''
    const results = []
    child.stdout.on('data', (c) => {
      rest += c.toString('utf8')
      const lines = rest.split('\n'); rest = lines.pop() ?? ''
      for (const l of lines) { if (!l.trim()) continue; try { const p = JSON.parse(l); if (p.type === 'result') results.push(p) } catch { /* not json */ } }
    })
    child.on('error', (e) => { console.log(`smoke-image: ${mode}: failed to spawn ${cliPath}: ${e.message}`); resolve(false) })
    child.on('close', (code) => {
      console.log(`smoke-image: ${mode}: exit ${code}, ${results.length} result line(s)`)
      results.forEach((r, i) => console.log(`smoke-image: ${mode}: result ${i + 1}: is_error=${r.is_error} text=${String(r.result)}`))
      resolve(results.length > 0 && results.every((r) => r.is_error !== true))
    })
  })
}

const okPrompt = await run('prompt')
const okSteer = await run('steer')
process.exitCode = okPrompt && okSteer ? 0 : 1
```

Add to `package.json` scripts, after `smoke:claude`:

```json
    "smoke:image": "node scripts/smoke-image.mjs"
```

- [ ] **Step 2: README**

In `README.md`, after the paragraph ending `` `/stop` still aborts. `` (line 70) and before the Dictation paragraph, add:

```markdown
Images: paste a screenshot (Win+Shift+S, then Ctrl+V in the panel), a file copied in
Explorer, or an image path, or drop a file on the panel. Each shows a chip under the log
and reaches him inline as `[Image #N]`, mid-rite too; the × or Backspace in an empty box
removes one. For small text snip the region rather than the whole screen.
```

- [ ] **Step 3: Run everything**

Run: `npm test && npm run typecheck && npm run test:e2e`
Expected: all green. Then, by hand, with the real CLI logged in: `npm run smoke:image`, expected two results naming red, green, blue and MAGOS 42.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-image.mjs package.json README.md
git commit -m "docs: README describes image attachments; smoke:image probes the real CLI by hand" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Manual verification before merge (Peter)**

Restart the buddy from the branch build (`npm run dev` from the main tree after merging, never from the worktree), then: Win+Shift+S a region of an error message, Ctrl+V in the panel, ask what it says; paste a path from Explorer's Copy as path; drop a PNG on the panel; paste an image mid-rite while a tool loop runs. He should read the error text back and never raise a Sanction card for the path.
