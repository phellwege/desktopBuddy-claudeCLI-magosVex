# Mechanicus Buddy, Plan A: Body, Hologram, Echo Brain

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A transparent Electron overlay in which a persona-pack character wanders the bottom edge of the primary screen, emotes, and on click raises a hologram chat panel driven by an offline echo brain and slash commands.

**Architecture:** Electron main process owns a pure TypeScript state machine (`Buddy`), a `BuddyActions` facade, and a `ChatController` that routes prompts to slash commands or a `Brain`. Two renderer windows only draw and report over typed IPC. A Python pipeline turns the generated sprite sheet into an atlas inside a persona pack.

**Tech Stack:** Electron (latest stable, pinned after install), electron-vite, TypeScript 5, Vitest, zod, marked, DOMPurify, highlight.js, Playwright (Electron driver). Python 3.12 with Pillow, numpy, scipy, pytest for tools.

Spec: `docs/superpowers/specs/2026-09-03-mechanicus-buddy-design.md`. Plan B (Claude brain) follows this plan and is in `2026-09-03-mechanicus-buddy-brain.md`.

## Global Constraints

- Windows 11, primary display only, Node 24, npm.
- Package manager: npm. Commit after every task with the trailer
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- No em dashes in any user-facing text, comments, or docs (owner rule).
- Application code never names the Mechanicus; all character specifics live in `packs/<name>/`.
- Renderers have no Node access: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- The state machine in `src/main/buddy.ts` imports nothing from Electron and owns no timers.
- Position `x` is a fraction 0 to 1 of the walkable width; speeds are fractions of walkable width per second: walk 0.08, run 0.25.
- Wander: every 8 to 30 s; walk under 0.25 distance, run above; rest 5 to 20 s on arrival; sleep after 10 min quiet.
- Overlay strip height: 260 px. Hologram: 480 by 360.
- Atlas frames carry their own size and a feet-center anchor (`ax`, `ay`); the renderer draws at `(posX - ax, baselineY - ay)`. This refines spec section 4.4 and is the authoritative format.

## File Structure

```
package.json                     scripts, deps
electron.vite.config.ts          main, preload, two renderer entries
tsconfig.json                    one config, ES2022, DOM + node types
vitest.config.ts                 unit tests under src/**/*.test.ts
playwright.config.ts             e2e under e2e/
.gitignore                       node_modules, out, build, dist
src/shared/types.ts              Activity, Mood, Facing, EmoteKind, AnimationKey, BuddyState,
                                 Atlas, AtlasFrame, AnimationDef, PackTheme, LineKey, PackData
src/shared/ipc.ts                channel names and payload types (single source of truth)
src/main/index.ts                bootstrap: protocol, config, pack, windows, tray, ipc
src/main/config.ts               load/save config.json with defaults
src/main/pack.ts                 zod schemas, loadPack(dir), animation fallbacks
src/main/buddy.ts                pure state machine
src/main/actions.ts              BuddyActions over Buddy + windows + hologram
src/main/commands.ts             slash command parser (pure)
src/main/chat.ts                 ChatController: prompt routing, brain events to IPC
src/main/brain/types.ts          Brain, BrainEvent, BrainContext
src/main/brain/echo.ts           EchoBrain
src/main/windows.ts              overlay + hologram BrowserWindows, bounds, hover toggle
src/main/tray.ts                 tray icon + menu
src/main/menu.ts                 right-click context menu
src/main/protocol.ts             pack:// scheme serving the active pack directory
src/main/ipc.ts                  wires channels to actions/chat
src/preload/index.ts             contextBridge API for both renderers
src/renderer/overlay/index.html  canvas host
src/renderer/overlay/main.ts     IPC glue, animation loop
src/renderer/overlay/animator.ts frame timing (pure, tested)
src/renderer/overlay/motion.ts   x interpolation (pure, tested)
src/renderer/overlay/hittest.ts  alpha hit test against current frame
src/renderer/hologram/index.html panel markup
src/renderer/hologram/main.ts    IPC glue, input handling
src/renderer/hologram/markdown.ts marked + DOMPurify + highlight (tested)
src/renderer/hologram/styles.css theme via CSS variables
packs/mechanicus/manifest.json   from spec 4.1
packs/mechanicus/persona.md      from spec 4.2
packs/mechanicus/animations.json hand-authored from the pipeline draft
packs/mechanicus/atlas.png|json  pipeline output, committed
tools/clean.py                   alpha threshold + stretch
tools/upscale.py                 realesrgan-ncnn-vulkan if present, else Lanczos 2x
tools/slice.py                   bands, components, fragments, normalize, atlas, draft
tools/rows.json                  band names, x/y ranges, expected counts
tools/overrides.json             merges/splits by component id
tools/debug_render.py            draws boxes and labels for eyeballing
tools/test_pipeline.py           pytest for clean, slice, normalize
test/fixtures/pack-min/          tiny valid pack for unit tests
e2e/body.spec.ts                 Playwright Electron smoke test
```

---

### Task 1: Project scaffold that builds and runs an empty test

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/overlay/index.html`, `src/renderer/overlay/main.ts`, `src/renderer/hologram/index.html`, `src/renderer/hologram/main.ts`, `src/shared/smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `test`, `typecheck`, `test:e2e`.

- [ ] **Step 1: Install dependencies**

Run from `C:\repo\mechanicus-buddy`:

```bash
npm init -y
npm install --save-dev electron@latest electron-vite@latest vite@latest typescript@latest vitest@latest @types/node@latest @playwright/test@latest
npm install zod@latest marked@latest dompurify@latest highlight.js@latest
npx playwright install chromium
```

Then open `package.json` and replace it with:

```json
{
  "name": "mechanicus-buddy",
  "version": "0.1.0",
  "private": true,
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {},
  "dependencies": {}
}
```

Re-run `npm install` so the dependency blocks are refilled with the pinned versions npm chose. Record the Electron major in a comment at the top of `electron.vite.config.ts`.

- [ ] **Step 2: Write config files**

`electron.vite.config.ts`:

```ts
// Electron <major recorded here at install time>
import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } },
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          hologram: resolve(__dirname, 'src/renderer/hologram/index.html'),
        },
      },
    },
  },
})
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node", "vite/client"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "noEmit": true
  },
  "include": ["src", "e2e", "test"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
```

`.gitignore`:

```
node_modules/
out/
build/
dist/
test-results/
playwright-report/
```

- [ ] **Step 3: Write placeholder entry points**

`src/main/index.ts`:

```ts
import { app } from 'electron'
app.whenReady().then(() => {
  console.log('mechanicus-buddy boot')
  app.quit()
})
```

`src/preload/index.ts`:

```ts
import { contextBridge } from 'electron'
contextBridge.exposeInMainWorld('buddy', { version: 1 })
```

`src/renderer/overlay/index.html` and `src/renderer/hologram/index.html` (same content, change the title):

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>overlay</title></head>
<body><script type="module" src="./main.ts"></script></body></html>
```

`src/renderer/overlay/main.ts` and `src/renderer/hologram/main.ts`:

```ts
console.log('renderer boot')
```

- [ ] **Step 4: Write the smoke test**

`src/shared/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
describe('toolchain', () => {
  it('runs vitest', () => { expect(1 + 1).toBe(2) })
})
```

- [ ] **Step 5: Verify build, typecheck, and tests**

Run: `npm run build && npm run typecheck && npm test`
Expected: build writes `out/main/index.js`, `out/preload/index.js`, `out/renderer/overlay/index.html`, `out/renderer/hologram/index.html`; typecheck exits 0; vitest reports 1 passed.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold electron-vite project with vitest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Shared types and the slash command parser

**Files:**
- Create: `src/shared/types.ts`, `src/main/commands.ts`, `src/main/commands.test.ts`

**Interfaces:**
- Produces (used by every later task):

```ts
// src/shared/types.ts
export type Activity = 'idle' | 'walking' | 'running' | 'hopping' | 'sitting' |
  'sleeping' | 'looking' | 'projecting' | 'emoting'
export type Mood = 'calm' | 'happy' | 'thinking' | 'confused' | 'alarmed'
export type Facing = 'left' | 'right'
export type EmoteKind = 'happy' | 'thinking' | 'confused' | 'alarmed' | 'look' | 'hop'
export type AnimationKey = 'idle' | 'walk' | 'run' | 'hop' | 'fall' | 'sit' | 'sleep' |
  'look' | 'project' | 'emote_happy' | 'emote_thinking' | 'emote_confused' | 'emote_alarmed'
export interface BuddyState { x: number; facing: Facing; activity: Activity; mood: Mood;
  panelOpen: boolean; asleep: boolean; targetX?: number }
export interface AtlasFrame { x: number; y: number; w: number; h: number; ax: number; ay: number }
export interface Atlas { image: string; maxFrameSize: [number, number]; frames: Record<string, AtlasFrame> }
export interface AnimationDef { right: string[]; left: string[]; fps: number; loop: boolean; mirrorLeft: boolean }
export type Animations = Record<AnimationKey, AnimationDef>
export interface PackTheme { accent: string; glow: string; background: string; text: string; font: string; glyph: string }
export type LineKey = 'greeting' | 'idleMutter' | 'thinking' | 'toolRunning' | 'permissionAsk' |
  'permissionDenied' | 'authError' | 'cliMissing' | 'error' | 'sleep' | 'wake' | 'stopped'
export interface PackData { dir: string; name: string; scale: number; theme: PackTheme;
  persona: { prompt: string; defaultMood: Mood; lines: Record<LineKey, string[]> };
  atlas: Atlas; animations: Animations }
export const WALK_SPEED = 0.08
export const RUN_SPEED = 0.25
```

```ts
// src/main/commands.ts
export type Command =
  | { kind: 'goto'; x: number; run: boolean }
  | { kind: 'mood'; mood: Mood }
  | { kind: 'emote'; emote: EmoteKind }
  | { kind: 'sleep' } | { kind: 'wake' } | { kind: 'stop' } | { kind: 'new' } | { kind: 'help' }
  | { kind: 'cd'; path: string }
  | { kind: 'model'; model: string | null }
export type ParseResult =
  | { ok: true; command: Command }
  | { ok: false; error: string }
  | { ok: false; notCommand: true }
export function parseCommand(input: string): ParseResult
export const HELP_TEXT: string
```

- [ ] **Step 1: Write `src/shared/types.ts`** with exactly the content in the Interfaces block above (plus a one-line header comment).

- [ ] **Step 2: Write the failing tests**

`src/main/commands.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseCommand } from './commands'

describe('parseCommand', () => {
  it('treats non-slash text as not a command', () => {
    expect(parseCommand('hello there')).toEqual({ ok: false, notCommand: true })
  })
  it('parses /goto with a percentage', () => {
    expect(parseCommand('/goto 40')).toEqual({ ok: true, command: { kind: 'goto', x: 0.4, run: false } })
  })
  it('parses /goto with left, center, right', () => {
    expect(parseCommand('/goto left')).toEqual({ ok: true, command: { kind: 'goto', x: 0, run: false } })
    expect(parseCommand('/goto center')).toEqual({ ok: true, command: { kind: 'goto', x: 0.5, run: false } })
    expect(parseCommand('/goto right')).toEqual({ ok: true, command: { kind: 'goto', x: 1, run: false } })
  })
  it('clamps /goto outside 0..100', () => {
    expect(parseCommand('/goto 250')).toEqual({ ok: true, command: { kind: 'goto', x: 1, run: false } })
    expect(parseCommand('/goto -5')).toEqual({ ok: true, command: { kind: 'goto', x: 0, run: false } })
  })
  it('parses /run as goto with run', () => {
    expect(parseCommand('/run 80')).toEqual({ ok: true, command: { kind: 'goto', x: 0.8, run: true } })
  })
  it('rejects /goto with garbage', () => {
    expect(parseCommand('/goto sideways')).toEqual({ ok: false, error: 'usage: /goto <0-100|left|center|right>' })
  })
  it('parses moods and emotes and rejects unknown ones', () => {
    expect(parseCommand('/mood confused')).toEqual({ ok: true, command: { kind: 'mood', mood: 'confused' } })
    expect(parseCommand('/emote hop')).toEqual({ ok: true, command: { kind: 'emote', emote: 'hop' } })
    expect(parseCommand('/mood ecstatic')).toEqual({ ok: false, error: 'unknown mood: ecstatic' })
    expect(parseCommand('/emote dance')).toEqual({ ok: false, error: 'unknown emote: dance' })
  })
  it('parses bare commands', () => {
    for (const k of ['sleep', 'wake', 'stop', 'new', 'help'] as const) {
      expect(parseCommand('/' + k)).toEqual({ ok: true, command: { kind: k } })
    }
  })
  it('parses /cd and /model', () => {
    expect(parseCommand('/cd C:\\repo\\fitstudio')).toEqual({ ok: true, command: { kind: 'cd', path: 'C:\\repo\\fitstudio' } })
    expect(parseCommand('/model sonnet')).toEqual({ ok: true, command: { kind: 'model', model: 'sonnet' } })
    expect(parseCommand('/model')).toEqual({ ok: true, command: { kind: 'model', model: null } })
    expect(parseCommand('/cd')).toEqual({ ok: false, error: 'usage: /cd <path>' })
  })
  it('reports unknown commands', () => {
    expect(parseCommand('/dance')).toEqual({ ok: false, error: 'unknown command: /dance (try /help)' })
  })
  it('is case-insensitive on the command word and trims whitespace', () => {
    expect(parseCommand('  /GOTO 10 ')).toEqual({ ok: true, command: { kind: 'goto', x: 0.1, run: false } })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/main/commands.test.ts`
Expected: FAIL, cannot find module './commands'.

- [ ] **Step 4: Implement `src/main/commands.ts`**

```ts
import type { EmoteKind, Mood } from '../shared/types'

export type Command =
  | { kind: 'goto'; x: number; run: boolean }
  | { kind: 'mood'; mood: Mood }
  | { kind: 'emote'; emote: EmoteKind }
  | { kind: 'sleep' } | { kind: 'wake' } | { kind: 'stop' } | { kind: 'new' } | { kind: 'help' }
  | { kind: 'cd'; path: string }
  | { kind: 'model'; model: string | null }

export type ParseResult =
  | { ok: true; command: Command }
  | { ok: false; error: string }
  | { ok: false; notCommand: true }

const MOODS: Mood[] = ['calm', 'happy', 'thinking', 'confused', 'alarmed']
const EMOTES: EmoteKind[] = ['happy', 'thinking', 'confused', 'alarmed', 'look', 'hop']

export const HELP_TEXT = [
  '/goto <0-100|left|center|right>  walk there',
  '/run <target>                     run there',
  '/mood <calm|happy|thinking|confused|alarmed>',
  '/emote <happy|thinking|confused|alarmed|look|hop>',
  '/sleep  /wake  /stop  /new',
  '/cd <path>      change workspace (next session)',
  '/model [name]   set or clear the model (next session)',
  '/help',
].join('\n')

function parseTarget(arg: string | undefined): number | null {
  if (arg === undefined) return null
  if (arg === 'left') return 0
  if (arg === 'center') return 0.5
  if (arg === 'right') return 1
  if (!/^-?\d+(\.\d+)?$/.test(arg)) return null
  const n = Number(arg)
  return Math.min(1, Math.max(0, n / 100))
}

export function parseCommand(input: string): ParseResult {
  const text = input.trim()
  if (!text.startsWith('/')) return { ok: false, notCommand: true }
  const [rawWord, ...rest] = text.slice(1).split(/\s+/)
  const word = (rawWord ?? '').toLowerCase()
  const arg = rest.join(' ') || undefined
  switch (word) {
    case 'goto':
    case 'run': {
      const x = parseTarget(rest[0])
      if (x === null) return { ok: false, error: `usage: /${word} <0-100|left|center|right>` }
      return { ok: true, command: { kind: 'goto', x, run: word === 'run' } }
    }
    case 'mood': {
      const mood = rest[0] as Mood | undefined
      if (!mood || !MOODS.includes(mood)) return { ok: false, error: `unknown mood: ${rest[0] ?? ''}` }
      return { ok: true, command: { kind: 'mood', mood } }
    }
    case 'emote': {
      const emote = rest[0] as EmoteKind | undefined
      if (!emote || !EMOTES.includes(emote)) return { ok: false, error: `unknown emote: ${rest[0] ?? ''}` }
      return { ok: true, command: { kind: 'emote', emote } }
    }
    case 'sleep': case 'wake': case 'stop': case 'new': case 'help':
      return { ok: true, command: { kind: word } }
    case 'cd':
      if (!arg) return { ok: false, error: 'usage: /cd <path>' }
      return { ok: true, command: { kind: 'cd', path: arg } }
    case 'model':
      return { ok: true, command: { kind: 'model', model: arg ?? null } }
    default:
      return { ok: false, error: `unknown command: /${word} (try /help)` }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/commands.test.ts`
Expected: all 11 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/commands.ts src/main/commands.test.ts
git commit -m "feat: shared types and slash command parser

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Pack loader with schema validation and animation fallbacks

**Files:**
- Create: `src/main/pack.ts`, `src/main/pack.test.ts`, `test/fixtures/pack-min/manifest.json`, `test/fixtures/pack-min/persona.md`, `test/fixtures/pack-min/atlas.json`, `test/fixtures/pack-min/animations.json`, `test/fixtures/pack-min/atlas.png`

**Interfaces:**
- Consumes: `PackData`, `Animations`, `AnimationDef`, `Atlas`, `LineKey` from `src/shared/types.ts`.
- Produces:

```ts
export type LoadResult = { ok: true; pack: PackData } | { ok: false; errors: string[] }
export function loadPack(dir: string): LoadResult
export function pickLine(pack: PackData, key: LineKey, rng?: () => number): string | null
export const ANIMATION_KEYS: AnimationKey[]   // canonical order
```

Fallback rules (spec 4.3): `run` falls back to `walk` at 12 fps; `sleep` falls back to `sit`, which falls back to `idle`; every other missing key falls back to `idle`. Fallback copies frames but keeps the target key's default fps and loop. Default fps: idle 6, walk 8, run 12, others 8. Looping keys: idle, walk, run, sit, sleep, project, emote_thinking. A directional animation with only `right` gets `left = right` and `mirrorLeft = mirror ?? true`.

- [ ] **Step 1: Create the fixture pack**

`test/fixtures/pack-min/manifest.json`:

```json
{ "name": "Fixture", "packVersion": 1, "scale": 1,
  "theme": { "accent": "#fff", "glow": "#eee", "background": "#000", "text": "#fff", "font": "monospace", "glyph": "dot" },
  "persona": { "promptFile": "persona.md", "defaultMood": "calm",
               "lines": { "greeting": ["hi"], "wake": ["up"] } },
  "voice": null }
```

`test/fixtures/pack-min/persona.md`: one line, `You are a fixture.`

`test/fixtures/pack-min/atlas.json`:

```json
{ "image": "atlas.png", "maxFrameSize": [4, 4],
  "frames": { "a0": { "x": 0, "y": 0, "w": 2, "h": 2, "ax": 1, "ay": 2 },
              "a1": { "x": 2, "y": 0, "w": 2, "h": 2, "ax": 1, "ay": 2 },
              "w0": { "x": 0, "y": 2, "w": 2, "h": 2, "ax": 1, "ay": 2 },
              "s0": { "x": 2, "y": 2, "w": 2, "h": 2, "ax": 1, "ay": 2 } } }
```

`test/fixtures/pack-min/animations.json`:

```json
{ "idle": { "frames": ["a0", "a1"] },
  "walk": { "right": ["w0"] },
  "sit":  { "frames": ["s0"], "fps": 2 } }
```

Create `test/fixtures/pack-min/atlas.png` (any valid PNG; the loader only checks existence):

```bash
python -c "import base64;open('test/fixtures/pack-min/atlas.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='))"
```

- [ ] **Step 2: Write the failing tests**

`src/main/pack.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPack, pickLine } from './pack'

const FIXTURE = join(__dirname, '../../test/fixtures/pack-min')

function copyFixture(edit: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'))
  cpSync(FIXTURE, dir, { recursive: true })
  edit(dir)
  return dir
}

describe('loadPack', () => {
  it('loads the fixture and reads the persona prompt', () => {
    const r = loadPack(FIXTURE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pack.name).toBe('Fixture')
    expect(r.pack.persona.prompt.trim()).toBe('You are a fixture.')
    expect(r.pack.persona.lines.greeting).toEqual(['hi'])
    expect(r.pack.persona.lines.error).toEqual([])
  })
  it('resolves fallbacks', () => {
    const r = loadPack(FIXTURE)
    if (!r.ok) throw new Error(r.errors.join())
    const a = r.pack.animations
    expect(a.run.right).toEqual(['w0'])
    expect(a.run.fps).toBe(12)
    expect(a.run.loop).toBe(true)
    expect(a.sleep.right).toEqual(['s0'])          // sleep -> sit
    expect(a.emote_happy.right).toEqual(['a0', 'a1']) // -> idle
    expect(a.emote_happy.loop).toBe(false)
    expect(a.emote_thinking.loop).toBe(true)
    expect(a.idle.fps).toBe(6)
    expect(a.sit.fps).toBe(2)
  })
  it('mirrors a right-only walk', () => {
    const r = loadPack(FIXTURE)
    if (!r.ok) throw new Error(r.errors.join())
    expect(r.pack.animations.walk.left).toEqual(['w0'])
    expect(r.pack.animations.walk.mirrorLeft).toBe(true)
    expect(r.pack.animations.idle.mirrorLeft).toBe(false)
  })
  it('fails when idle is missing', () => {
    const dir = copyFixture(d => writeFileSync(join(d, 'animations.json'), JSON.stringify({ walk: { right: ['w0'] } })))
    const r = loadPack(dir)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join('\n')).toContain('missing required "idle"')
  })
  it('fails on an unknown frame name', () => {
    const dir = copyFixture(d => writeFileSync(join(d, 'animations.json'), JSON.stringify({ idle: { frames: ['nope'] }, walk: { right: ['w0'] } })))
    const r = loadPack(dir)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join('\n')).toContain('unknown frame "nope"')
  })
  it('fails on a missing manifest', () => {
    const r = loadPack(join(tmpdir(), 'does-not-exist-' + Date.now()))
    expect(r.ok).toBe(false)
  })
})

describe('pickLine', () => {
  it('returns null for an empty list and a member otherwise', () => {
    const r = loadPack(FIXTURE)
    if (!r.ok) throw new Error(r.errors.join())
    expect(pickLine(r.pack, 'error')).toBeNull()
    expect(pickLine(r.pack, 'greeting', () => 0)).toBe('hi')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/main/pack.test.ts`
Expected: FAIL, cannot find module './pack'.

- [ ] **Step 4: Implement `src/main/pack.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { AnimationDef, AnimationKey, Animations, LineKey, PackData } from '../shared/types'

export const ANIMATION_KEYS: AnimationKey[] = ['idle', 'walk', 'run', 'hop', 'fall', 'sit', 'sleep',
  'look', 'project', 'emote_happy', 'emote_thinking', 'emote_confused', 'emote_alarmed']
const LINE_KEYS: LineKey[] = ['greeting', 'idleMutter', 'thinking', 'toolRunning', 'permissionAsk',
  'permissionDenied', 'authError', 'cliMissing', 'error', 'sleep', 'wake', 'stopped']
const DEFAULT_FPS: Partial<Record<AnimationKey, number>> = { idle: 6, walk: 8, run: 12 }
const LOOPING = new Set<AnimationKey>(['idle', 'walk', 'run', 'sit', 'sleep', 'project', 'emote_thinking'])
const FALLBACK: Partial<Record<AnimationKey, AnimationKey>> = {
  run: 'walk', hop: 'idle', fall: 'idle', sit: 'idle', sleep: 'sit', look: 'idle', project: 'idle',
  emote_happy: 'idle', emote_thinking: 'idle', emote_confused: 'idle', emote_alarmed: 'idle',
}

const ThemeSchema = z.object({ accent: z.string(), glow: z.string(), background: z.string(),
  text: z.string(), font: z.string(), glyph: z.string() })
const ManifestSchema = z.object({
  name: z.string().min(1),
  packVersion: z.literal(1),
  scale: z.number().positive().default(1),
  theme: ThemeSchema,
  persona: z.object({
    promptFile: z.string().default('persona.md'),
    defaultMood: z.enum(['calm', 'happy', 'thinking', 'confused', 'alarmed']).default('calm'),
    lines: z.record(z.string(), z.array(z.string())).default({}),
  }),
  voice: z.unknown().nullable().default(null),
})
const FrameSchema = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().positive(),
  h: z.number().int().positive(), ax: z.number(), ay: z.number() })
const AtlasSchema = z.object({ image: z.string(),
  maxFrameSize: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  frames: z.record(z.string(), FrameSchema) })
const RawAnimSchema = z.object({ frames: z.array(z.string()).optional(), right: z.array(z.string()).optional(),
  left: z.array(z.string()).optional(), fps: z.number().positive().optional(),
  loop: z.boolean().optional(), mirror: z.boolean().optional() })
type RawAnim = z.infer<typeof RawAnimSchema>
const AnimationsSchema = z.record(z.string(), RawAnimSchema)

export type LoadResult = { ok: true; pack: PackData } | { ok: false; errors: string[] }

function readJson(path: string, errors: string[]): unknown {
  if (!existsSync(path)) { errors.push(`missing ${path}`); return null }
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (e) { errors.push(`invalid JSON in ${path}: ${(e as Error).message}`); return null }
}

function issues(prefix: string, err: z.ZodError): string[] {
  return err.issues.map(i => `${prefix}: ${i.path.join('.') || '(root)'} ${i.message}`)
}

export function resolveAnimations(raw: Record<string, RawAnim>, frameNames: Set<string>, errors: string[]): Animations | null {
  const out: Partial<Animations> = {}
  for (const key of Object.keys(raw)) {
    if (!ANIMATION_KEYS.includes(key as AnimationKey)) errors.push(`animations: unknown key "${key}"`)
  }
  for (const key of ANIMATION_KEYS) {
    const r = raw[key]
    if (!r) continue
    const right = r.frames ?? r.right
    if (!right || right.length === 0) { errors.push(`animations.${key}: needs "frames" or "right"`); continue }
    const left = r.frames ? right : (r.left ?? right)
    const mirrorLeft = r.frames ? false : (r.left ? false : (r.mirror ?? true))
    for (const f of new Set([...right, ...left])) {
      if (!frameNames.has(f)) errors.push(`animations.${key}: unknown frame "${f}"`)
    }
    out[key] = { right, left, fps: r.fps ?? DEFAULT_FPS[key] ?? 8, loop: r.loop ?? LOOPING.has(key), mirrorLeft }
  }
  for (const key of ['idle', 'walk'] as const) {
    if (!out[key]) errors.push(`animations: missing required "${key}"`)
  }
  for (const key of ANIMATION_KEYS) {
    if (out[key]) continue
    const fb = FALLBACK[key]
    const src = fb ? out[fb] : undefined
    if (!src) continue
    out[key] = { right: src.right, left: src.left, mirrorLeft: src.mirrorLeft,
      fps: DEFAULT_FPS[key] ?? 8, loop: LOOPING.has(key) }
  }
  if (errors.length) return null
  return out as Animations
}

export function loadPack(dir: string): LoadResult {
  const errors: string[] = []
  const root = resolve(dir)
  const manifestRaw = readJson(join(root, 'manifest.json'), errors)
  const atlasRaw = readJson(join(root, 'atlas.json'), errors)
  const animRaw = readJson(join(root, 'animations.json'), errors)
  if (errors.length) return { ok: false, errors }
  const m = ManifestSchema.safeParse(manifestRaw)
  const a = AtlasSchema.safeParse(atlasRaw)
  const an = AnimationsSchema.safeParse(animRaw)
  if (!m.success) errors.push(...issues('manifest.json', m.error))
  if (!a.success) errors.push(...issues('atlas.json', a.error))
  if (!an.success) errors.push(...issues('animations.json', an.error))
  if (!m.success || !a.success || !an.success) return { ok: false, errors }
  const promptPath = join(root, m.data.persona.promptFile)
  if (!existsSync(promptPath)) errors.push(`persona: missing ${m.data.persona.promptFile}`)
  if (!existsSync(join(root, a.data.image))) errors.push(`atlas: missing image ${a.data.image}`)
  const animations = resolveAnimations(an.data, new Set(Object.keys(a.data.frames)), errors)
  if (errors.length || !animations) return { ok: false, errors }
  const lines = Object.fromEntries(LINE_KEYS.map(k => [k, m.data.persona.lines[k] ?? []])) as Record<LineKey, string[]>
  return { ok: true, pack: {
    dir: root, name: m.data.name, scale: m.data.scale, theme: m.data.theme,
    persona: { prompt: readFileSync(promptPath, 'utf8'), defaultMood: m.data.persona.defaultMood, lines },
    atlas: a.data, animations,
  } }
}

export function pickLine(pack: PackData, key: LineKey, rng: () => number = Math.random): string | null {
  const list = pack.persona.lines[key]
  if (list.length === 0) return null
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))] ?? null
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/pack.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/pack.ts src/main/pack.test.ts test/fixtures/pack-min
git commit -m "feat: persona pack loader with animation fallbacks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The Buddy state machine (pure TypeScript)

**Files:**
- Create: `src/main/buddy.ts`, `src/main/buddy.test.ts`

**Interfaces:**
- Consumes: types and `WALK_SPEED`, `RUN_SPEED` from `src/shared/types.ts`.
- Produces:

```ts
export interface BuddyOptions {
  rng?: () => number                       // uniform [0,1), injectable for tests
  wanderIntervalMs?: [number, number]      // default [8000, 30000]
  restMs?: [number, number]                // default [5000, 20000]
  sleepAfterMs?: number                    // default 600000
  runThreshold?: number                    // default 0.25
  initialX?: number                        // default 0.5
  initialMood?: Mood                       // default 'calm'
}
export interface BuddyView { state: BuddyState; animation: AnimationKey; speed: number }
export class Buddy {
  constructor(opts?: BuddyOptions)
  onChange(listener: (view: BuddyView) => void): () => void   // fires only when the view changes
  onArrive(listener: () => void): () => void                   // fires on every arrival
  view(): BuddyView
  getState(): BuddyState
  tick(now: number): void      // ms clock; first call initializes timers
  arrived(): void              // renderer reached targetX
  oneShotDone(): void          // renderer finished a non-looping animation
  goTo(x: number, run?: boolean): void
  setMood(mood: Mood): void
  emote(kind: EmoteKind): void
  openPanel(): void
  closePanel(): void
  sleep(): void
  wake(): void
  interact(): void             // any user touch: wakes and resets the quiet timer
}
```

Rules implemented (spec section 8): wander only from `idle` with panel closed; distance under `runThreshold` walks, otherwise runs; on arrival after a wander, rest as idle, sitting, or looking for `restMs`; on arrival after a command, idle and reschedule; emotes interrupt idle, sitting, looking, queue behind walking and running, are dropped while projecting or asleep; `thinking` is the one animation change allowed while projecting; hop plays `hop` then `fall`; sleep after `sleepAfterMs` without interaction, only from a restful activity; `sleep()` is ignored while the panel is open.

- [ ] **Step 1: Write the failing tests**

`src/main/buddy.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Buddy } from './buddy'

function seq(values: number[]) {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}
// rng consumption order: tick#1 -> wander interval; wander -> target; arrival -> rest kind, rest length

describe('Buddy wander', () => {
  it('does nothing before the first wander time, then moves', () => {
    const b = new Buddy({ rng: seq([0, 0.9]), initialX: 0 })
    b.tick(0)
    b.tick(7999)
    expect(b.view().state.activity).toBe('idle')
    b.tick(8000)
    const v = b.view()
    expect(v.state.activity).toBe('running')
    expect(v.state.targetX).toBeCloseTo(0.9)
    expect(v.state.facing).toBe('right')
    expect(v.animation).toBe('run')
    expect(v.speed).toBe(0.25)
  })
  it('walks when the target is near', () => {
    const b = new Buddy({ rng: seq([0, 0.1]), initialX: 0 })
    b.tick(0); b.tick(8000)
    expect(b.view().state.activity).toBe('walking')
    expect(b.view().speed).toBe(0.08)
  })
  it('rests on arrival then wanders again', () => {
    const b = new Buddy({ rng: seq([0, 0.9, 0.5, 0, 0, 0.2]), initialX: 0 })
    b.tick(0); b.tick(8000)
    b.arrived()                       // rest kind 0.5 -> sitting, rest 0 -> 5000 ms
    expect(b.view().state.x).toBeCloseTo(0.9)
    expect(b.view().state.activity).toBe('sitting')
    expect(b.view().state.targetX).toBeUndefined()
    b.tick(12999)
    expect(b.view().state.activity).toBe('sitting')
    b.tick(13000)                     // rest over -> idle, next wander at +8000
    expect(b.view().state.activity).toBe('idle')
    b.tick(21000)
    expect(['walking', 'running']).toContain(b.view().state.activity)
  })
  it('does not wander while the panel is open, resumes after close', () => {
    const b = new Buddy({ rng: seq([0]), initialX: 0.5 })
    b.tick(0)
    b.openPanel()
    expect(b.view().state.activity).toBe('projecting')
    b.tick(60000)
    expect(b.view().state.activity).toBe('projecting')
    b.closePanel()
    expect(b.view().state.activity).toBe('idle')
    b.tick(68000)
    expect(['walking', 'running']).toContain(b.view().state.activity)
  })
})

describe('Buddy commands', () => {
  it('goTo clamps, faces, runs when asked, and idles on arrival', () => {
    const b = new Buddy({ rng: seq([0]), initialX: 0.5 })
    b.tick(0)
    b.goTo(1.7, true)
    expect(b.view().state.targetX).toBe(1)
    expect(b.view().state.activity).toBe('running')
    expect(b.view().state.facing).toBe('right')
    b.arrived()
    expect(b.view().state.activity).toBe('idle')
    expect(b.view().state.x).toBe(1)
  })
  it('goTo without run picks walk or run by distance', () => {
    const b = new Buddy({ rng: seq([0]), initialX: 0.5 })
    b.tick(0)
    b.goTo(0.4)
    expect(b.view().state.activity).toBe('walking')
    expect(b.view().state.facing).toBe('left')
    b.arrived()
    b.goTo(0.0)
    expect(b.view().state.activity).toBe('running')
  })
  it('fires arrive listeners', () => {
    const b = new Buddy({ rng: seq([0]) })
    let n = 0
    b.onArrive(() => n++)
    b.tick(0); b.goTo(0.1); b.arrived()
    expect(n).toBe(1)
  })
})

describe('Buddy emotes and moods', () => {
  it('plays a one-shot emote from idle and returns to idle', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0)
    b.emote('confused')
    expect(b.view().state.activity).toBe('emoting')
    expect(b.view().animation).toBe('emote_confused')
    b.oneShotDone()
    expect(b.view().state.activity).toBe('idle')
  })
  it('returns to sitting after an emote started while sitting', () => {
    const b = new Buddy({ rng: seq([0, 0.9, 0.5, 0]), initialX: 0 })
    b.tick(0); b.tick(8000); b.arrived()
    expect(b.view().state.activity).toBe('sitting')
    b.emote('happy')
    b.oneShotDone()
    expect(b.view().state.activity).toBe('sitting')
  })
  it('queues an emote behind movement', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.goTo(0.6)
    b.emote('alarmed')
    expect(b.view().state.activity).toBe('walking')
    b.arrived()
    expect(b.view().animation).toBe('emote_alarmed')
  })
  it('drops emotes while projecting but still changes mood', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.openPanel()
    b.emote('happy')
    expect(b.view().animation).toBe('project')
    b.setMood('happy')
    expect(b.view().state.mood).toBe('happy')
    expect(b.view().animation).toBe('project')
  })
  it('thinking replaces the project pose while projecting', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.openPanel()
    b.setMood('thinking')
    expect(b.view().animation).toBe('emote_thinking')
    b.setMood('calm')
    expect(b.view().animation).toBe('project')
  })
  it('thinking loops from idle until the mood changes', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0)
    b.setMood('thinking')
    expect(b.view().animation).toBe('emote_thinking')
    expect(b.view().state.activity).toBe('emoting')
    b.setMood('calm')
    expect(b.view().state.activity).toBe('idle')
  })
  it('hop plays hop then fall', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.emote('hop')
    expect(b.view().animation).toBe('hop')
    b.oneShotDone()
    expect(b.view().animation).toBe('fall')
    b.oneShotDone()
    expect(b.view().state.activity).toBe('idle')
  })
})

describe('Buddy sleep', () => {
  it('sleeps after the quiet period and wakes on interaction', () => {
    const b = new Buddy({ rng: seq([0]), wanderIntervalMs: [1e9, 1e9] })   // never wanders in this test
    b.tick(0)
    b.tick(599999)
    expect(b.view().state.asleep).toBe(false)
    b.tick(600000)
    expect(b.view().state.asleep).toBe(true)
    expect(b.view().animation).toBe('sleep')
    b.tick(700000)
    expect(b.view().state.activity).toBe('sleeping')
    b.interact()
    expect(b.view().state.asleep).toBe(false)
    expect(b.view().state.activity).toBe('idle')
  })
  it('sleep() is ignored while the panel is open, wake() restores idle', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.openPanel(); b.sleep()
    expect(b.view().state.asleep).toBe(false)
    b.closePanel(); b.sleep()
    expect(b.view().state.asleep).toBe(true)
    b.wake()
    expect(b.view().state.activity).toBe('idle')
  })
  it('emits change events only when the view changes', () => {
    const b = new Buddy({ rng: seq([0]) })
    let n = 0
    b.onChange(() => n++)
    b.tick(0); b.tick(100); b.tick(200)
    expect(n).toBe(0)
    b.goTo(0.9)
    expect(n).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/buddy.test.ts`
Expected: FAIL, cannot find module './buddy'.

- [ ] **Step 3: Implement `src/main/buddy.ts`**

```ts
import type { Activity, AnimationKey, BuddyState, EmoteKind, Facing, Mood } from '../shared/types'
import { RUN_SPEED, WALK_SPEED } from '../shared/types'

export interface BuddyOptions {
  rng?: () => number
  wanderIntervalMs?: [number, number]
  restMs?: [number, number]
  sleepAfterMs?: number
  runThreshold?: number
  initialX?: number
  initialMood?: Mood
}
export interface BuddyView { state: BuddyState; animation: AnimationKey; speed: number }

const RESTFUL: Activity[] = ['idle', 'sitting', 'looking']
const EMOTE_ANIM: Record<EmoteKind, AnimationKey> = {
  happy: 'emote_happy', thinking: 'emote_thinking', confused: 'emote_confused',
  alarmed: 'emote_alarmed', look: 'look', hop: 'hop',
}
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export class Buddy {
  private readonly rng: () => number
  private readonly wander: [number, number]
  private readonly rest: [number, number]
  private readonly sleepAfter: number
  private readonly runThreshold: number

  private x: number
  private facing: Facing = 'right'
  private activity: Activity = 'idle'
  private mood: Mood
  private panelOpen = false
  private asleep = false
  private targetX: number | undefined
  private commanded = false
  private now = 0
  private started = false
  private lastInteractionAt = 0
  private nextWanderAt = Infinity
  private restUntil: number | undefined
  private queuedEmote: EmoteKind | undefined
  private resumeActivity: Activity = 'idle'
  private currentEmote: AnimationKey = 'idle'
  private changeListeners: Array<(v: BuddyView) => void> = []
  private arriveListeners: Array<() => void> = []
  private lastViewKey = ''

  constructor(opts: BuddyOptions = {}) {
    this.rng = opts.rng ?? Math.random
    this.wander = opts.wanderIntervalMs ?? [8000, 30000]
    this.rest = opts.restMs ?? [5000, 20000]
    this.sleepAfter = opts.sleepAfterMs ?? 600000
    this.runThreshold = opts.runThreshold ?? 0.25
    this.x = clamp01(opts.initialX ?? 0.5)
    this.mood = opts.initialMood ?? 'calm'
    this.lastViewKey = JSON.stringify(this.view())
  }

  onChange(l: (v: BuddyView) => void): () => void {
    this.changeListeners.push(l)
    return () => { this.changeListeners = this.changeListeners.filter(x => x !== l) }
  }
  onArrive(l: () => void): () => void {
    this.arriveListeners.push(l)
    return () => { this.arriveListeners = this.arriveListeners.filter(x => x !== l) }
  }

  getState(): BuddyState {
    return { x: this.x, facing: this.facing, activity: this.activity, mood: this.mood,
      panelOpen: this.panelOpen, asleep: this.asleep, targetX: this.targetX }
  }
  view(): BuddyView {
    return { state: this.getState(), animation: this.animation(), speed: this.speed() }
  }

  private animation(): AnimationKey {
    switch (this.activity) {
      case 'sleeping': return 'sleep'
      case 'projecting': return this.mood === 'thinking' ? 'emote_thinking' : 'project'
      case 'walking': return 'walk'
      case 'running': return 'run'
      case 'sitting': return 'sit'
      case 'looking': return 'look'
      case 'hopping': return this.currentEmote
      case 'emoting': return this.currentEmote
      default: return 'idle'
    }
  }
  private speed(): number {
    return this.activity === 'walking' ? WALK_SPEED : this.activity === 'running' ? RUN_SPEED : 0
  }
  private rand(range: [number, number]): number {
    return range[0] + this.rng() * (range[1] - range[0])
  }
  private emit(): void {
    const v = this.view()
    const key = JSON.stringify(v)
    if (key === this.lastViewKey) return
    this.lastViewKey = key
    for (const l of this.changeListeners) l(v)
  }
  private scheduleWander(): void { this.nextWanderAt = this.now + this.rand(this.wander) }
  private startMove(target: number, run: boolean, commanded: boolean): void {
    this.targetX = clamp01(target)
    this.commanded = commanded
    this.restUntil = undefined
    if (Math.abs(this.targetX - this.x) < 0.001) { this.arrived(); return }
    this.facing = this.targetX > this.x ? 'right' : 'left'
    this.activity = run ? 'running' : 'walking'
  }

  tick(now: number): void {
    this.now = now
    if (!this.started) {
      this.started = true
      this.lastInteractionAt = now
      this.scheduleWander()
      return
    }
    if (this.asleep || this.panelOpen) return
    if (RESTFUL.includes(this.activity) && now - this.lastInteractionAt >= this.sleepAfter) {
      this.asleep = true
      this.activity = 'sleeping'
      this.restUntil = undefined
      this.emit()
      return
    }
    if ((this.activity === 'sitting' || this.activity === 'looking') && this.restUntil !== undefined && now >= this.restUntil) {
      this.activity = 'idle'
      this.restUntil = undefined
      this.scheduleWander()
      this.emit()
    }
    if (this.activity === 'idle' && now >= this.nextWanderAt) {
      let target = this.rng()
      if (Math.abs(target - this.x) < 0.05) target = clamp01(this.x < 0.5 ? this.x + 0.3 : this.x - 0.3)
      const run = Math.abs(target - this.x) >= this.runThreshold
      this.startMove(target, run, false)
      this.emit()
    }
  }

  arrived(): void {
    if (this.targetX !== undefined) this.x = this.targetX
    this.targetX = undefined
    const wasCommanded = this.commanded
    this.commanded = false
    if (this.panelOpen) {
      this.activity = 'projecting'
    } else if (this.queuedEmote) {
      const kind = this.queuedEmote
      this.queuedEmote = undefined
      this.activity = 'idle'
      this.resumeActivity = 'idle'
      this.beginEmote(kind)
    } else if (wasCommanded) {
      this.activity = 'idle'
      this.scheduleWander()
    } else {
      const pick = this.rng()
      const restLen = this.rand(this.rest)
      if (pick < 1 / 3) { this.activity = 'idle'; this.nextWanderAt = this.now + restLen }
      else if (pick < 2 / 3) { this.activity = 'sitting'; this.restUntil = this.now + restLen }
      else { this.activity = 'looking'; this.restUntil = this.now + restLen }
    }
    for (const l of this.arriveListeners) l()
    this.emit()
  }

  oneShotDone(): void {
    if (this.activity === 'hopping' && this.currentEmote === 'hop') {
      this.currentEmote = 'fall'
      this.emit()
      return
    }
    if (this.activity === 'hopping' || this.activity === 'emoting') {
      this.activity = this.resumeActivity
      if (this.activity === 'idle') this.scheduleWander()
      this.emit()
      return
    }
    if (this.activity === 'looking') {
      this.activity = 'idle'
      this.nextWanderAt = this.restUntil ?? this.now + this.rand(this.wander)
      this.restUntil = undefined
      this.emit()
    }
  }

  private beginEmote(kind: EmoteKind): void {
    if (!RESTFUL.includes(this.activity) && this.activity !== 'emoting' && this.activity !== 'hopping') return
    if (RESTFUL.includes(this.activity)) this.resumeActivity = this.activity
    this.currentEmote = EMOTE_ANIM[kind]
    this.activity = kind === 'hop' ? 'hopping' : kind === 'look' ? 'looking' : 'emoting'
  }

  emote(kind: EmoteKind): void {
    if (kind === 'thinking') { this.setMood('thinking'); return }
    if (this.asleep || this.activity === 'projecting') return
    if (this.activity === 'walking' || this.activity === 'running') { this.queuedEmote = kind; return }
    this.beginEmote(kind)
    this.emit()
  }

  setMood(mood: Mood): void {
    const prev = this.mood
    this.mood = mood
    if (mood === 'thinking' && prev !== 'thinking') {
      if (RESTFUL.includes(this.activity)) {
        this.resumeActivity = this.activity
        this.currentEmote = 'emote_thinking'
        this.activity = 'emoting'
      }
    } else if (mood !== 'thinking' && prev === 'thinking') {
      if (this.activity === 'emoting' && this.currentEmote === 'emote_thinking') {
        this.activity = this.resumeActivity
        if (this.activity === 'idle') this.scheduleWander()
      }
      if (mood === 'happy' || mood === 'confused' || mood === 'alarmed') this.emote(mood)
    } else if (mood === 'happy' || mood === 'confused' || mood === 'alarmed') {
      this.emote(mood)
    }
    this.emit()
  }

  goTo(x: number, run?: boolean): void {
    this.interact()
    this.queuedEmote = undefined
    const target = clamp01(x)
    const shouldRun = run ?? Math.abs(target - this.x) >= this.runThreshold
    this.startMove(target, shouldRun, true)
    this.emit()
  }

  openPanel(): void {
    this.interact()
    this.panelOpen = true
    this.queuedEmote = undefined
    if (this.activity !== 'walking' && this.activity !== 'running') this.activity = 'projecting'
    this.emit()
  }
  closePanel(): void {
    this.panelOpen = false
    this.lastInteractionAt = this.now
    if (this.activity === 'projecting') { this.activity = 'idle'; this.scheduleWander() }
    this.emit()
  }
  sleep(): void {
    if (this.panelOpen) return
    this.asleep = true
    this.activity = 'sleeping'
    this.targetX = undefined
    this.restUntil = undefined
    this.emit()
  }
  wake(): void {
    if (!this.asleep) return
    this.asleep = false
    this.activity = 'idle'
    this.lastInteractionAt = this.now
    this.scheduleWander()
    this.emit()
  }
  interact(): void {
    this.lastInteractionAt = this.now
    if (this.asleep) this.wake()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/buddy.test.ts`
Expected: 17 tests PASS. If the "rests on arrival" test fails on the rest kind, check the rng consumption order comment at the top of the test file against `arrived()`: rest kind is drawn before rest length.

- [ ] **Step 5: Commit**

```bash
git add src/main/buddy.ts src/main/buddy.test.ts
git commit -m "feat: buddy state machine with wander, rest, emotes, sleep

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Asset pipeline core (clean, upscale, slice, pack) with synthetic tests

**Files:**
- Create: `tools/requirements.txt`, `tools/clean.py`, `tools/upscale.py`, `tools/slice.py`, `tools/test_pipeline.py`

**Interfaces:**
- Produces (Python, used by Task 6 and by `test_pipeline.py`):

```python
# tools/clean.py
def clean_alpha(a: np.ndarray, threshold: int = 100, full: int = 230) -> np.ndarray
# tools/upscale.py
def upscale(src: str, dst: str, factor: int = 2, method: str = 'auto', exe: str | None = None) -> str  # returns method used
# tools/slice.py
@dataclass class Box: x0, y0, x1, y1 (x1, y1 exclusive); w, h, cx, cy properties; union(other)
def components(alpha: np.ndarray, thr: int = 128, min_px: int = 4) -> list[Box]
def group_frames(alpha: np.ndarray, band: dict, scale: float, overrides: dict) -> list[tuple[Box, float]]
      # returns (frame box in sheet coords, body center x in sheet coords) per frame, left to right
def normalize(rgba: np.ndarray, box: Box, body_cx: float) -> tuple[np.ndarray, int, int]   # crop, ax, ay
def pack_atlas(frames: list[tuple[str, np.ndarray, int, int]], max_width: int = 4096, pad: int = 2) -> tuple[np.ndarray, dict]
def build(sheet: str, rows: str, overrides: str, out_dir: str, scale: float) -> dict   # writes atlas.png, atlas.json, animations.draft.json; returns counts per band
```

`rows.json` format (coordinates at 1x; multiplied by `scale` when the sheet was upscaled):

```json
{ "bands": [ { "name": "idle", "x": [0, 760], "y": [38, 140], "count": 5 },
             { "name": "props", "x": [355, 1045], "y": [770, 960], "count": 0, "each": true } ] }
```

A band with `"each": true` turns every component into its own frame named `<band>_<i>`, with no fragment attachment and no count check. `overrides.json` format: `{ "<band>": { "merge": [[0, 1]], "drop": [3] } }` where indices refer to bodies in left-to-right order before merging.

- [ ] **Step 1: Write `tools/requirements.txt` and install**

```
Pillow>=10
numpy>=1.26
scipy>=1.11
pytest>=8
```

Run: `pip install -r tools/requirements.txt`

- [ ] **Step 2: Write the failing tests**

`tools/test_pipeline.py`:

```python
import json, os, sys
import numpy as np
import pytest
sys.path.insert(0, os.path.dirname(__file__))
from clean import clean_alpha
from slice import Box, components, group_frames, normalize, pack_atlas, build


def test_clean_alpha_thresholds_and_stretches():
    a = np.array([0, 20, 99, 100, 165, 230, 254, 255], dtype=np.uint8)
    out = clean_alpha(a, threshold=100, full=230)
    assert out.tolist() == [0, 0, 0, 0, 127, 255, 255, 255]
    assert out.dtype == np.uint8


def synthetic_sheet():
    """Two 20x70 bodies at x=10 and x=60 on the same baseline, a 6x6 fragment above the first,
    a wide 40x8 label-like fragment above the second (must be dropped)."""
    a = np.zeros((120, 120), dtype=np.uint8)
    a[40:110, 10:30] = 255
    a[40:110, 60:80] = 255
    a[20:26, 15:21] = 255      # fragment for body 0
    a[10:18, 55:95] = 255      # wide fragment: aspect 5, dropped
    return a


def test_components_finds_four_boxes():
    boxes = components(synthetic_sheet())
    assert len(boxes) == 4
    assert all(isinstance(b, Box) for b in boxes)


def test_group_frames_attaches_fragments_and_drops_labels():
    band = {"name": "t", "x": [0, 120], "y": [0, 120], "count": 2}
    frames = group_frames(synthetic_sheet(), band, 1.0, {})
    assert len(frames) == 2
    (box0, cx0), (box1, cx1) = frames
    assert box0.y0 == 20 and box0.y1 == 110 and box0.x0 == 10 and box0.x1 == 30
    assert cx0 == pytest.approx(20)
    assert box1.y0 == 40 and box1.x0 == 60 and box1.x1 == 80


def test_group_frames_count_mismatch_raises():
    band = {"name": "t", "x": [0, 120], "y": [0, 120], "count": 3}
    with pytest.raises(ValueError):
        group_frames(synthetic_sheet(), band, 1.0, {})


def test_group_frames_merge_override():
    band = {"name": "t", "x": [0, 120], "y": [0, 120], "count": 1}
    frames = group_frames(synthetic_sheet(), band, 1.0, {"t": {"merge": [[0, 1]]}})
    assert len(frames) == 1
    assert frames[0][0].x0 == 10 and frames[0][0].x1 == 80


def test_normalize_anchor_is_feet_center():
    a = synthetic_sheet()
    rgba = np.dstack([np.full_like(a, 200)] * 3 + [a])
    crop, ax, ay = normalize(rgba, Box(10, 20, 30, 110), 20.0)
    assert crop.shape == (90, 20, 4)
    assert ax == 10 and ay == 90


def test_pack_atlas_no_overlap_and_anchors():
    f1 = np.zeros((30, 20, 4), dtype=np.uint8); f1[..., 3] = 255
    f2 = np.zeros((50, 10, 4), dtype=np.uint8); f2[..., 3] = 255
    img, meta = pack_atlas([("a", f1, 10, 30), ("b", f2, 5, 50)], max_width=64, pad=2)
    fa, fb = meta["frames"]["a"], meta["frames"]["b"]
    assert fa["ax"] == 10 and fa["ay"] == 30 and fb["ax"] == 5 and fb["ay"] == 50
    ra = (fa["x"], fa["y"], fa["x"] + fa["w"], fa["y"] + fa["h"])
    rb = (fb["x"], fb["y"], fb["x"] + fb["w"], fb["y"] + fb["h"])
    assert ra[2] <= rb[0] or rb[2] <= ra[0] or ra[3] <= rb[1] or rb[3] <= ra[1]
    assert meta["maxFrameSize"] == [20, 50]
    assert img.shape[1] <= 64


def test_build_on_synthetic(tmp_path):
    from PIL import Image
    a = synthetic_sheet()
    rgba = np.dstack([np.full_like(a, 200)] * 3 + [a])
    sheet = tmp_path / "sheet.png"; Image.fromarray(rgba).save(sheet)
    rows = tmp_path / "rows.json"
    rows.write_text(json.dumps({"bands": [{"name": "idle", "x": [0, 120], "y": [0, 120], "count": 2}]}))
    ov = tmp_path / "ov.json"; ov.write_text("{}")
    out = tmp_path / "out"
    counts = build(str(sheet), str(rows), str(ov), str(out), 1.0)
    assert counts == {"idle": 2}
    atlas = json.loads((out / "atlas.json").read_text())
    assert set(atlas["frames"]) == {"idle_0", "idle_1"}
    draft = json.loads((out / "animations.draft.json").read_text())
    assert draft["idle"] == {"frames": ["idle_0", "idle_1"]}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `python -m pytest tools/test_pipeline.py -q`
Expected: ImportError on `clean` / `slice`.

- [ ] **Step 4: Write `tools/clean.py`**

```python
"""Remove the soft haze matte: alpha below threshold becomes 0, alpha at or above `full` becomes 255."""
import argparse
import numpy as np
from PIL import Image


def clean_alpha(a: np.ndarray, threshold: int = 100, full: int = 230) -> np.ndarray:
    a = a.astype(np.int32)
    stretched = np.clip((a - threshold) * 255 // (full - threshold), 0, 255)
    return np.where(a < threshold, 0, stretched).astype(np.uint8)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--threshold", type=int, default=100)
    p.add_argument("--full", type=int, default=230)
    args = p.parse_args()
    arr = np.array(Image.open(args.src).convert("RGBA"))
    arr[..., 3] = clean_alpha(arr[..., 3], args.threshold, args.full)
    Image.fromarray(arr).save(args.dst)
    print(f"wrote {args.dst} {arr.shape[1]}x{arr.shape[0]}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Write `tools/upscale.py`**

```python
"""2x upscale. Uses realesrgan-ncnn-vulkan when available (no PyTorch needed), else Lanczos."""
import argparse, os, shutil, subprocess
from PIL import Image


def find_esrgan(explicit: str | None) -> str | None:
    for cand in [explicit, os.environ.get("REALESRGAN"), shutil.which("realesrgan-ncnn-vulkan")]:
        if cand and os.path.isfile(cand):
            return cand
    return None


def upscale(src: str, dst: str, factor: int = 2, method: str = "auto", exe: str | None = None) -> str:
    found = find_esrgan(exe) if method in ("auto", "esrgan") else None
    if method == "esrgan" and not found:
        raise FileNotFoundError("realesrgan-ncnn-vulkan not found; pass --exe or set REALESRGAN")
    if found:
        subprocess.run([found, "-i", src, "-o", dst, "-n", "realesr-animevideov3", "-s", str(factor)], check=True)
        return "esrgan"
    im = Image.open(src).convert("RGBA")
    im.resize((im.width * factor, im.height * factor), Image.LANCZOS).save(dst)
    return "lanczos"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--factor", type=int, default=2)
    p.add_argument("--method", choices=["auto", "esrgan", "lanczos"], default="auto")
    p.add_argument("--exe")
    a = p.parse_args()
    print("method:", upscale(a.src, a.dst, a.factor, a.method, a.exe))


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Write `tools/slice.py`**

```python
"""Slice a labeled sprite sheet into an atlas using rows.json bands."""
import argparse, json, os
from dataclasses import dataclass
import numpy as np
from PIL import Image
from scipy import ndimage

MIN_BODY_H_1X = 60
MAX_DX_1X = 90
MAX_FRAGMENT_ASPECT = 3.0


@dataclass
class Box:
    x0: int; y0: int; x1: int; y1: int
    @property
    def w(self): return self.x1 - self.x0
    @property
    def h(self): return self.y1 - self.y0
    @property
    def cx(self): return (self.x0 + self.x1) / 2
    @property
    def cy(self): return (self.y0 + self.y1) / 2
    def union(self, o: "Box") -> "Box":
        return Box(min(self.x0, o.x0), min(self.y0, o.y0), max(self.x1, o.x1), max(self.y1, o.y1))
    def shifted(self, dx: int, dy: int) -> "Box":
        return Box(self.x0 + dx, self.y0 + dy, self.x1 + dx, self.y1 + dy)


def components(alpha: np.ndarray, thr: int = 128, min_px: int = 4) -> list[Box]:
    labels, n = ndimage.label(alpha > thr)
    out = []
    for sl in ndimage.find_objects(labels):
        if sl is None:
            continue
        ys, xs = sl
        if (ys.stop - ys.start) * (xs.stop - xs.start) < min_px:
            continue
        out.append(Box(xs.start, ys.start, xs.stop, ys.stop))
    return out


def group_frames(alpha: np.ndarray, band: dict, scale: float, overrides: dict) -> list[tuple[Box, float]]:
    x0, x1 = (int(round(v * scale)) for v in band["x"])
    y0, y1 = (int(round(v * scale)) for v in band["y"])
    sub = alpha[y0:y1, x0:x1]
    boxes = [b.shifted(x0, y0) for b in components(sub)]
    if band.get("each"):
        boxes.sort(key=lambda b: (b.x0, b.y0))
        return [(b, b.cx) for b in boxes]
    min_body_h = MIN_BODY_H_1X * scale
    max_dx = MAX_DX_1X * scale
    bodies = sorted([b for b in boxes if b.h >= min_body_h], key=lambda b: b.cx)
    fragments = [b for b in boxes if b.h < min_body_h and b.w / max(b.h, 1) <= MAX_FRAGMENT_ASPECT]
    ov = overrides.get(band["name"], {})
    keep = [i for i in range(len(bodies)) if i not in set(ov.get("drop", []))]
    groups: list[list[int]] = [[i] for i in keep]
    for merge in ov.get("merge", []):
        merged = [g for g in groups if any(i in merge for i in g)]
        rest = [g for g in groups if g not in merged]
        groups = rest + [sorted(sum(merged, []))]
    groups.sort(key=lambda g: min(bodies[i].cx for i in g))
    frames = []
    for g in groups:
        box = bodies[g[0]]
        for i in g[1:]:
            box = box.union(bodies[i])
        body_cx = sum(bodies[i].cx for i in g) / len(g)
        frames.append([box, body_cx])
    for f in fragments:
        if not frames:
            break
        j = min(range(len(frames)), key=lambda k: abs(frames[k][1] - f.cx))
        if abs(frames[j][1] - f.cx) <= max_dx:
            frames[j][0] = frames[j][0].union(f)
    expected = band["count"]
    if len(frames) != expected:
        raise ValueError(f"band {band['name']}: found {len(frames)} frames, expected {expected}")
    return [(b, cx) for b, cx in frames]


def normalize(rgba: np.ndarray, box: Box, body_cx: float) -> tuple[np.ndarray, int, int]:
    crop = rgba[box.y0:box.y1, box.x0:box.x1].copy()
    rows = np.where(crop[..., 3] > 0)[0]
    ay = int(rows.max()) + 1 if rows.size else crop.shape[0]
    ax = int(round(body_cx - box.x0))
    return crop, ax, ay


def pack_atlas(frames: list[tuple[str, np.ndarray, int, int]], max_width: int = 4096, pad: int = 2) -> tuple[np.ndarray, dict]:
    order = sorted(frames, key=lambda f: -f[1].shape[0])
    placements, x, y, shelf_h, width = {}, pad, pad, 0, 0
    for name, img, ax, ay in order:
        h, w = img.shape[:2]
        if x + w + pad > max_width:
            x, y, shelf_h = pad, y + shelf_h + pad, 0
        placements[name] = (x, y)
        x += w + pad
        shelf_h = max(shelf_h, h)
        width = max(width, x)
    height = y + shelf_h + pad
    atlas = np.zeros((height, width, 4), dtype=np.uint8)
    meta = {"image": "atlas.png", "maxFrameSize": [0, 0], "frames": {}}
    for name, img, ax, ay in frames:
        px, py = placements[name]
        h, w = img.shape[:2]
        atlas[py:py + h, px:px + w] = img
        meta["frames"][name] = {"x": px, "y": py, "w": w, "h": h, "ax": ax, "ay": ay}
        meta["maxFrameSize"] = [max(meta["maxFrameSize"][0], w), max(meta["maxFrameSize"][1], h)]
    return atlas, meta


DIRECTIONAL = {"walk": ("walk_right", "walk_left"), "run": ("run_right", "run_left")}


def draft_animations(names_by_band: dict[str, list[str]]) -> dict:
    draft = {}
    used = set()
    for key, (r, l) in DIRECTIONAL.items():
        if r in names_by_band and l in names_by_band:
            draft[key] = {"right": names_by_band[r], "left": names_by_band[l]}
            used.update({r, l})
    for band, names in names_by_band.items():
        if band not in used and band != "props":
            draft[band] = {"frames": names}
    return draft


def build(sheet: str, rows: str, overrides: str, out_dir: str, scale: float) -> dict:
    rgba = np.array(Image.open(sheet).convert("RGBA"))
    alpha = rgba[..., 3]
    bands = json.load(open(rows))["bands"]
    ov = json.load(open(overrides)) if os.path.exists(overrides) else {}
    os.makedirs(out_dir, exist_ok=True)
    all_frames, names_by_band, counts = [], {}, {}
    for band in bands:
        frames = group_frames(alpha, band, scale, ov)
        names = []
        for i, (box, cx) in enumerate(frames):
            name = f"{band['name']}_{i}"
            crop, ax, ay = normalize(rgba, box, cx)
            all_frames.append((name, crop, ax, ay))
            names.append(name)
        names_by_band[band["name"]] = names
        counts[band["name"]] = len(names)
    atlas, meta = pack_atlas(all_frames)
    Image.fromarray(atlas).save(os.path.join(out_dir, "atlas.png"))
    json.dump(meta, open(os.path.join(out_dir, "atlas.json"), "w"), indent=1)
    json.dump(draft_animations(names_by_band), open(os.path.join(out_dir, "animations.draft.json"), "w"), indent=1)
    return counts


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("sheet"); p.add_argument("out_dir")
    p.add_argument("--rows", default=os.path.join(os.path.dirname(__file__), "rows.json"))
    p.add_argument("--overrides", default=os.path.join(os.path.dirname(__file__), "overrides.json"))
    p.add_argument("--scale", type=float, default=1.0)
    a = p.parse_args()
    for band, n in build(a.sheet, a.rows, a.overrides, a.out_dir, a.scale).items():
        print(f"{band}: {n}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `python -m pytest tools/test_pipeline.py -q`
Expected: 8 passed.

- [ ] **Step 8: Commit**

```bash
git add tools/requirements.txt tools/clean.py tools/upscale.py tools/slice.py tools/test_pipeline.py
git commit -m "feat: sprite sheet pipeline core with synthetic tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Key the real sheet, extend the pipeline for one-direction bands, and author the Mechanicus pack

**Files:**
- Create: `tools/key.py`, `tools/rows.json`, `tools/overrides.json`, `tools/debug_render.py`, `packs/mechanicus/manifest.json`, `packs/mechanicus/persona.md`, `packs/mechanicus/animations.json`, `packs/mechanicus/atlas.png`, `packs/mechanicus/atlas.json`, `src/main/pack.mechanicus.test.ts`
- Modify: `tools/slice.py` (flip support for one-direction bands), `tools/upscale.py` (nearest-neighbor method), `tools/test_pipeline.py` (append tests)

**Interfaces:**
- Consumes: `tools/slice.py` (`group_frames`, `normalize`, `pack_atlas`, `build`, `draft_animations`), `tools/upscale.py` from Task 5; `loadPack` from Task 3.
- Produces: a valid pack at `packs/mechanicus` that `loadPack` accepts with every vocabulary key mapped, and these pipeline additions:

```python
# tools/key.py
def key_background(rgb: np.ndarray, tolerance: int = 36, inset: int = 4) -> np.ndarray   # returns alpha uint8
# tools/slice.py additions
#   band option "facing": "left" | "right": the band's frames are named <name>_<facing>_<i> and the
#   pipeline also emits horizontally flipped copies named <name>_<other>_<i> with ax mirrored (w - ax).
#   draft_animations pairs <name>_right and <name>_left into a directional entry as before.
# tools/upscale.py addition
#   method "nearest": integer upscale with Image.NEAREST (for pixel art). "auto" prefers esrgan, then nearest.
```

The real sheet (`raw/sheet.png`, 1536 by 1024, RGB) has a one-pixel black frame around a uniform dark gray background, about (50, 48, 46), with figures drawn in a chunky pixel-art style. There is no alpha channel, so the old alpha threshold does not apply. Keying is a flood fill: pixels within `tolerance` (sum of absolute RGB differences) of the background color sampled on a ring `inset` pixels inside the frame, connected to the border, become transparent; everything else stays opaque. Measured on the real sheet at tolerance 36: about 65 percent background, roughly 60 foreground pieces larger than 2000 pixels, no holes inside figures.

The sheet's row layout (labels in caps above each group, all figures facing the viewer except walk and run, which face left):

| Band | Approx x range at 1x | Approx y range | Count | Notes |
|---|---|---|---|---|
| turnaround | 20 to 630 | 40 to 200 | 5 | front, 3/4 front, side, 3/4 back, back |
| idle | 650 to 970 | 40 to 200 | 3 | |
| sit | 980 to 1260 | 40 to 200 | 2 | |
| sleep | 1270 to 1520 | 40 to 200 | 1 | |
| walk | 20 to 335 | 238 to 400 | 3 | facing left |
| run | 340 to 645 | 238 to 400 | 3 | facing left |
| jump | 650 to 995 | 238 to 400 | 2 | jump with jets, land with dust |
| interact | 1000 to 1530 | 238 to 400 | 4 | magnifier, reading, "?", "!" with laptop |
| usetech | 20 to 480 | 432 to 605 | 3 | laptop, floating holo tablet, laptop |
| celebrate | 490 to 865 | 432 to 605 | 3 | hearts and sparkles above |
| alert | 870 to 1175 | 432 to 605 | 2 | "!" and "!!" above |
| hover | 1180 to 1530 | 432 to 605 | 2 | jets below |
| hide | 20 to 265 | 632 to 835 | 2 | door plus figure per frame: two bodies each, merged by overrides |
| damage | 275 to 725 | 632 to 835 | 3 | smoke above |
| faces | 740 to 1165 | 632 to 835 | 8 | face close-ups, two rows of four; `"each": true` |
| props | 1170 to 1530 | 632 to 835 | 0 | `"each": true` |

Everything below y 840 is the footer (logo, palette, mottos) and is not banded.

- [ ] **Step 1: Write the failing tests for keying, flipping, and nearest upscale**

Append to `tools/test_pipeline.py`:

```python
from key import key_background
from upscale import upscale


def test_key_background_removes_connected_background_only():
    # 60x60 RGB: 1px black frame, gray interior, a red 20x20 block in the middle,
    # and a gray 4x4 "hole" inside the block that must stay opaque.
    im = np.full((60, 60, 3), (50, 48, 46), dtype=np.uint8)
    im[0, :] = im[-1, :] = im[:, 0] = im[:, -1] = (4, 3, 3)
    im[20:40, 20:40] = (180, 30, 30)
    im[28:32, 28:32] = (50, 48, 46)
    alpha = key_background(im, tolerance=36, inset=4)
    assert alpha.dtype == np.uint8 and alpha.shape == (60, 60)
    assert alpha[5, 5] == 0 and alpha[0, 0] == 0
    assert alpha[25, 25] == 255
    assert alpha[30, 30] == 255          # enclosed gray is not connected to the border


def test_key_background_tolerance_bounds():
    im = np.full((20, 20, 3), (50, 48, 46), dtype=np.uint8)
    im[8:12, 8:12] = (70, 48, 46)        # differs by 20: background at tolerance 36, foreground at 10
    assert key_background(im, tolerance=36, inset=2)[10, 10] == 0
    assert key_background(im, tolerance=10, inset=2)[10, 10] == 255


def test_facing_band_emits_flipped_frames(tmp_path):
    from PIL import Image
    a = synthetic_sheet()
    rgba = np.dstack([np.full_like(a, 200)] * 3 + [a])
    rgba[40:110, 10:15, 0] = 255         # a red stripe on the left edge of body 0 to detect flipping
    sheet = tmp_path / "sheet.png"; Image.fromarray(rgba).save(sheet)
    rows = tmp_path / "rows.json"
    rows.write_text(json.dumps({"bands": [{"name": "walk", "x": [0, 120], "y": [0, 120], "count": 2, "facing": "left"}]}))
    ov = tmp_path / "ov.json"; ov.write_text("{}")
    out = tmp_path / "out"
    counts = build(str(sheet), str(rows), str(ov), str(out), 1.0)
    assert counts == {"walk": 2}
    atlas = json.loads((out / "atlas.json").read_text())
    assert set(atlas["frames"]) == {"walk_left_0", "walk_left_1", "walk_right_0", "walk_right_1"}
    l, r = atlas["frames"]["walk_left_0"], atlas["frames"]["walk_right_0"]
    assert (l["w"], l["h"], l["ay"]) == (r["w"], r["h"], r["ay"])
    assert r["ax"] == l["w"] - l["ax"]
    img = np.array(Image.open(out / "atlas.png"))
    left_px = img[l["y"] + l["h"] - 1, l["x"] + 2]
    right_px = img[r["y"] + r["h"] - 1, r["x"] + r["w"] - 3]
    assert left_px[0] == 255 and right_px[0] == 255      # the red stripe moved to the other side
    draft = json.loads((out / "animations.draft.json").read_text())
    assert draft["walk"] == {"right": ["walk_right_0", "walk_right_1"], "left": ["walk_left_0", "walk_left_1"]}


def test_upscale_nearest_doubles_size(tmp_path):
    from PIL import Image
    src = tmp_path / "s.png"; dst = tmp_path / "d.png"
    Image.fromarray(np.zeros((3, 5, 4), dtype=np.uint8)).save(src)
    assert upscale(str(src), str(dst), 2, "nearest") == "nearest"
    assert Image.open(dst).size == (10, 6)
```

Run: `python -m pytest tools/test_pipeline.py -q`
Expected: the four new tests fail (ImportError for `key`, KeyError or assertion for the flip test, ValueError for the nearest method).

- [ ] **Step 2: Write `tools/key.py`**

```python
"""Turn a solid-background RGB sheet into RGBA by flood-filling the background from the border."""
import argparse
import numpy as np
from PIL import Image
from scipy import ndimage


def key_background(rgb: np.ndarray, tolerance: int = 36, inset: int = 4) -> np.ndarray:
    im = rgb[..., :3].astype(int)
    h, w = im.shape[:2]
    i = min(inset, h // 2 - 1, w // 2 - 1)
    ring = np.concatenate([im[i, i:w - i], im[h - 1 - i, i:w - i], im[i:h - i, i], im[i:h - i, w - 1 - i]])
    bg = np.median(ring, axis=0)
    near = np.abs(im - bg).sum(-1) <= tolerance
    near[:i, :] = near[h - i:, :] = near[:, :i] = near[:, w - i:] = True
    labels, _ = ndimage.label(near)
    edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    background = np.isin(labels, edge[edge != 0])
    return np.where(background, 0, 255).astype(np.uint8)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--tolerance", type=int, default=36)
    p.add_argument("--inset", type=int, default=4)
    a = p.parse_args()
    rgb = np.array(Image.open(a.src).convert("RGB"))
    alpha = key_background(rgb, a.tolerance, a.inset)
    Image.fromarray(np.dstack([rgb, alpha])).save(a.dst)
    print(f"wrote {a.dst}: background {100 * (alpha == 0).mean():.1f}%")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Add nearest to `tools/upscale.py`**

In `upscale()`, change the signature's `method` choices to include `"nearest"` and replace the final two lines with:

```python
    im = Image.open(src).convert("RGBA")
    resample = Image.NEAREST if method == "nearest" else Image.LANCZOS
    im.resize((im.width * factor, im.height * factor), resample).save(dst)
    return "nearest" if method == "nearest" else "lanczos"
```

and make `"auto"` fall through to nearest instead of Lanczos (`resample = Image.NEAREST if method in ("nearest", "auto") else Image.LANCZOS`, returning `"nearest"` in that case). Add `"nearest"` to the argparse `choices`.

- [ ] **Step 4: Add facing support to `tools/slice.py`**

In `build()`, replace the per-band loop body so that a band with `"facing"` emits both directions:

```python
    for band in bands:
        frames = group_frames(alpha, band, scale, ov)
        facing = band.get("facing")
        other = {"left": "right", "right": "left"}.get(facing)
        names = []
        for i, (box, cx) in enumerate(frames):
            crop, ax, ay = normalize(rgba, box, cx)
            if facing:
                own = f"{band['name']}_{facing}_{i}"
                flipped = f"{band['name']}_{other}_{i}"
                all_frames.append((own, crop, ax, ay))
                all_frames.append((flipped, crop[:, ::-1].copy(), crop.shape[1] - ax, ay))
                names_by_band.setdefault(f"{band['name']}_{facing}", []).append(own)
                names_by_band.setdefault(f"{band['name']}_{other}", []).append(flipped)
            else:
                name = f"{band['name']}_{i}"
                all_frames.append((name, crop, ax, ay))
                names.append(name)
        if not facing:
            names_by_band[band["name"]] = names
        counts[band["name"]] = len(frames)
```

`draft_animations` already pairs `walk_right` with `walk_left` and `run_right` with `run_left`; no change there.

Run: `python -m pytest tools/test_pipeline.py -q`
Expected: 14 passed, no warnings.

- [ ] **Step 5: Write `tools/rows.json`** (coordinates at 1x from the table above; tuned in step 7)

```json
{ "bands": [
  { "name": "turnaround", "x": [20, 630],   "y": [40, 200],  "count": 5 },
  { "name": "idle",       "x": [650, 970],  "y": [40, 200],  "count": 3 },
  { "name": "sit",        "x": [980, 1260], "y": [40, 200],  "count": 2 },
  { "name": "sleep",      "x": [1270, 1520],"y": [40, 200],  "count": 1 },
  { "name": "walk",       "x": [20, 335],   "y": [238, 400], "count": 3, "facing": "left" },
  { "name": "run",        "x": [340, 645],  "y": [238, 400], "count": 3, "facing": "left" },
  { "name": "jump",       "x": [650, 995],  "y": [238, 400], "count": 2 },
  { "name": "interact",   "x": [1000, 1530],"y": [238, 400], "count": 4 },
  { "name": "usetech",    "x": [20, 480],   "y": [432, 605], "count": 3 },
  { "name": "celebrate",  "x": [490, 865],  "y": [432, 605], "count": 3 },
  { "name": "alert",      "x": [870, 1175], "y": [432, 605], "count": 2 },
  { "name": "hover",      "x": [1180, 1530],"y": [432, 605], "count": 2 },
  { "name": "hide",       "x": [20, 265],   "y": [632, 835], "count": 2 },
  { "name": "damage",     "x": [275, 725],  "y": [632, 835], "count": 3 },
  { "name": "faces",      "x": [740, 1165], "y": [632, 835], "count": 0, "each": true },
  { "name": "props",      "x": [1170, 1530],"y": [632, 835], "count": 0, "each": true }
] }
```

`tools/overrides.json` starting point (the hide frames are a door plus a figure, two bodies each):

```json
{ "hide": { "merge": [[0, 1], [2, 3]] } }
```

- [ ] **Step 6: Write `tools/debug_render.py`**

```python
"""Draw band rectangles, frame boxes, and anchors over the keyed sheet for eyeballing rows.json."""
import argparse, json, os, sys
from PIL import Image, ImageDraw
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from slice import group_frames, normalize


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("sheet"); p.add_argument("out")
    p.add_argument("--rows", default=os.path.join(os.path.dirname(__file__), "rows.json"))
    p.add_argument("--overrides", default=os.path.join(os.path.dirname(__file__), "overrides.json"))
    p.add_argument("--scale", type=float, default=1.0)
    a = p.parse_args()
    im = Image.open(a.sheet).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 0, 255, 255)); bg.alpha_composite(im)
    draw = ImageDraw.Draw(bg)
    rgba = np.array(im); alpha = rgba[..., 3]
    ov = json.load(open(a.overrides)) if os.path.exists(a.overrides) else {}
    for band in json.load(open(a.rows))["bands"]:
        x0, x1 = (v * a.scale for v in band["x"]); y0, y1 = (v * a.scale for v in band["y"])
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(80, 140, 255, 255))
        draw.text((x0 + 3, y0 + 2), band["name"], fill=(80, 140, 255, 255))
        try:
            frames = group_frames(alpha, band, a.scale, ov)
        except ValueError as e:
            draw.text((x0 + 3, y0 + 14), str(e), fill=(255, 60, 60, 255))
            print("!!", e)
            continue
        for i, (box, cx) in enumerate(frames):
            draw.rectangle([box.x0, box.y0, box.x1 - 1, box.y1 - 1], outline=(60, 220, 90, 255))
            _, ax, ay = normalize(rgba, box, cx)
            draw.ellipse([box.x0 + ax - 2, box.y0 + ay - 2, box.x0 + ax + 2, box.y0 + ay + 2], fill=(255, 255, 0, 255))
            draw.text((box.x0 + 2, box.y1 - 12), f"{band['name']}_{i}", fill=(60, 220, 90, 255))
        print(f"{band['name']}: {len(frames)}")
    bg.save(a.out)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
```

- [ ] **Step 7: Key the real sheet and tune the bands**

```bash
python tools/key.py raw/sheet.png build/keyed.png
python tools/debug_render.py build/keyed.png build/debug.png
```

Open `build/debug.png` (the Read tool renders it). Every band must print its expected count with no `!!` lines, except `faces` and `props`, which print whatever they find (`faces` should be 8). Each green box must contain one figure plus its skull and effect fragments; yellow dots sit at the feet. Adjust `rows.json` and `overrides.json` and repeat until clean. Typical fixes: a band top clipping a label (raise it), a skull attached to a neighbor (adjust the band `x`), a two-body frame (add a merge). Then record the final numbers in your report.

- [ ] **Step 8: Append the real-sheet test to `tools/test_pipeline.py`**

```python
RAW = os.path.join(os.path.dirname(__file__), "..", "raw", "sheet.png")


@pytest.mark.skipif(not os.path.exists(RAW), reason="raw sheet not present")
def test_real_sheet_bands_match_rows(tmp_path):
    from PIL import Image
    rgb = np.array(Image.open(RAW).convert("RGB"))
    alpha = key_background(rgb)
    keyed = tmp_path / "keyed.png"; Image.fromarray(np.dstack([rgb, alpha])).save(keyed)
    rows_path = os.path.join(os.path.dirname(__file__), "rows.json")
    ov_path = os.path.join(os.path.dirname(__file__), "overrides.json")
    counts = build(str(keyed), rows_path, ov_path, str(tmp_path / "out"), 1.0)
    expected = {b["name"]: b["count"] for b in json.load(open(rows_path))["bands"] if not b.get("each")}
    assert {k: counts[k] for k in expected} == expected
    assert counts["faces"] == 8
    atlas = json.loads((tmp_path / "out" / "atlas.json").read_text())
    for name, f in atlas["frames"].items():
        assert 0 < f["ay"] <= f["h"] and 0 <= f["ax"] <= f["w"], name
    assert "walk_right_0" in atlas["frames"] and "run_left_2" in atlas["frames"]
```

Run: `python -m pytest tools/test_pipeline.py -q`
Expected: 15 passed.

- [ ] **Step 9: Build the 2x atlas**

```bash
python tools/upscale.py build/keyed.png build/keyed@2x.png --method nearest
python tools/slice.py build/keyed@2x.png build/pack --scale 2
```

Nearest-neighbor keeps the pixel-art edges crisp; do not use Lanczos or ESRGAN on this sheet. Look at `build/pack/atlas.png` once.

- [ ] **Step 10: Create the pack files**

```bash
mkdir -p packs/mechanicus
cp build/pack/atlas.png build/pack/atlas.json packs/mechanicus/
```

`packs/mechanicus/manifest.json`: the exact JSON from spec section 4.1, with `"scale": 1.0`.

`packs/mechanicus/persona.md`: the exact text from spec section 4.2, as plain paragraphs (no `>` quoting).

`packs/mechanicus/animations.json`:

```json
{
  "idle":           { "frames": ["idle_0", "idle_1", "idle_2"], "fps": 4 },
  "walk":           { "right": ["walk_right_0", "walk_right_1", "walk_right_2"],
                      "left":  ["walk_left_0", "walk_left_1", "walk_left_2"], "fps": 8 },
  "run":            { "right": ["run_right_0", "run_right_1", "run_right_2"],
                      "left":  ["run_left_0", "run_left_1", "run_left_2"], "fps": 12 },
  "hop":            { "frames": ["jump_0"], "fps": 4 },
  "fall":           { "frames": ["jump_1"], "fps": 4 },
  "sit":            { "frames": ["sit_0", "sit_1"], "fps": 2 },
  "sleep":          { "frames": ["sleep_0"], "fps": 1 },
  "look":           { "frames": ["interact_0", "interact_1"], "fps": 3 },
  "project":        { "frames": ["usetech_1"], "fps": 1 },
  "emote_happy":    { "frames": ["celebrate_0", "celebrate_1", "celebrate_2"], "fps": 5 },
  "emote_thinking": { "frames": ["interact_2"], "fps": 1 },
  "emote_confused": { "frames": ["interact_2", "interact_3"], "fps": 3 },
  "emote_alarmed":  { "frames": ["alert_0", "alert_1"], "fps": 5 }
}
```

Check `build/debug.png` for which `usetech` frame shows the floating holo tablet and which `interact` frames carry the "?" and "!"; adjust the indices above to match, and note any change in your report. The hover, hide, damage, faces, turnaround, and props frames stay in the atlas unmapped for later use.

- [ ] **Step 11: Write the pack validation test**

`src/main/pack.mechanicus.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { loadPack, ANIMATION_KEYS } from './pack'

describe('mechanicus pack', () => {
  it('loads with every vocabulary key mapped to real frames', () => {
    const r = loadPack(join(__dirname, '../../packs/mechanicus'))
    if (!r.ok) throw new Error(r.errors.join('\n'))
    for (const key of ANIMATION_KEYS) {
      expect(r.pack.animations[key].right.length, key).toBeGreaterThan(0)
    }
    expect(r.pack.animations.walk.mirrorLeft).toBe(false)
    expect(r.pack.animations.walk.left[0]).toBe('walk_left_0')
    expect(r.pack.persona.lines.greeting.length).toBeGreaterThan(0)
    expect(r.pack.persona.prompt).toContain('Magos Vex')
  })
})
```

Run: `npx vitest run src/main/pack.mechanicus.test.ts`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add tools packs/mechanicus src/main/pack.mechanicus.test.ts
git commit -m "feat: mechanicus pack built from the keyed sprite sheet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Config, IPC contract, preload bridge, pack protocol

**Files:**
- Create: `src/main/config.ts`, `src/main/config.test.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/protocol.ts`, `src/main/protocol.test.ts`

**Interfaces:**
- Produces:

```ts
// src/main/config.ts
export interface Config { pack: string; cliPath: string; workspace: string; extraDirs: string[];
  model: string | null; allowedTools: string[]; permissionTimeoutSec: number;
  wanderIntervalSec: [number, number]; sleepAfterMin: number; scale: number }
export const DEFAULT_CONFIG: Config
export function expandEnv(s: string): string                 // %VAR% expansion
export function loadConfig(path: string): Config             // merges defaults, writes file if missing
export function saveConfig(path: string, cfg: Config): void

// src/shared/ipc.ts
export const CH: { readonly [k: string]: string }            // channel names, see step 2
export interface PackLoadedPayload { atlasUrl: string; atlasJsonUrl: string; animations: Animations; scale: number; name: string }
export interface BuddyStatePayload { state: BuddyState; animation: AnimationKey; speed: number }
export interface ChatDeltaPayload { text: string }
export interface ChatActivityPayload { id: string; label: string; done: boolean }
export interface ChatDonePayload { error?: string }
export interface ChatPermissionPayload { id: string; toolName: string; summary: string; line: string }
export interface ChatStatusPayload { model: string | null; workspace: string; session: string; error?: string }
export interface ChatSystemPayload { text: string }
export interface ThemePayload extends PackTheme { name: string }
export interface BuddyBridge { ... }                         // window.buddy, see step 4

// src/main/protocol.ts
export const PACK_SCHEME = 'pack'
export function resolvePackPath(packDir: string, url: string): string | null   // pure
export function registerPackScheme(): void                   // call before app ready
export function handlePackProtocol(packDir: string): void    // call after app ready
```

- [ ] **Step 1: Write the failing config tests**

`src/main/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, expandEnv, loadConfig, saveConfig } from './config'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'cfg-')), 'config.json')

describe('config', () => {
  it('expands %VAR% from the environment', () => {
    process.env.BUDDY_TEST_VAR = 'X:\\home'
    expect(expandEnv('%BUDDY_TEST_VAR%\\.local')).toBe('X:\\home\\.local')
    expect(expandEnv('%NOPE_NOT_SET%\\a')).toBe('%NOPE_NOT_SET%\\a')
  })
  it('writes defaults when the file is missing', () => {
    const p = tmp()
    const cfg = loadConfig(p)
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(existsSync(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8')).workspace).toBe('C:\\repo')
  })
  it('merges a partial file over defaults', () => {
    const p = tmp()
    writeFileSync(p, JSON.stringify({ model: 'sonnet', scale: 1.5 }))
    const cfg = loadConfig(p)
    expect(cfg.model).toBe('sonnet')
    expect(cfg.scale).toBe(1.5)
    expect(cfg.pack).toBe(DEFAULT_CONFIG.pack)
  })
  it('falls back to defaults on invalid JSON without overwriting the file', () => {
    const p = tmp()
    writeFileSync(p, '{ not json')
    expect(loadConfig(p)).toEqual(DEFAULT_CONFIG)
    expect(readFileSync(p, 'utf8')).toBe('{ not json')
  })
  it('round-trips through saveConfig', () => {
    const p = tmp()
    saveConfig(p, { ...DEFAULT_CONFIG, workspace: 'D:\\w' })
    expect(loadConfig(p).workspace).toBe('D:\\w')
  })
})
```

- [ ] **Step 2: Write `src/main/config.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Config {
  pack: string
  cliPath: string
  workspace: string
  extraDirs: string[]
  model: string | null
  allowedTools: string[]
  permissionTimeoutSec: number
  wanderIntervalSec: [number, number]
  sleepAfterMin: number
  scale: number
}

export const DEFAULT_CONFIG: Config = {
  pack: 'packs/mechanicus',
  cliPath: '%USERPROFILE%\\.local\\bin\\claude.exe',
  workspace: 'C:\\repo',
  extraDirs: [],
  model: null,
  allowedTools: ['Read', 'Glob', 'Grep', 'mcp__buddy__*'],
  permissionTimeoutSec: 120,
  wanderIntervalSec: [8, 30],
  sleepAfterMin: 10,
  scale: 1.0,
}

export function expandEnv(s: string): string {
  return s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    saveConfig(path, DEFAULT_CONFIG)
    return { ...DEFAULT_CONFIG }
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
    return { ...DEFAULT_CONFIG, ...raw }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(path: string, cfg: Config): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')
}
```

Run: `npx vitest run src/main/config.test.ts`
Expected: 5 PASS.

- [ ] **Step 3: Write `src/shared/ipc.ts`**

```ts
import type { AnimationKey, Animations, BuddyState, PackTheme } from './types'

export const CH = {
  packLoaded: 'pack:loaded',
  buddyState: 'buddy:state',
  overlayReady: 'overlay:ready',
  overlayHover: 'overlay:hover',
  overlayClick: 'overlay:click',
  overlayContextMenu: 'overlay:contextMenu',
  overlayArrived: 'overlay:arrived',
  overlayOneShotDone: 'overlay:oneShotDone',
  theme: 'theme',
  chatDelta: 'chat:delta',
  chatActivity: 'chat:activity',
  chatDone: 'chat:done',
  chatPermission: 'chat:permission',
  chatStatus: 'chat:status',
  chatSystem: 'chat:system',
  hologramReady: 'hologram:ready',
  chatPrompt: 'chat:prompt',
  chatPermissionAnswer: 'chat:permissionAnswer',
  chatClose: 'chat:close',
  chatStop: 'chat:stop',
} as const

export interface PackLoadedPayload { atlasUrl: string; atlasJsonUrl: string; animations: Animations; scale: number; name: string }
export interface BuddyStatePayload { state: BuddyState; animation: AnimationKey; speed: number }
export interface ChatDeltaPayload { text: string }
export interface ChatActivityPayload { id: string; label: string; done: boolean }
export interface ChatDonePayload { error?: string }
export interface ChatPermissionPayload { id: string; toolName: string; summary: string; line: string }
export interface ChatStatusPayload { model: string | null; workspace: string; session: string; error?: string }
export interface ChatSystemPayload { text: string }
export interface ThemePayload extends PackTheme { name: string }

export interface BuddyBridge {
  onPackLoaded(cb: (p: PackLoadedPayload) => void): void
  onBuddyState(cb: (p: BuddyStatePayload) => void): void
  overlayReady(): void
  hover(over: boolean): void
  click(): void
  contextMenu(x: number, y: number): void
  arrived(): void
  oneShotDone(): void
  onTheme(cb: (p: ThemePayload) => void): void
  onChatDelta(cb: (p: ChatDeltaPayload) => void): void
  onChatActivity(cb: (p: ChatActivityPayload) => void): void
  onChatDone(cb: (p: ChatDonePayload) => void): void
  onChatPermission(cb: (p: ChatPermissionPayload) => void): void
  onChatStatus(cb: (p: ChatStatusPayload) => void): void
  onChatSystem(cb: (p: ChatSystemPayload) => void): void
  hologramReady(): void
  prompt(text: string): void
  permissionAnswer(id: string, allow: boolean): void
  closePanel(): void
  stop(): void
}

declare global { interface Window { buddy: BuddyBridge } }
```

- [ ] **Step 4: Write `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { CH, type BuddyBridge } from '../shared/ipc'

const on = <T,>(channel: string) => (cb: (p: T) => void) => {
  ipcRenderer.on(channel, (_e, payload: T) => cb(payload))
}

const bridge: BuddyBridge = {
  onPackLoaded: on(CH.packLoaded),
  onBuddyState: on(CH.buddyState),
  overlayReady: () => ipcRenderer.send(CH.overlayReady),
  hover: (over) => ipcRenderer.send(CH.overlayHover, { over }),
  click: () => ipcRenderer.send(CH.overlayClick),
  contextMenu: (x, y) => ipcRenderer.send(CH.overlayContextMenu, { x, y }),
  arrived: () => ipcRenderer.send(CH.overlayArrived),
  oneShotDone: () => ipcRenderer.send(CH.overlayOneShotDone),
  onTheme: on(CH.theme),
  onChatDelta: on(CH.chatDelta),
  onChatActivity: on(CH.chatActivity),
  onChatDone: on(CH.chatDone),
  onChatPermission: on(CH.chatPermission),
  onChatStatus: on(CH.chatStatus),
  onChatSystem: on(CH.chatSystem),
  hologramReady: () => ipcRenderer.send(CH.hologramReady),
  prompt: (text) => ipcRenderer.send(CH.chatPrompt, { text }),
  permissionAnswer: (id, allow) => ipcRenderer.send(CH.chatPermissionAnswer, { id, allow }),
  closePanel: () => ipcRenderer.send(CH.chatClose),
  stop: () => ipcRenderer.send(CH.chatStop),
}

contextBridge.exposeInMainWorld('buddy', bridge)
```

- [ ] **Step 5: Write the failing protocol test**

`src/main/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { resolvePackPath } from './protocol'

const dir = resolve('C:/p/packs/x')
describe('resolvePackPath', () => {
  it('maps pack://app/<file> into the pack directory', () => {
    expect(resolvePackPath(dir, 'pack://app/atlas.png')).toBe(resolve(dir, 'atlas.png'))
    expect(resolvePackPath(dir, 'pack://app/sub/a.json')).toBe(resolve(dir, 'sub', 'a.json'))
  })
  it('rejects traversal and empty paths', () => {
    expect(resolvePackPath(dir, 'pack://app/../manifest.json')).toBeNull()
    expect(resolvePackPath(dir, 'pack://app/')).toBeNull()
  })
  it('decodes percent-encoding', () => {
    expect(resolvePackPath(dir, 'pack://app/my%20file.png')).toBe(resolve(dir, 'my file.png'))
  })
})
```

- [ ] **Step 6: Write `src/main/protocol.ts`**

The Electron imports are kept in functions the test never calls; Vitest can still import the module because `electron` resolves to the stub package that exports the executable path. To keep the test free of Electron entirely, import lazily inside the two Electron functions.

```ts
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PACK_SCHEME = 'pack'

export function resolvePackPath(packDir: string, url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== `${PACK_SCHEME}:`) return null
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  if (!rel) return null
  const root = resolve(packDir)
  const full = resolve(root, rel)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

export async function registerPackScheme(): Promise<void> {
  const { protocol } = await import('electron')
  protocol.registerSchemesAsPrivileged([
    { scheme: PACK_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ])
}

export async function handlePackProtocol(packDir: string): Promise<void> {
  const { protocol, net } = await import('electron')
  protocol.handle(PACK_SCHEME, (request) => {
    const path = resolvePackPath(packDir, request.url)
    if (!path) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(path).toString())
  })
}
```

Note: `registerSchemesAsPrivileged` must run before `app.whenReady()` resolves. Task 9 awaits it at the top of `src/main/index.ts` before awaiting ready. If the dynamic import proves awkward there, change both functions to plain synchronous functions with a top-level `import { protocol, net } from 'electron'` and add `alias: { electron: './test/electron-stub.ts' }` to `vitest.config.ts` with a stub exporting empty `protocol` and `net` objects.

Run: `npx vitest run src/main/protocol.test.ts`
Expected: 3 PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/main/config.ts src/main/config.test.ts src/shared/ipc.ts src/preload/index.ts src/main/protocol.ts src/main/protocol.test.ts
git commit -m "feat: config, IPC contract, preload bridge, pack protocol

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Overlay renderer (animator, motion, hit test, canvas glue)

**Files:**
- Create: `src/renderer/overlay/animator.ts`, `src/renderer/overlay/animator.test.ts`, `src/renderer/overlay/motion.ts`, `src/renderer/overlay/motion.test.ts`, `src/renderer/overlay/hittest.ts`
- Modify: `src/renderer/overlay/index.html`, `src/renderer/overlay/main.ts`

**Interfaces:**
- Consumes: `BuddyBridge` on `window.buddy`, `PackLoadedPayload`, `BuddyStatePayload`, `Atlas`, `AtlasFrame`, `Animations`.
- Produces:

```ts
// animator.ts
export class Animator {
  constructor(animations: Animations)
  set(key: AnimationKey): void            // no-op if unchanged; otherwise restarts
  setFacing(f: Facing): void
  current(): { frame: string; mirror: boolean }
  advance(dtMs: number): { justFinished: boolean }   // true exactly once per non-looping run
}
// motion.ts
export class Motion {
  x: number; target: number | undefined; speed: number
  constructor(x?: number)
  setTarget(target: number | undefined, speed: number): void
  advance(dtMs: number): { arrived: boolean }         // true exactly once on reaching target
}
// hittest.ts
export class HitTester {
  update(image: CanvasImageSource, frame: AtlasFrame): void
  hit(fx: number, fy: number): boolean                // frame-space pixels, alpha > 40
}
```

Drawing rule (used here and by the hit test): the canvas is `maxFrameSize * scale`; baseline `baselineY = canvas.height - 4`; a frame draws at `dx = canvas.width / 2 - f.ax * scale`, `dy = baselineY - f.ay * scale`. When mirrored, apply `ctx.translate(canvas.width, 0); ctx.scale(-1, 1)` and draw at the same `(dx, dy)`; the anchor then lands at the same screen x. The canvas element is translated by `x * (window.innerWidth - canvas.width)` px.

- [ ] **Step 1: Write the failing animator and motion tests**

`src/renderer/overlay/animator.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Animator } from './animator'
import type { Animations } from '../../shared/types'

const anims = {
  idle: { right: ['i0', 'i1'], left: ['i0', 'i1'], fps: 10, loop: true, mirrorLeft: false },
  walk: { right: ['w0', 'w1'], left: ['w0', 'w1'], fps: 10, loop: true, mirrorLeft: true },
  emote_happy: { right: ['h0', 'h1'], left: ['h0', 'h1'], fps: 10, loop: false, mirrorLeft: false },
} as unknown as Animations

describe('Animator', () => {
  it('loops', () => {
    const a = new Animator(anims)
    expect(a.current().frame).toBe('i0')
    a.advance(100); expect(a.current().frame).toBe('i1')
    a.advance(100); expect(a.current().frame).toBe('i0')
  })
  it('finishes a one-shot exactly once and holds the last frame', () => {
    const a = new Animator(anims); a.set('emote_happy')
    expect(a.advance(100).justFinished).toBe(false)
    expect(a.current().frame).toBe('h1')
    expect(a.advance(100).justFinished).toBe(true)
    expect(a.advance(100).justFinished).toBe(false)
    expect(a.current().frame).toBe('h1')
  })
  it('mirrors only when the animation asks for it', () => {
    const a = new Animator(anims); a.setFacing('left')
    expect(a.current().mirror).toBe(false)
    a.set('walk'); expect(a.current().mirror).toBe(true)
  })
  it('does not restart when set to the same key', () => {
    const a = new Animator(anims); a.advance(100); a.set('idle')
    expect(a.current().frame).toBe('i1')
  })
  it('accumulates partial frames', () => {
    const a = new Animator(anims); a.advance(60); a.advance(60)
    expect(a.current().frame).toBe('i1')
  })
})
```

`src/renderer/overlay/motion.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Motion } from './motion'

describe('Motion', () => {
  it('moves toward the target at the given speed', () => {
    const m = new Motion(0); m.setTarget(1, 0.5)
    m.advance(1000); expect(m.x).toBeCloseTo(0.5)
  })
  it('snaps and reports arrival once', () => {
    const m = new Motion(0.9); m.setTarget(1, 0.5)
    expect(m.advance(1000)).toEqual({ arrived: true })
    expect(m.x).toBe(1)
    expect(m.advance(1000)).toEqual({ arrived: false })
  })
  it('moves left too and ignores a missing target', () => {
    const m = new Motion(0.5); m.setTarget(0, 0.1)
    m.advance(1000); expect(m.x).toBeCloseTo(0.4)
    m.setTarget(undefined, 0); m.advance(1000); expect(m.x).toBeCloseTo(0.4)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/overlay`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `animator.ts` and `motion.ts`**

`src/renderer/overlay/animator.ts`:

```ts
import type { AnimationKey, Animations, Facing } from '../../shared/types'

export class Animator {
  private key: AnimationKey = 'idle'
  private facing: Facing = 'right'
  private index = 0
  private elapsed = 0
  private finished = false
  constructor(private readonly animations: Animations) {}

  set(key: AnimationKey): void {
    if (key === this.key) return
    this.key = key; this.index = 0; this.elapsed = 0; this.finished = false
  }
  setFacing(f: Facing): void { this.facing = f }
  private list(): string[] {
    const def = this.animations[this.key]
    return this.facing === 'left' ? def.left : def.right
  }
  current(): { frame: string; mirror: boolean } {
    const def = this.animations[this.key]
    const list = this.list()
    const frame = list[Math.min(this.index, list.length - 1)] ?? ''
    return { frame, mirror: this.facing === 'left' && def.mirrorLeft }
  }
  advance(dtMs: number): { justFinished: boolean } {
    if (this.finished) return { justFinished: false }
    const def = this.animations[this.key]
    const n = this.list().length
    const frameMs = 1000 / def.fps
    this.elapsed += dtMs
    while (this.elapsed >= frameMs) {
      this.elapsed -= frameMs
      if (this.index + 1 < n) this.index++
      else if (def.loop) this.index = 0
      else { this.finished = true; return { justFinished: true } }
    }
    return { justFinished: false }
  }
}
```

`src/renderer/overlay/motion.ts`:

```ts
export class Motion {
  x: number
  target: number | undefined
  speed = 0
  constructor(x = 0.5) { this.x = x }
  setTarget(target: number | undefined, speed: number): void { this.target = target; this.speed = speed }
  advance(dtMs: number): { arrived: boolean } {
    if (this.target === undefined || this.speed <= 0) return { arrived: false }
    const step = this.speed * dtMs / 1000
    const d = this.target - this.x
    if (Math.abs(d) <= step) { this.x = this.target; this.target = undefined; return { arrived: true } }
    this.x += Math.sign(d) * step
    return { arrived: false }
  }
}
```

Run: `npx vitest run src/renderer/overlay`
Expected: 8 PASS.

- [ ] **Step 4: Write `hittest.ts`**

```ts
import type { AtlasFrame } from '../../shared/types'

export class HitTester {
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  private w = 0
  private h = 0
  update(image: CanvasImageSource, frame: AtlasFrame): void {
    this.w = frame.w; this.h = frame.h
    this.canvas.width = frame.w; this.canvas.height = frame.h
    this.ctx.clearRect(0, 0, frame.w, frame.h)
    this.ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h)
  }
  hit(fx: number, fy: number): boolean {
    if (fx < 0 || fy < 0 || fx >= this.w || fy >= this.h) return false
    return (this.ctx.getImageData(Math.floor(fx), Math.floor(fy), 1, 1).data[3] ?? 0) > 40
  }
}
```

- [ ] **Step 5: Write the overlay page**

`src/renderer/overlay/index.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self' pack: http://localhost:* ws://localhost:*; img-src 'self' pack: data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' pack: http://localhost:* ws://localhost:*">
  <title>overlay</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
    #buddy { position: absolute; left: 0; bottom: 0; will-change: transform; }
  </style>
</head>
<body><canvas id="buddy"></canvas><script type="module" src="./main.ts"></script></body>
</html>
```

`src/renderer/overlay/main.ts`:

```ts
import { Animator } from './animator'
import { Motion } from './motion'
import { HitTester } from './hittest'
import type { Atlas, AtlasFrame } from '../../shared/types'
import type { BuddyStatePayload, PackLoadedPayload } from '../../shared/ipc'

const canvas = document.getElementById('buddy') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const motion = new Motion(0.5)
const hit = new HitTester()
let atlas: Atlas | null = null
let image: HTMLImageElement | null = null
let animator: Animator | null = null
let scale = 1
let hovering = false
let lastState: BuddyStatePayload | null = null
let hitFrame = ''
let drawn: { f: AtlasFrame; mirror: boolean } | null = null

const loadImage = (url: string) => new Promise<HTMLImageElement>((res, rej) => {
  const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url
})
const walkable = () => Math.max(1, window.innerWidth - canvas.width)
const place = () => { canvas.style.transform = `translateX(${Math.round(motion.x * walkable())}px)` }

function layout(): void {
  if (!atlas) return
  canvas.width = Math.ceil(atlas.maxFrameSize[0] * scale)
  canvas.height = Math.ceil(atlas.maxFrameSize[1] * scale)
  place()
}

function apply(s: BuddyStatePayload): void {
  if (!animator) return
  animator.setFacing(s.state.facing)
  animator.set(s.animation)
  if (s.state.targetX !== undefined) motion.setTarget(s.state.targetX, s.speed)
  else { motion.setTarget(undefined, 0); motion.x = s.state.x }
  place()
}

window.buddy.onPackLoaded(async (p: PackLoadedPayload) => {
  atlas = await (await fetch(p.atlasJsonUrl)).json() as Atlas
  image = await loadImage(p.atlasUrl)
  scale = p.scale
  animator = new Animator(p.animations)
  layout()
  if (lastState) apply(lastState)
})
window.buddy.onBuddyState((s) => { lastState = s; apply(s) })
window.addEventListener('resize', layout)

function draw(): void {
  if (!animator || !atlas || !image) return
  const { frame: name, mirror } = animator.current()
  const f = atlas.frames[name]
  if (!f) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const baselineY = canvas.height - 4
  const dx = canvas.width / 2 - f.ax * scale
  const dy = baselineY - f.ay * scale
  ctx.save()
  if (mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1) }
  ctx.drawImage(image, f.x, f.y, f.w, f.h, dx, dy, f.w * scale, f.h * scale)
  ctx.restore()
  if (name !== hitFrame) { hit.update(image, f); hitFrame = name }
  drawn = { f, mirror }
}

let last = performance.now()
function tick(now: number): void {
  const dt = Math.min(100, now - last); last = now
  if (animator) {
    const m = motion.advance(dt)
    if (m.arrived || motion.target !== undefined) place()
    if (m.arrived) window.buddy.arrived()
    if (animator.advance(dt).justFinished) window.buddy.oneShotDone()
    draw()
  }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

function isOver(clientX: number, clientY: number): boolean {
  if (!drawn) return false
  const r = canvas.getBoundingClientRect()
  const lx = clientX - r.left, ly = clientY - r.top
  const { f, mirror } = drawn
  const baselineY = canvas.height - 4
  const left = mirror ? canvas.width / 2 - (f.w - f.ax) * scale : canvas.width / 2 - f.ax * scale
  const top = baselineY - f.ay * scale
  let fx = (lx - left) / scale
  const fy = (ly - top) / scale
  if (mirror) fx = f.w - fx
  return hit.hit(fx, fy)
}

window.addEventListener('mousemove', (e) => {
  const over = isOver(e.clientX, e.clientY)
  if (over !== hovering) { hovering = over; window.buddy.hover(over) }
})
document.addEventListener('mouseleave', () => { if (hovering) { hovering = false; window.buddy.hover(false) } })
canvas.addEventListener('mousedown', (e) => { if (e.button === 0 && isOver(e.clientX, e.clientY)) window.buddy.click() })
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (isOver(e.clientX, e.clientY)) window.buddy.contextMenu(e.screenX, e.screenY)
})

window.buddy.overlayReady()
```

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck && npx vitest run`
Expected: exit 0; all unit tests pass (the renderer has no runtime test until Task 9 wires the window).

```bash
git add src/renderer/overlay
git commit -m "feat: overlay renderer with animator, motion, hit test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Windows, actions facade, IPC wiring, bootstrap (character on screen)

**Files:**
- Create: `src/main/geometry.ts`, `src/main/geometry.test.ts`, `src/main/windows.ts`, `src/main/actions.ts`, `src/main/actions.test.ts`, `src/main/ipc.ts`
- Modify: `src/main/index.ts` (replace the Task 1 placeholder)

**Interfaces:**
- Consumes: `Buddy` (Task 4), `loadPack` (Task 3), `loadConfig` (Task 7), `CH` and payloads (Task 7), protocol functions (Task 7).
- Produces:

```ts
// geometry.ts (pure)
export const OVERLAY_HEIGHT = 260
export const HOLOGRAM_SIZE = { width: 480, height: 360 }
export interface Rect { x: number; y: number; width: number; height: number }
export function overlayBounds(workArea: Rect): Rect
export function hologramBounds(workArea: Rect, xFraction: number, charW: number, charH: number): Rect

// windows.ts
export function rendererUrl(page: 'overlay' | 'hologram'): { url?: string; file?: string }
export function createOverlayWindow(): BrowserWindow
export function createHologramWindow(onBlur: () => void): BrowserWindow
export function setOverlayInteractive(win: BrowserWindow, interactive: boolean): void
export function loadPage(win: BrowserWindow, page: 'overlay' | 'hologram'): void

// actions.ts
export interface ActionHost { showPanel(): void; hidePanel(): void; pushSystem(text: string): void }
export interface BuddyActions {            // spec section 9
  goTo(xFraction: number, opts?: { run?: boolean }): Promise<void>
  setMood(mood: Mood): void
  emote(kind: EmoteKind): Promise<void>
  say(text: string): void
  openPanel(): void
  closePanel(): void
  sleep(): void
  wake(): void
  getState(): BuddyState
}
export class Actions implements BuddyActions { constructor(buddy: Buddy, host: ActionHost) }

// ipc.ts
export interface ChatPort { prompt(text: string): void; permissionAnswer(id: string, allow: boolean): void; stop(): void }
export interface IpcDeps { buddy: Buddy; actions: Actions; overlay: BrowserWindow; hologram: BrowserWindow;
  packPayload: PackLoadedPayload; theme: ThemePayload; chat: ChatPort; status(): ChatStatusPayload;
  showContextMenu(x: number, y: number): void }
export function wireIpc(deps: IpcDeps): void
```

Deliberate simplification of spec 14: if the pack fails validation, main shows an error box listing the errors and quits, instead of a placeholder rectangle.

- [ ] **Step 1: Write the failing geometry and actions tests**

`src/main/geometry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { hologramBounds, overlayBounds, HOLOGRAM_SIZE, OVERLAY_HEIGHT } from './geometry'

const wa = { x: 0, y: 0, width: 2560, height: 1392 }
describe('geometry', () => {
  it('overlay is a strip on the bottom of the work area', () => {
    expect(overlayBounds(wa)).toEqual({ x: 0, y: 1392 - OVERLAY_HEIGHT, width: 2560, height: OVERLAY_HEIGHT })
  })
  it('hologram sits above the character and shifts toward the screen center', () => {
    const left = hologramBounds(wa, 0, 200, 200)
    const right = hologramBounds(wa, 1, 200, 200)
    expect(left.width).toBe(HOLOGRAM_SIZE.width)
    expect(left.x).toBeGreaterThanOrEqual(0)
    expect(right.x + right.width).toBeLessThanOrEqual(2560)
    expect(left.x).toBeGreaterThan(100 - HOLOGRAM_SIZE.width / 2)     // biased right of the character
    expect(right.x).toBeLessThan(2460 - HOLOGRAM_SIZE.width / 2)      // biased left of the character
    expect(left.y + left.height).toBeLessThanOrEqual(1392 - 200 + 24)
    expect(left.y).toBeGreaterThanOrEqual(0)
  })
  it('never leaves a small work area', () => {
    const small = { x: 100, y: 50, width: 600, height: 400 }
    const b = hologramBounds(small, 0.5, 200, 200)
    expect(b.x).toBeGreaterThanOrEqual(100)
    expect(b.x + b.width).toBeLessThanOrEqual(700)
    expect(b.y).toBeGreaterThanOrEqual(50)
  })
})
```

`src/main/actions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Buddy } from './buddy'
import { Actions, type ActionHost } from './actions'

function host(): ActionHost & { shown: number; hidden: number; texts: string[] } {
  return { shown: 0, hidden: 0, texts: [],
    showPanel() { this.shown++ }, hidePanel() { this.hidden++ }, pushSystem(t) { this.texts.push(t) } }
}

describe('Actions', () => {
  it('goTo resolves when the buddy arrives', async () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const a = new Actions(b, host())
    const p = a.goTo(0.9)
    expect(b.getState().activity).toBe('running')
    b.arrived()
    await p
    expect(b.getState().x).toBe(0.9)
  })
  it('goTo resolves immediately when already there', async () => {
    const b = new Buddy({ rng: () => 0, initialX: 0.5 }); b.tick(0)
    await new Actions(b, host()).goTo(0.5)
  })
  it('openPanel and closePanel drive the host and the state', () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const h = host(); const a = new Actions(b, h)
    a.openPanel()
    expect(h.shown).toBe(1); expect(b.getState().panelOpen).toBe(true)
    a.closePanel()
    expect(h.hidden).toBe(1); expect(b.getState().panelOpen).toBe(false)
  })
  it('say opens the panel and pushes the text', () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const h = host(); new Actions(b, h).say('hello')
    expect(h.texts).toEqual(['hello']); expect(h.shown).toBe(1)
  })
  it('emote resolves after the one-shot finishes', async () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const a = new Actions(b, host())
    const p = a.emote('confused')
    expect(b.view().animation).toBe('emote_confused')
    b.oneShotDone()
    await p
    expect(b.getState().activity).toBe('idle')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/geometry.test.ts src/main/actions.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/main/geometry.ts`**

```ts
export const OVERLAY_HEIGHT = 260
export const HOLOGRAM_SIZE = { width: 480, height: 360 }
export interface Rect { x: number; y: number; width: number; height: number }

export function overlayBounds(wa: Rect): Rect {
  return { x: wa.x, y: wa.y + wa.height - OVERLAY_HEIGHT, width: wa.width, height: OVERLAY_HEIGHT }
}

export function hologramBounds(wa: Rect, xFraction: number, charW: number, charH: number): Rect {
  const cx = wa.x + xFraction * Math.max(0, wa.width - charW) + charW / 2
  const bias = cx < wa.x + wa.width / 2 ? 1 : -1
  let x = Math.round(cx - HOLOGRAM_SIZE.width / 2 + bias * HOLOGRAM_SIZE.width * 0.35)
  x = Math.max(wa.x, Math.min(wa.x + wa.width - HOLOGRAM_SIZE.width, x))
  const charTop = wa.y + wa.height - charH
  const y = Math.max(wa.y, charTop - HOLOGRAM_SIZE.height + 24)
  return { x, y, width: HOLOGRAM_SIZE.width, height: HOLOGRAM_SIZE.height }
}
```

- [ ] **Step 4: Write `src/main/actions.ts`**

```ts
import type { BuddyState, EmoteKind, Mood } from '../shared/types'
import type { Buddy } from './buddy'

export interface ActionHost { showPanel(): void; hidePanel(): void; pushSystem(text: string): void }

export interface BuddyActions {
  goTo(xFraction: number, opts?: { run?: boolean }): Promise<void>
  setMood(mood: Mood): void
  emote(kind: EmoteKind): Promise<void>
  say(text: string): void
  openPanel(): void
  closePanel(): void
  sleep(): void
  wake(): void
  getState(): BuddyState
}

const EMOTE_ANIMS = new Set(['emote_happy', 'emote_thinking', 'emote_confused', 'emote_alarmed', 'look', 'hop', 'fall'])

export class Actions implements BuddyActions {
  constructor(private readonly buddy: Buddy, private readonly host: ActionHost) {}

  goTo(xFraction: number, opts?: { run?: boolean }): Promise<void> {
    return new Promise((resolve) => {
      const off = this.buddy.onArrive(() => { off(); resolve() })
      this.buddy.goTo(xFraction, opts?.run)
      if (this.buddy.getState().targetX === undefined) { off(); resolve() }
    })
  }
  setMood(mood: Mood): void { this.buddy.setMood(mood) }
  emote(kind: EmoteKind): Promise<void> {
    return new Promise((resolve) => {
      this.buddy.emote(kind)
      if (!EMOTE_ANIMS.has(this.buddy.view().animation)) { resolve(); return }
      const timer = setTimeout(() => { off(); resolve() }, 5000)
      const off = this.buddy.onChange((v) => {
        if (!EMOTE_ANIMS.has(v.animation)) { clearTimeout(timer); off(); resolve() }
      })
    })
  }
  say(text: string): void { this.host.pushSystem(text); this.openPanel() }
  openPanel(): void { this.buddy.openPanel(); this.host.showPanel() }
  closePanel(): void { this.buddy.closePanel(); this.host.hidePanel() }
  sleep(): void { this.buddy.sleep() }
  wake(): void { this.buddy.wake() }
  getState(): BuddyState { return this.buddy.getState() }
}
```

Run: `npx vitest run src/main/geometry.test.ts src/main/actions.test.ts`
Expected: 8 PASS.

- [ ] **Step 5: Write `src/main/windows.ts`**

```ts
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { HOLOGRAM_SIZE, overlayBounds } from './geometry'

export function rendererUrl(page: 'overlay' | 'hologram'): { url?: string; file?: string } {
  const dev = process.env.ELECTRON_RENDERER_URL
  return dev ? { url: `${dev}/${page}/index.html` } : { file: join(__dirname, `../renderer/${page}/index.html`) }
}
export function loadPage(win: BrowserWindow, page: 'overlay' | 'hologram'): void {
  const target = rendererUrl(page)
  if (target.url) void win.loadURL(target.url)
  else if (target.file) void win.loadFile(target.file)
}

const preload = join(__dirname, '../preload/index.js')
const webPreferences = { preload, contextIsolation: true, nodeIntegration: false, sandbox: true }

export function createOverlayWindow(): BrowserWindow {
  const b = overlayBounds(screen.getPrimaryDisplay().workArea)
  const win = new BrowserWindow({
    ...b, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, focusable: false,
    resizable: false, movable: false, hasShadow: false, show: false, webPreferences,
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.once('ready-to-show', () => win.showInactive())
  loadPage(win, 'overlay')
  return win
}

export function createHologramWindow(onBlur: () => void): BrowserWindow {
  const win = new BrowserWindow({
    ...HOLOGRAM_SIZE, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, show: false, hasShadow: false, webPreferences,
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.on('blur', onBlur)
  loadPage(win, 'hologram')
  return win
}

export function setOverlayInteractive(win: BrowserWindow, interactive: boolean): void {
  if (interactive) win.setIgnoreMouseEvents(false)
  else win.setIgnoreMouseEvents(true, { forward: true })
}

export function rebound(overlay: BrowserWindow): void {
  overlay.setBounds(overlayBounds(screen.getPrimaryDisplay().workArea))
}
```

- [ ] **Step 6: Write `src/main/ipc.ts`**

```ts
import { ipcMain, type BrowserWindow } from 'electron'
import { CH, type ChatStatusPayload, type PackLoadedPayload, type ThemePayload } from '../shared/ipc'
import type { Buddy } from './buddy'
import type { Actions } from './actions'
import { setOverlayInteractive } from './windows'

export interface ChatPort { prompt(text: string): void; permissionAnswer(id: string, allow: boolean): void; stop(): void }
export interface IpcDeps {
  buddy: Buddy; actions: Actions; overlay: BrowserWindow; hologram: BrowserWindow
  packPayload: PackLoadedPayload; theme: ThemePayload; chat: ChatPort
  status(): ChatStatusPayload; showContextMenu(x: number, y: number): void
}

export function wireIpc(d: IpcDeps): void {
  ipcMain.on(CH.overlayReady, () => {
    d.overlay.webContents.send(CH.packLoaded, d.packPayload)
    d.overlay.webContents.send(CH.buddyState, d.buddy.view())
  })
  ipcMain.on(CH.overlayHover, (_e, p: { over: boolean }) => setOverlayInteractive(d.overlay, p.over))
  ipcMain.on(CH.overlayClick, () => {
    d.buddy.interact()
    if (d.buddy.getState().panelOpen) d.actions.closePanel(); else d.actions.openPanel()
  })
  ipcMain.on(CH.overlayContextMenu, (_e, p: { x: number; y: number }) => d.showContextMenu(p.x, p.y))
  ipcMain.on(CH.overlayArrived, () => d.buddy.arrived())
  ipcMain.on(CH.overlayOneShotDone, () => d.buddy.oneShotDone())
  ipcMain.on(CH.hologramReady, () => {
    d.hologram.webContents.send(CH.theme, d.theme)
    d.hologram.webContents.send(CH.chatStatus, d.status())
  })
  ipcMain.on(CH.chatPrompt, (_e, p: { text: string }) => d.chat.prompt(p.text))
  ipcMain.on(CH.chatPermissionAnswer, (_e, p: { id: string; allow: boolean }) => d.chat.permissionAnswer(p.id, p.allow))
  ipcMain.on(CH.chatClose, () => d.actions.closePanel())
  ipcMain.on(CH.chatStop, () => d.chat.stop())
}
```

- [ ] **Step 7: Replace `src/main/index.ts`**

```ts
import { app, dialog, screen } from 'electron'
import { isAbsolute, join } from 'node:path'
import { loadConfig } from './config'
import { loadPack } from './pack'
import { registerPackScheme, handlePackProtocol } from './protocol'
import { Buddy } from './buddy'
import { Actions, type ActionHost } from './actions'
import { createHologramWindow, createOverlayWindow, rebound } from './windows'
import { hologramBounds } from './geometry'
import { wireIpc } from './ipc'
import { CH, type ChatStatusPayload } from '../shared/ipc'

async function main(): Promise<void> {
  await registerPackScheme()
  await app.whenReady()

  const config = loadConfig(join(app.getPath('userData'), 'config.json'))
  const packDir = isAbsolute(config.pack) ? config.pack : join(app.getAppPath(), config.pack)
  const loaded = loadPack(packDir)
  if (!loaded.ok) {
    dialog.showErrorBox('Persona pack failed to load', loaded.errors.join('\n'))
    app.quit(); return
  }
  const pack = loaded.pack
  await handlePackProtocol(pack.dir)

  const scale = pack.scale * config.scale
  const charW = pack.atlas.maxFrameSize[0] * scale
  const charH = pack.atlas.maxFrameSize[1] * scale
  const buddy = new Buddy({
    wanderIntervalMs: [config.wanderIntervalSec[0] * 1000, config.wanderIntervalSec[1] * 1000],
    sleepAfterMs: config.sleepAfterMin * 60000,
    initialMood: pack.persona.defaultMood,
  })

  const overlay = createOverlayWindow()
  const hologram = createHologramWindow(() => { if (buddy.getState().panelOpen) actions.closePanel() })

  const placeHologram = () => hologram.setBounds(hologramBounds(screen.getPrimaryDisplay().workArea, buddy.getState().x, charW, charH))
  const host: ActionHost = {
    showPanel: () => { placeHologram(); hologram.show(); hologram.focus() },
    hidePanel: () => hologram.hide(),
    pushSystem: (text) => hologram.webContents.send(CH.chatSystem, { text }),
  }
  const actions = new Actions(buddy, host)

  const status = (): ChatStatusPayload => ({ model: config.model, workspace: config.workspace, session: 'new' })
  wireIpc({
    buddy, actions, overlay, hologram,
    packPayload: { atlasUrl: 'pack://app/' + pack.atlas.image, atlasJsonUrl: 'pack://app/atlas.json',
      animations: pack.animations, scale, name: pack.name },
    theme: { ...pack.theme, name: pack.name },
    chat: { prompt: () => {}, permissionAnswer: () => {}, stop: () => {} },   // replaced in Task 10
    status,
    showContextMenu: () => {},                                                  // replaced in Task 11
  })

  buddy.onChange((v) => {
    overlay.webContents.send(CH.buddyState, v)
    if (v.state.panelOpen && hologram.isVisible()) placeHologram()
  })
  setInterval(() => buddy.tick(Date.now()), 250)
  buddy.tick(Date.now())

  screen.on('display-metrics-changed', () => { rebound(overlay); if (hologram.isVisible()) placeHologram() })
  app.on('window-all-closed', () => app.quit())
}

void main()
```

- [ ] **Step 8: Run it and verify by eye**

Run: `npm run dev`
Expected: the character appears on the bottom edge of the primary display within a few seconds, idles, and starts wandering within 30 seconds, facing the direction of travel, running on long trips. Clicking the desktop through the transparent strip works. Hovering over his body and left-clicking opens an empty hologram window above him; clicking him again or clicking elsewhere hides it. Check `npm run dev` output for renderer errors. If the sprite is invisible, open DevTools by temporarily adding `overlay.webContents.openDevTools({ mode: 'detach' })` and check the `pack://` fetches in the Network tab.

- [ ] **Step 9: Typecheck, test, commit**

Run: `npm run typecheck && npx vitest run`
Expected: exit 0, all tests pass.

```bash
git add src/main
git commit -m "feat: overlay window, actions facade, IPC wiring, bootstrap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Hologram panel, markdown, echo brain, chat controller

**Files:**
- Create: `src/main/brain/types.ts`, `src/main/brain/echo.ts`, `src/main/brain/echo.test.ts`, `src/main/chat.ts`, `src/main/chat.test.ts`, `src/renderer/hologram/markdown.ts`, `src/renderer/hologram/markdown.test.ts`, `src/renderer/hologram/styles.css`
- Modify: `src/renderer/hologram/index.html`, `src/renderer/hologram/main.ts`, `src/main/index.ts` (replace the chat stub), `vitest.config.ts` (no change needed; jsdom is selected per file)

**Interfaces:**
- Consumes: `parseCommand`, `HELP_TEXT` (Task 2), `pickLine` (Task 3), `BuddyActions` (Task 9), `ChatPort` (Task 9), IPC payloads (Task 7).
- Produces:

```ts
// brain/types.ts
export interface BrainContext { state: BuddyState; workspace: string; model: string | null; sessionId: string | null }
export type BrainEvent =
  | { type: 'text'; delta: string }
  | { type: 'activity'; id: string; label: string; toolName: string; done?: boolean }
  | { type: 'status'; text: string }
  | { type: 'done'; sessionId?: string; error?: string }
export interface Brain { respond(prompt: string, ctx: BrainContext): AsyncIterable<BrainEvent>; stop(): void }

// brain/echo.ts
export class EchoBrain implements Brain { constructor(pack: PackData, actions: BuddyActions, opts?: { delayMs?: number; rng?: () => number }) }

// chat.ts
export interface ChatOut { delta(text: string): void; activity(a: ChatActivityPayload): void; done(d: ChatDonePayload): void; system(text: string): void; status(s: ChatStatusPayload): void }
export interface ChatSettings { workspace: string; model: string | null; sessionId: string | null }
export class ChatController implements ChatPort {
  constructor(deps: { brain: Brain; actions: BuddyActions; pack: PackData; out: ChatOut; settings: ChatSettings; onSettingsChange?: (s: ChatSettings) => void })
  prompt(text: string): void
  permissionAnswer(id: string, allow: boolean): void     // no-op until Plan B
  stop(): void
  get busy(): boolean
  status(): ChatStatusPayload
}

// renderer/hologram/markdown.ts
export function renderMarkdown(md: string): string        // sanitized HTML
```

- [ ] **Step 1: Install jsdom for the renderer test**

```bash
npm install --save-dev jsdom
```

- [ ] **Step 2: Write brain types and the failing echo test**

`src/main/brain/types.ts`: exactly the block above.

`src/main/brain/echo.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { EchoBrain } from './echo'
import { loadPack } from '../pack'
import type { BuddyActions } from '../actions'

const pack = (() => { const r = loadPack(join(__dirname, '../../../test/fixtures/pack-min')); if (!r.ok) throw new Error(r.errors.join()); return r.pack })()
const actions = { moods: [] as string[], setMood(m: string) { this.moods.push(m) } } as unknown as BuddyActions & { moods: string[] }
const ctx = { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null }

describe('EchoBrain', () => {
  it('streams a reply containing the prompt and ends with done', async () => {
    const b = new EchoBrain(pack, actions, { delayMs: 0, rng: () => 0 })
    const events = []
    for await (const e of b.respond('hello there', ctx)) events.push(e)
    const text = events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')
    expect(text).toContain('hi')
    expect(text).toContain('hello there')
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(actions.moods).toEqual(['happy'])
  })
})
```

- [ ] **Step 3: Write `src/main/brain/echo.ts`**

```ts
import type { PackData } from '../../shared/types'
import type { BuddyActions } from '../actions'
import { pickLine } from '../pack'
import type { Brain, BrainContext, BrainEvent } from './types'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export class EchoBrain implements Brain {
  private stopped = false
  constructor(private readonly pack: PackData, private readonly actions: BuddyActions,
    private readonly opts: { delayMs?: number; rng?: () => number } = {}) {}

  async *respond(prompt: string, _ctx: BrainContext): AsyncIterable<BrainEvent> {
    this.stopped = false
    const rng = this.opts.rng ?? Math.random
    const delay = this.opts.delayMs ?? 40
    const line = pickLine(this.pack, rng() < 0.5 ? 'greeting' : 'idleMutter', rng) ?? 'Acknowledged.'
    const text = `${line} You said: "${prompt}". The cogitator that answers properly arrives in the next slice.`
    if (rng() < 0.5) this.actions.setMood('happy')
    for (const word of text.split(/(?<=\s)/)) {
      if (this.stopped) break
      yield { type: 'text', delta: word }
      if (delay > 0) await sleep(delay)
    }
    yield { type: 'done' }
  }
  stop(): void { this.stopped = true }
}
```

Run: `npx vitest run src/main/brain/echo.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing chat controller test**

`src/main/chat.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { ChatController, type ChatOut } from './chat'
import { loadPack } from './pack'
import { HELP_TEXT } from './commands'
import type { Brain, BrainEvent } from './brain/types'
import type { BuddyActions } from './actions'

const pack = (() => { const r = loadPack(join(__dirname, '../../test/fixtures/pack-min')); if (!r.ok) throw new Error(r.errors.join()); return r.pack })()

function fakeOut() {
  const o = { deltas: [] as string[], systems: [] as string[], dones: 0, statuses: [] as unknown[],
    delta(t: string) { o.deltas.push(t) }, activity() {}, done() { o.dones++ }, system(t: string) { o.systems.push(t) }, status(s: unknown) { o.statuses.push(s) } }
  return o as typeof o & ChatOut
}
function fakeActions() {
  const a = { calls: [] as string[],
    goTo: async (x: number, o?: { run?: boolean }) => { a.calls.push(`goTo ${x} ${o?.run ?? false}`) },
    setMood: (m: string) => { a.calls.push(`mood ${m}`) },
    emote: async (k: string) => { a.calls.push(`emote ${k}`) },
    say() {}, openPanel() {}, closePanel() {}, sleep: () => a.calls.push('sleep'), wake: () => a.calls.push('wake'),
    getState: () => ({ x: 0.5, facing: 'right', activity: 'idle', mood: 'calm', panelOpen: true, asleep: false }) }
  return a as typeof a & BuddyActions
}
function scriptedBrain(events: BrainEvent[]): Brain & { stopped: number } {
  return { stopped: 0, async *respond() { for (const e of events) yield e }, stop() { this.stopped++ } }
}
const settings = () => ({ workspace: 'C:\\repo', model: null, sessionId: null })

describe('ChatController', () => {
  it('routes plain text to the brain and forwards events', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'text', delta: 'b' }, { type: 'done', sessionId: 's1' }]),
      actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('hello')
    await new Promise(r => setTimeout(r, 10))
    expect(out.deltas).toEqual(['a', 'b'])
    expect(out.dones).toBe(1)
    expect(c.status().session).toBe('s1')
  })
  it('runs slash commands through actions', async () => {
    const out = fakeOut(); const a = fakeActions()
    const c = new ChatController({ brain: scriptedBrain([]), actions: a, pack, out, settings: settings() })
    c.prompt('/goto 40'); c.prompt('/run right'); c.prompt('/mood confused'); c.prompt('/emote hop'); c.prompt('/sleep'); c.prompt('/wake')
    await new Promise(r => setTimeout(r, 10))
    expect(a.calls).toEqual(['goTo 0.4 false', 'goTo 1 true', 'mood confused', 'emote hop', 'sleep', 'wake'])
  })
  it('shows help and command errors as system lines', () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('/help'); c.prompt('/bogus')
    expect(out.systems[0]).toBe(HELP_TEXT)
    expect(out.systems[1]).toContain('unknown command')
  })
  it('updates settings for /cd, /model, /new and reports status', () => {
    const out = fakeOut(); const changes: unknown[] = []
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: { ...settings(), sessionId: 'old' }, onSettingsChange: s => changes.push({ ...s }) })
    c.prompt('/cd D:\\w'); c.prompt('/model sonnet'); c.prompt('/new')
    expect(c.status()).toEqual({ model: 'sonnet', workspace: 'D:\\w', session: 'new' })
    expect(changes.length).toBe(3)
    expect(out.statuses.length).toBe(3)
  })
  it('refuses a second prompt while busy and /stop stops the brain', async () => {
    const out = fakeOut()
    let release!: () => void
    const brain: Brain & { stopped: number } = { stopped: 0,
      async *respond() { yield { type: 'text', delta: 'x' }; await new Promise<void>(r => { release = r }); yield { type: 'done' } },
      stop() { this.stopped++ } }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('one')
    await new Promise(r => setTimeout(r, 5))
    expect(c.busy).toBe(true)
    c.prompt('two')
    expect(out.systems.at(-1)).toContain('/stop')
    c.prompt('/stop')
    expect(brain.stopped).toBe(1)
    release()
    await new Promise(r => setTimeout(r, 5))
    expect(c.busy).toBe(false)
  })
  it('reports a brain error with the pack error line', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'done', error: 'boom' }]), actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('hello')
    await new Promise(r => setTimeout(r, 10))
    expect(out.systems.at(-1)).toContain('boom')
  })
})
```

- [ ] **Step 5: Write `src/main/chat.ts`**

```ts
import type { ChatActivityPayload, ChatDonePayload, ChatStatusPayload } from '../shared/ipc'
import type { PackData } from '../shared/types'
import type { BuddyActions } from './actions'
import type { Brain } from './brain/types'
import type { ChatPort } from './ipc'
import { HELP_TEXT, parseCommand, type Command } from './commands'
import { pickLine } from './pack'

export interface ChatOut {
  delta(text: string): void
  activity(a: ChatActivityPayload): void
  done(d: ChatDonePayload): void
  system(text: string): void
  status(s: ChatStatusPayload): void
}
export interface ChatSettings { workspace: string; model: string | null; sessionId: string | null }

export class ChatController implements ChatPort {
  private running = false
  private readonly settings: ChatSettings
  constructor(private readonly deps: { brain: Brain; actions: BuddyActions; pack: PackData; out: ChatOut;
    settings: ChatSettings; onSettingsChange?: (s: ChatSettings) => void }) {
    this.settings = { ...deps.settings }
  }
  get busy(): boolean { return this.running }
  status(): ChatStatusPayload {
    return { model: this.settings.model, workspace: this.settings.workspace, session: this.settings.sessionId ?? 'new' }
  }
  private settingsChanged(): void {
    this.deps.onSettingsChange?.({ ...this.settings })
    this.deps.out.status(this.status())
  }

  prompt(text: string): void {
    const parsed = parseCommand(text)
    if (parsed.ok) { this.run(parsed.command); return }
    if ('error' in parsed) { this.deps.out.system(parsed.error); return }
    if (this.running) { this.deps.out.system('Still working. Use /stop to abort the current rite.'); return }
    void this.ask(text.trim())
  }

  private run(cmd: Command): void {
    const a = this.deps.actions
    switch (cmd.kind) {
      case 'goto': void a.goTo(cmd.x, { run: cmd.run }); break
      case 'mood': a.setMood(cmd.mood); break
      case 'emote': void a.emote(cmd.emote); break
      case 'sleep': a.sleep(); break
      case 'wake': a.wake(); break
      case 'stop': this.stop(); break
      case 'help': this.deps.out.system(HELP_TEXT); break
      case 'new': this.settings.sessionId = null; this.settingsChanged(); break
      case 'cd': this.settings.workspace = cmd.path; this.settingsChanged(); break
      case 'model': this.settings.model = cmd.model; this.settingsChanged(); break
    }
  }

  private async ask(text: string): Promise<void> {
    this.running = true
    try {
      const ctx = { state: this.deps.actions.getState(), workspace: this.settings.workspace,
        model: this.settings.model, sessionId: this.settings.sessionId }
      for await (const ev of this.deps.brain.respond(text, ctx)) {
        if (ev.type === 'text') this.deps.out.delta(ev.delta)
        else if (ev.type === 'activity') this.deps.out.activity({ id: ev.id, label: ev.label, done: ev.done ?? false })
        else if (ev.type === 'status') this.deps.out.system(ev.text)
        else if (ev.type === 'done') {
          if (ev.sessionId) { this.settings.sessionId = ev.sessionId; this.settingsChanged() }
          if (ev.error) this.deps.out.system(`${pickLine(this.deps.pack, 'error') ?? 'Error.'} ${ev.error}`)
          this.deps.out.done({ error: ev.error })
        }
      }
    } catch (e) {
      this.deps.out.system(`${pickLine(this.deps.pack, 'error') ?? 'Error.'} ${(e as Error).message}`)
      this.deps.out.done({ error: (e as Error).message })
    } finally {
      this.running = false
    }
  }

  permissionAnswer(_id: string, _allow: boolean): void { /* Plan B */ }
  stop(): void { this.deps.brain.stop() }
}
```

Run: `npx vitest run src/main/chat.test.ts`
Expected: 6 PASS.

- [ ] **Step 6: Write the failing markdown test and the renderer module**

`src/renderer/hologram/markdown.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders markdown and strips scripts', () => {
    const html = renderMarkdown('# Hi\n\n<script>alert(1)</script>**bold**')
    expect(html).toContain('<h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('<script')
  })
  it('highlights fenced code', () => {
    const html = renderMarkdown('```ts\nconst x: number = 1\n```')
    expect(html).toContain('<pre><code class="hljs language-ts">')
    expect(html).toContain('hljs-keyword')
  })
})
```

`src/renderer/hologram/markdown.ts`:

```ts
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import plaintext from 'highlight.js/lib/languages/plaintext'

hljs.registerLanguage('typescript', typescript); hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('javascript', javascript); hljs.registerLanguage('js', javascript)
hljs.registerLanguage('python', python); hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json); hljs.registerLanguage('plaintext', plaintext)

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      const body = hljs.highlight(text, { language }).value
      return `<pre><code class="hljs language-${language}">${body}</code></pre>\n`
    },
  },
})

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}
```

Run: `npx vitest run src/renderer/hologram/markdown.test.ts`
Expected: 2 PASS. If the `code` renderer signature errors under your marked version, check its changelog: v12 and earlier use `(code, lang)` positional arguments.

- [ ] **Step 7: Write the hologram page**

`src/renderer/hologram/index.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self' http://localhost:* ws://localhost:*; img-src 'self' pack: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:">
  <title>hologram</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <div id="root">
    <div id="cone"></div>
    <div id="panel">
      <div id="title"><span id="name"></span><span id="status"></span></div>
      <div id="log"></div>
      <div id="permission" hidden>
        <div id="perm-line"></div>
        <div id="perm-detail"></div>
        <div class="perm-buttons"><button id="perm-allow">Sanction</button><button id="perm-deny">Deny</button></div>
      </div>
      <textarea id="input" rows="1" placeholder="Speak, operator. /help for rites."></textarea>
    </div>
  </div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

`src/renderer/hologram/styles.css`:

```css
:root { --accent: #37c4ff; --glow: #1a8fd1; --bg: rgba(6, 20, 32, 0.82); --text: #d8f4ff; --font: 'Cascadia Mono', Consolas, monospace; }
html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; font-family: var(--font); color: var(--text); font-size: 13px; }
#root { position: relative; width: 100%; height: 100%; }
#cone { position: absolute; left: 0; bottom: 0; width: 100%; height: 100%; pointer-events: none;
  background: linear-gradient(to top, color-mix(in srgb, var(--accent) 35%, transparent), transparent 60%);
  clip-path: polygon(46% 100%, 54% 100%, 100% 12%, 0 12%); opacity: 0.6; }
#panel { position: absolute; left: 8px; right: 8px; top: 8px; bottom: 44px; display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--accent); box-shadow: 0 0 18px var(--glow), inset 0 0 40px rgba(0,0,0,0.35); border-radius: 4px; overflow: hidden; }
#panel::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(to bottom, transparent 0 2px, rgba(0,0,0,0.12) 2px 3px); }
#title { display: flex; justify-content: space-between; padding: 4px 8px; border-bottom: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
#status { opacity: 0.7; }
#log { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.msg { max-width: 92%; padding: 6px 8px; border-radius: 4px; line-height: 1.35; word-wrap: break-word; }
.msg.user { align-self: flex-end; background: color-mix(in srgb, var(--accent) 18%, transparent); }
.msg.buddy { align-self: flex-start; background: rgba(255,255,255,0.05); }
.msg.system { align-self: center; opacity: 0.75; font-size: 12px; white-space: pre-wrap; }
.msg pre { background: rgba(0,0,0,0.45); padding: 6px; border-radius: 3px; overflow-x: auto; }
.msg code { font-family: var(--font); font-size: 12px; }
.activity { font-size: 11px; opacity: 0.7; padding-left: 8px; }
.activity.done { opacity: 0.45; }
.activity::before { content: '▸ '; color: var(--accent); }
#permission { padding: 8px; border-top: 1px solid var(--accent); background: rgba(255, 120, 40, 0.12); }
#perm-detail { font-size: 12px; opacity: 0.85; margin: 4px 0; white-space: pre-wrap; }
.perm-buttons button { font-family: var(--font); background: transparent; color: var(--text); border: 1px solid var(--accent); padding: 3px 10px; margin-right: 6px; cursor: pointer; }
#input { border: none; border-top: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); background: rgba(0,0,0,0.3); color: var(--text); font-family: var(--font); font-size: 13px; padding: 6px 8px; resize: none; outline: none; }
.hljs-keyword { color: #ff9f6b; } .hljs-string { color: #9bffb0; } .hljs-comment { color: #7a8c99; } .hljs-number { color: #ffd479; } .hljs-title { color: #7fdcff; }
```

`src/renderer/hologram/main.ts`:

```ts
import { renderMarkdown } from './markdown'
import type { ChatPermissionPayload, ThemePayload } from '../../shared/ipc'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const log = $<HTMLDivElement>('log'), input = $<HTMLTextAreaElement>('input'), status = $<HTMLSpanElement>('status')
const perm = $<HTMLDivElement>('permission'), permLine = $<HTMLDivElement>('perm-line'), permDetail = $<HTMLDivElement>('perm-detail')
let current: HTMLDivElement | null = null
let buffer = ''
let renderQueued = false
let lastInput = ''
let pending: ChatPermissionPayload | null = null
const activities = new Map<string, HTMLDivElement>()

function add(cls: string, html: string): HTMLDivElement {
  const el = document.createElement('div'); el.className = `msg ${cls}`; el.innerHTML = html
  log.appendChild(el); log.scrollTop = log.scrollHeight; return el
}
function flush(): void {
  renderQueued = false
  if (current) { current.innerHTML = renderMarkdown(buffer); log.scrollTop = log.scrollHeight }
}

window.buddy.onTheme((t: ThemePayload) => {
  const r = document.documentElement.style
  r.setProperty('--accent', t.accent); r.setProperty('--glow', t.glow); r.setProperty('--bg', t.background)
  r.setProperty('--text', t.text); r.setProperty('--font', t.font)
  $('name').textContent = t.name
})
window.buddy.onChatStatus((s) => {
  status.textContent = `${s.model ?? 'default'} · ${s.workspace} · ${s.session}${s.error ? ' · ' + s.error : ''}`
})
window.buddy.onChatDelta(({ text }) => {
  if (!current) { current = add('buddy', ''); buffer = '' }
  buffer += text
  if (!renderQueued) { renderQueued = true; requestAnimationFrame(flush) }
})
window.buddy.onChatActivity((a) => {
  let el = activities.get(a.id)
  if (!el) { el = document.createElement('div'); el.className = 'activity'; activities.set(a.id, el); (current ?? add('buddy', '')).insertAdjacentElement('afterend', el) }
  el.textContent = a.label
  if (a.done) el.classList.add('done')
})
window.buddy.onChatDone(() => { flush(); current = null; buffer = ''; activities.clear() })
window.buddy.onChatSystem(({ text }) => { current = null; add('system', renderMarkdown(text)) })
window.buddy.onChatPermission((p) => {
  pending = p; permLine.textContent = p.line; permDetail.textContent = `${p.toolName}: ${p.summary}`; perm.hidden = false
})
const answer = (allow: boolean) => { if (!pending) return; window.buddy.permissionAnswer(pending.id, allow); pending = null; perm.hidden = true }
$('perm-allow').addEventListener('click', () => answer(true))
$('perm-deny').addEventListener('click', () => answer(false))

input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); if (pending) answer(false); else window.buddy.closePanel(); return }
  if (e.key === 'ArrowUp' && input.value === '') { input.value = lastInput; return }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    lastInput = text; input.value = ''
    if (!text.startsWith('/')) add('user', renderMarkdown(text))
    current = null
    window.buddy.prompt(text)
  }
})
window.addEventListener('focus', () => input.focus())
window.buddy.hologramReady()
input.focus()
```

- [ ] **Step 8: Wire the controller into `src/main/index.ts`**

Add imports:

```ts
import { EchoBrain } from './brain/echo'
import { ChatController } from './chat'
import { saveConfig } from './config'
```

Replace the `status` constant and the `chat` and `status` entries passed to `wireIpc` with:

```ts
  const out = {
    delta: (text: string) => hologram.webContents.send(CH.chatDelta, { text }),
    activity: (a: ChatActivityPayload) => hologram.webContents.send(CH.chatActivity, a),
    done: (d: ChatDonePayload) => hologram.webContents.send(CH.chatDone, d),
    system: (text: string) => hologram.webContents.send(CH.chatSystem, { text }),
    status: (s: ChatStatusPayload) => hologram.webContents.send(CH.chatStatus, s),
  }
  const chat = new ChatController({
    brain: new EchoBrain(pack, actions), actions, pack, out,
    settings: { workspace: config.workspace, model: config.model, sessionId: null },
    onSettingsChange: (s) => { config.workspace = s.workspace; config.model = s.model; saveConfig(configPath, config) },
  })
```

with `configPath` hoisted from the `loadConfig` call, and in `wireIpc`: `chat, status: () => chat.status(),`. Add `ChatActivityPayload`, `ChatDonePayload` to the `../shared/ipc` import. Also pass the greeting on first open: in `host.showPanel`, after `hologram.show()`, if a `greeted` flag is false, set it and call `out.system(pickLine(pack, 'greeting') ?? '')` (import `pickLine` from `./pack`).

- [ ] **Step 9: Run it and verify by eye**

Run: `npm run dev`
Expected: click him; the hologram opens with the pack name in the title, the status row, and the greeting line. Type `hello` and Enter: the echo reply streams in word by word, he plays a happy emote about half the time, and the reply renders markdown. Type `/goto 20`: he walks left and the panel follows. `/help` prints the command list. `/bogus` prints an error. Escape closes.

- [ ] **Step 10: Typecheck, test, commit**

Run: `npm run typecheck && npx vitest run`
Expected: exit 0, all pass.

```bash
git add src/main src/renderer/hologram package.json package-lock.json
git commit -m "feat: hologram panel with markdown, echo brain, chat controller

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Tray icon and right-click context menu

**Files:**
- Create: `src/main/tray.ts`, `src/main/menu.ts`, `packs/mechanicus/tray.png`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `Actions`, `Buddy`, overlay and hologram windows.
- Produces:

```ts
// tray.ts
export function createTray(deps: { packDir: string; name: string; actions: Actions; buddy: Buddy; overlay: BrowserWindow; hologram: BrowserWindow }): Tray
// menu.ts
export function showContextMenu(deps: { actions: Actions; buddy: Buddy; overlay: BrowserWindow }, x: number, y: number): void
```

- [ ] **Step 1: Create the tray icon** (a pack-optional file; the app falls back to an empty icon)

```bash
python -c "from PIL import Image; Image.new('RGBA',(16,16),(55,196,255,255)).save('packs/mechanicus/tray.png')"
```

- [ ] **Step 2: Write `src/main/menu.ts`**

```ts
import { Menu, type BrowserWindow } from 'electron'
import type { Actions } from './actions'
import type { Buddy } from './buddy'

export function buildTemplate(d: { actions: Actions; buddy: Buddy; quit: () => void }): Electron.MenuItemConstructorOptions[] {
  const asleep = d.buddy.getState().asleep
  return [
    { label: 'Go left', click: () => void d.actions.goTo(0) },
    { label: 'Go center', click: () => void d.actions.goTo(0.5) },
    { label: 'Go right', click: () => void d.actions.goTo(1) },
    { type: 'separator' },
    { label: asleep ? 'Wake' : 'Sleep', click: () => (asleep ? d.actions.wake() : d.actions.sleep()) },
    { type: 'separator' },
    { label: 'Quit', click: d.quit },
  ]
}

export function showContextMenu(d: { actions: Actions; buddy: Buddy; overlay: BrowserWindow }, x: number, y: number): void {
  const menu = Menu.buildFromTemplate(buildTemplate({ ...d, quit: () => require('electron').app.quit() }))
  d.overlay.setFocusable(true)
  menu.popup({ window: d.overlay, x, y, callback: () => d.overlay.setFocusable(false) })
}
```

- [ ] **Step 3: Write `src/main/tray.ts`**

```ts
import { app, Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Actions } from './actions'
import type { Buddy } from './buddy'

export function createTray(d: { packDir: string; name: string; actions: Actions; buddy: Buddy; overlay: BrowserWindow; hologram: BrowserWindow }): Tray {
  const iconPath = join(d.packDir, 'tray.png')
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  const tray = new Tray(icon)
  tray.setToolTip(d.name)
  const rebuild = () => {
    const asleep = d.buddy.getState().asleep
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show', click: () => d.overlay.showInactive() },
      { label: 'Hide', click: () => { d.hologram.hide(); d.overlay.hide() } },
      { label: asleep ? 'Wake' : 'Sleep', click: () => (asleep ? d.actions.wake() : d.actions.sleep()) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]))
  }
  rebuild()
  d.buddy.onChange(rebuild)
  return tray
}
```

- [ ] **Step 4: Wire into `src/main/index.ts`**

Import `createTray` and `showContextMenu`. Replace `showContextMenu: () => {}` in the `wireIpc` call with `showContextMenu: (x, y) => showContextMenu({ actions, buddy, overlay }, x, y)`. After `wireIpc(...)`, add `const tray = createTray({ packDir: pack.dir, name: pack.name, actions, buddy, overlay, hologram })` and keep a reference (`void tray`) so it is not garbage collected. Add `app.on('before-quit', () => { overlay.destroy(); hologram.destroy() })` so hidden windows do not block quit.

Renderer error logging (spec section 14): add `import { appendFileSync, mkdirSync } from 'node:fs'`, create `const logDir = join(app.getPath('userData'), 'logs'); mkdirSync(logDir, { recursive: true })` right after `loadConfig`, and after both windows exist:

```ts
  for (const [name, win] of [['overlay', overlay], ['hologram', hologram]] as const) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) appendFileSync(join(logDir, 'renderer.log'), `${new Date().toISOString()} ${name} ${source}:${line} ${message}\n`)
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      appendFileSync(join(logDir, 'renderer.log'), `${new Date().toISOString()} ${name} gone: ${details.reason}\n`)
      loadPage(win, name)
    })
  }
```

with `loadPage` imported from `./windows`. Plan B reuses `logDir` for `cli.log`.

- [ ] **Step 5: Verify by eye**

Run: `npm run dev`
Expected: the tray shows a blue square with the pack name tooltip; Hide removes him, Show restores; Sleep lays him down and the item flips to Wake; right-click on his body pops the context menu with Go left, center, right, and Quit works from both menus.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/main/tray.ts src/main/menu.ts src/main/index.ts packs/mechanicus/tray.png
git commit -m "feat: tray icon and context menu

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Playwright Electron smoke test

**Files:**
- Create: `playwright.config.ts`, `e2e/body.spec.ts`
- Modify: `src/main/index.ts` (test hook), `package.json` (`pretest:e2e` script)

**Interfaces:**
- Consumes: the built app (`npm run build`), `Buddy.getState()`.
- Produces: `globalThis.__buddy` in main when `BUDDY_TEST=1`, for tests only.

- [ ] **Step 1: Add the test hook to `src/main/index.ts`**

After `const buddy = new Buddy(...)`:

```ts
  if (process.env.BUDDY_TEST === '1') (globalThis as { __buddy?: Buddy }).__buddy = buddy
```

- [ ] **Step 2: Write `playwright.config.ts`** and add `"pretest:e2e": "npm run build"` to `package.json` scripts

```ts
import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: 'e2e', timeout: 60000, retries: 0, workers: 1, reporter: 'list' })
```

- [ ] **Step 3: Write `e2e/body.spec.ts`**

```ts
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}

test('overlay sits on the work area bottom, panel opens, /goto moves him, Escape closes', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, BUDDY_TEST: '1' } })
  const overlay = await windowByUrl(app, 'overlay')
  await expect(overlay.locator('#buddy')).toBeAttached()

  const geo = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find(x => !x.isFocusable())!
    return { b: w.getBounds(), wa: screen.getPrimaryDisplay().workArea }
  })
  expect(geo.b.width).toBe(geo.wa.width)
  expect(geo.b.height).toBe(260)
  expect(geo.b.y + geo.b.height).toBe(geo.wa.y + geo.wa.height)

  await app.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  const hologram = await windowByUrl(app, 'hologram')
  await expect.poll(() => app.evaluate(() => (globalThis as { __buddy?: { getState(): { panelOpen: boolean } } }).__buddy!.getState().panelOpen)).toBe(true)

  await hologram.locator('#input').fill('/goto 80')
  await hologram.locator('#input').press('Enter')
  await expect.poll(() => app.evaluate(() => (globalThis as { __buddy?: { getState(): { x: number } } }).__buddy!.getState().x), { timeout: 15000 }).toBeCloseTo(0.8, 5)

  await hologram.locator('#input').fill('hello')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.buddy')).toContainText('hello', { timeout: 15000 })

  await hologram.locator('#input').press('Escape')
  await expect.poll(() => app.evaluate(() => (globalThis as { __buddy?: { getState(): { panelOpen: boolean } } }).__buddy!.getState().panelOpen)).toBe(false)
  await app.close()
})
```

- [ ] **Step 4: Run the e2e test**

Run: `npm run test:e2e`
Expected: 1 passed. If the hologram window is not found, confirm the hologram page URL contains `hologram` (dev URL and file path both do).

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts e2e/body.spec.ts src/main/index.ts package.json
git commit -m "test: playwright electron smoke test for the body

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Done criteria for Plan A

- `npx vitest run` green: commands, pack, mechanicus pack, buddy, config, protocol, geometry, actions, echo, chat, animator, motion, markdown.
- `python -m pytest tools -q` green including the real-sheet test.
- `npm run test:e2e` green.
- Manual checklist passed on Windows 11: click-through on the transparent strip with a window underneath; hover flips interactivity only over his body; DPI or resolution change re-bounds the strip; tray Show, Hide, Sleep, Wake, Quit; right-click menu on his body.
- Plan B (`2026-09-03-mechanicus-buddy-brain.md`) starts from this state.
