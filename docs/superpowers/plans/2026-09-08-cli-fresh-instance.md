# /cli Opens a Fresh CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/cli` (and the menu item Open in Claude Code) opens a brand-new, independent Claude Code in a terminal window in the current workspace: no session sharing, no stand-down, the panel carries on, another `/cli` opens another window, and the window outlives the buddy.

**Architecture:** The hand-off shrinks to fire-and-forget. `Handoff.open({ workspace })` spawns `cmd /c start "Claude Code" /d "<workspace>" "<cliPath>"` detached and unreferenced and returns; there is no `/wait`, no session id, no exit tracking, no stop. The chat controller loses the stand-down state machine, the session minting and the transcript check, and `openCli` posts one confirmation line. Everything else (the menu item, the hook, the cliMissing rule, the tab) stays.

**Tech Stack:** Electron 44, TypeScript strict with `noUncheckedIndexedAccess`, Vitest, Playwright.

Decision (Peter, 2026-09-08): a fresh instance, independent of the buddy, the panel keeps working. Measured the same day from the real electron.exe: a console opened through `start` survives the app's exit whether the wrapper is spawned plain or detached (libuv's job object lets children of `cmd` break away); `detached: true` plus `unref()` is used anyway so the wrapper never holds the event loop.

## Global Constraints

- Launch shape, exactly: file `cmd.exe`, args `['/c', 'start "Claude Code" /d "<workspace>" "<cliPath>"']`, options `{ cwd: workspace, env: childEnv(env), stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, detached: true }`, then `child.unref()`. A hook command (`BUDDY_HANDOFF_CMD`) replaces the launcher and is spawned with `windowsVerbatimArguments: false`, also detached and unreferenced. A path containing a double quote is refused; a trailing separator is stripped except on a drive root.
- Lines, exactly: `Opened Claude Code in a terminal.` on success; the pack's `cliMissing` line (fallback `No Claude Code is installed here.`) with no handoff dep; the pack's error line plus the reason on a refusal or a spawn error, with the `sadness` face.
- Removed for good: the stand-down and every refusal that came with it (`He is in the terminal...`, `Not while he is in the terminal.`, `Already in the terminal.`, `Finish or /stop the current rite first.`, `Back from the terminal.`), the session id minting and `--resume`/`--session-id` flags, `transcriptExists`, `uuid`, `Handoff.active`, `Handoff.stop`, `onExit`, the `stopping` flag, the session id shape check, and `handoff?.stop()` in `before-quit`. `/stop`, `/new`, `/cd`, `/clear` behave exactly as they did before the hand-off existed.
- The echo brain still gets no `Handoff` unless `BUDDY_HANDOFF_CMD` is set; the e2e suite never opens a console.
- No em dashes anywhere. Commits use the repo's identity (`git config user.email` is `phellwege1@gmail.com`; never pass `-c user.email=`) and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work in a git worktree at `C:\repo\mechanicus-buddy-cli2` on branch `cli-fresh` with a `node_modules` junction to the main tree (`cmd //c mklink /J ...`); never `npm ci`, `npm install` or `npm run dev` in the worktree.

## File Structure

- Rewrite `src/main/handoff.ts` and `src/main/handoff.test.ts`.
- Modify `src/main/chat.ts`, `src/main/chat.test.ts` (the hand-off tests), `src/main/index.ts` (drop the transcript checker and the quit stop), `e2e/handoff.spec.ts`, `src/main/commands.ts` (the help line), `README.md` (the `/cli` row and the Tabs paragraph's last sentence), `docs/superpowers/specs/2026-09-07-terminal-handoff-design.md` (sections 1, 3, 4, 5, 7, 8, 10) and one sentence in `docs/superpowers/specs/2026-09-07-cli-tab-design.md` section 1.
- `src/main/brain/process.ts` keeps `killPid` (the tab uses it); `killTree` is no longer imported by the hand-off.

---

### Task 1: The fresh-instance hand-off

**Files:**
- Rewrite: `src/main/handoff.ts`, `src/main/handoff.test.ts`
- Modify: `src/main/chat.ts`, `src/main/chat.test.ts`, `src/main/index.ts`, `e2e/handoff.spec.ts`, `src/main/commands.ts`, `README.md`, `docs/superpowers/specs/2026-09-07-terminal-handoff-design.md`, `docs/superpowers/specs/2026-09-07-cli-tab-design.md`

**Interfaces:**
- Produces: `buildHandoffCommand(cliPath: string, workspace: string): LaunchCommand`; `class Handoff { open(o: HandoffOpen): HandoffResult }` with `HandoffOpen { workspace: string; onError: (message: string) => void }`, `HandoffDeps { cliPath; spawn?; env?; command?: string[] }`, `HandoffResult = { ok: true } | { ok: false; reason: string }`, `LaunchCommand = { ok: true; file; args; verbatim } | { ok: false; reason }`; in `chat.ts` `HandoffPort { open(o: HandoffOpen): HandoffResult }` and `export type { HandoffOpen } from './handoff'`; `ChatController.openCli(): void`.

- [ ] **Step 1: Rewrite the launcher tests**

Replace `src/main/handoff.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { buildHandoffCommand, Handoff, type HandoffDeps } from './handoff'

const CLI = 'C:\\Users\\p\\.local\\bin\\claude.exe'

type FakeChild = EventEmitter & { pid: number; unrefs: number; unref: () => void }
function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.pid = 4242; c.unrefs = 0; c.unref = () => { c.unrefs++ }
  return c
}
function fakeSpawn() {
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = []
  const children: FakeChild[] = []
  const spawn = ((file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options })
    const c = fakeChild(); children.push(c); return c
  }) as unknown as NonNullable<HandoffDeps['spawn']>
  return { spawn, calls, children }
}
const open = (h: Handoff, onError: (m: string) => void = () => {}) => h.open({ workspace: 'C:\\repo', onError })

describe('buildHandoffCommand', () => {
  it('is cmd /c start "Claude Code" /d with the workspace and the cli, nothing else', () => {
    expect(buildHandoffCommand(CLI, 'C:\\repo')).toEqual({
      ok: true, file: 'cmd.exe', verbatim: true,
      args: ['/c', `start "Claude Code" /d "C:\\repo" "${CLI}"`],
    })
  })
  it('quotes carry spaces, a trailing backslash is stripped, a drive root keeps its backslash', () => {
    const spaced = buildHandoffCommand('C:\\Program Files\\claude.exe', 'D:\\my work\\')
    expect(spaced.ok && spaced.args[1]).toBe('start "Claude Code" /d "D:\\my work" "C:\\Program Files\\claude.exe"')
    const root = buildHandoffCommand(CLI, 'C:\\')
    expect(root.ok && root.args[1]).toContain('/d "C:\\"')
  })
  it('refuses a path containing a double quote', () => {
    expect(buildHandoffCommand('C:\\odd"name\\claude.exe', 'C:\\repo')).toEqual({ ok: false, reason: 'a path with a double quote cannot be handed to start' })
    expect(buildHandoffCommand(CLI, 'C:\\odd"dir').ok).toBe(false)
  })
})

describe('Handoff', () => {
  it('spawns the built command detached, hidden, verbatim, stdio ignored, in the workspace, with the scrubbed env, and unrefs it', () => {
    const f = fakeSpawn()
    const h = new Handoff({ cliPath: CLI, spawn: f.spawn, env: { CLAUDECODE: '1', ANTHROPIC_API_KEY: 'k', PATH: 'p' } })
    expect(open(h)).toEqual({ ok: true })
    expect(f.calls[0]?.file).toBe('cmd.exe')
    expect(f.calls[0]?.args[1]).toBe(`start "Claude Code" /d "C:\\repo" "${CLI}"`)
    expect(f.calls[0]?.options).toMatchObject({ cwd: 'C:\\repo', stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, detached: true, env: { PATH: 'p' } })
    expect((f.calls[0]?.options.env as Record<string, unknown>).CLAUDECODE).toBeUndefined()
    expect(f.children[0]?.unrefs).toBe(1)
  })
  it('a hook command replaces the launcher and is not verbatim', () => {
    const f = fakeSpawn()
    const h = new Handoff({ cliPath: CLI, spawn: f.spawn, command: ['node', '-e', 'setTimeout(() => {}, 50)'] })
    expect(open(h)).toEqual({ ok: true })
    expect(f.calls[0]).toMatchObject({ file: 'node', args: ['-e', 'setTimeout(() => {}, 50)'] })
    expect(f.calls[0]?.options).toMatchObject({ windowsVerbatimArguments: false, detached: true })
  })
  it('every open spawns a new window', () => {
    const f = fakeSpawn()
    const h = new Handoff({ cliPath: CLI, spawn: f.spawn })
    open(h); open(h)
    expect(f.calls).toHaveLength(2)
  })
  it('reports a spawn error through onError', () => {
    const f = fakeSpawn(); const errors: string[] = []
    const h = new Handoff({ cliPath: CLI, spawn: f.spawn })
    open(h, (m) => errors.push(m))
    f.children[0]?.emit('error', new Error('ENOENT cmd.exe'))
    expect(errors).toEqual(['ENOENT cmd.exe'])
  })
  it('refuses when the command cannot be built, without spawning', () => {
    const f = fakeSpawn()
    const h = new Handoff({ cliPath: 'C:\\odd"name\\claude.exe', spawn: f.spawn })
    expect(open(h).ok).toBe(false)
    expect(f.calls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/main/handoff.test.ts`
Expected: FAIL, `open` and the two-argument `buildHandoffCommand` do not exist yet.

- [ ] **Step 3: Rewrite the launcher**

Replace `src/main/handoff.ts` with:

```ts
// /cli and the menu item open a brand-new, independent Claude Code in a console window in
// the workspace (spec 2026-09-07-terminal-handoff-design, as revised 2026-09-08). Measured
// on Electron 44: a console program spawned directly by the main process gets no console
// at all, so the launch goes through `cmd /c start`, which opens a real one; and a window
// opened that way survives the app's exit, so nothing here tracks or stops it.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { childEnv } from './brain/claude-cli'

export interface HandoffDeps {
  cliPath: string
  spawn?: typeof nodeSpawn
  env?: NodeJS.ProcessEnv
  // Test hook (BUDDY_HANDOFF_CMD): a full argv that replaces the launcher, so the e2e
  // suite runs a short node process instead of opening a console.
  command?: string[]
}
export interface HandoffOpen { workspace: string; onError: (message: string) => void }
export type HandoffResult = { ok: true } | { ok: false; reason: string }
export type LaunchCommand = { ok: true; file: string; args: string[]; verbatim: boolean } | { ok: false; reason: string }

// cmd /c start "<title>" /d "<dir>" "<program>". The quotes carry paths with spaces; a
// double quote inside a path cannot be passed to start and is refused. A trailing separator
// right before a closing quote would escape it, so it is stripped, except on a drive root,
// where "C:\" is the form start expects.
export function buildHandoffCommand(cliPath: string, workspace: string): LaunchCommand {
  if (cliPath.includes('"') || workspace.includes('"')) return { ok: false, reason: 'a path with a double quote cannot be handed to start' }
  const dir = /^[A-Za-z]:\\$/.test(workspace) ? workspace : workspace.replace(/[\\/]+$/, '')
  return { ok: true, file: 'cmd.exe', args: ['/c', `start "Claude Code" /d "${dir}" "${cliPath}"`], verbatim: true }
}

export class Handoff {
  constructor(private readonly deps: HandoffDeps) {}

  // Fire and forget: the wrapper is detached and unreferenced, so the window is its own
  // process from the first moment and the buddy can quit under it.
  open(o: HandoffOpen): HandoffResult {
    const hook = this.deps.command
    const cmd: LaunchCommand = hook && hook.length > 0
      ? { ok: true, file: hook[0] ?? '', args: hook.slice(1), verbatim: false }
      : buildHandoffCommand(this.deps.cliPath, o.workspace)
    if (!cmd.ok) return cmd
    const spawnFn = this.deps.spawn ?? nodeSpawn
    let child: ChildProcess
    try {
      child = spawnFn(cmd.file, cmd.args, {
        cwd: o.workspace, env: childEnv(this.deps.env ?? process.env), stdio: 'ignore',
        windowsHide: true, windowsVerbatimArguments: cmd.verbatim, detached: true,
      })
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
    child.on('error', (e: Error) => o.onError(e.message))
    child.unref()
    return { ok: true }
  }
}
```

- [ ] **Step 4: Run the launcher tests**

Run: `npx vitest run src/main/handoff.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: The controller tests**

In `src/main/chat.test.ts`, delete every hand-off test added by the earlier plan (the `fakeHandoff` helper, `STAND_DOWN`, and the tests titled `/cli without a handoff posts the cliMissing line`, `/cli mints and persists...`, `/cli resumes an existing session...`, `/cli while a turn runs is refused`, `while in the terminal: ...`, `the return posts the back line...`, `a start refusal posts the error line...`, `openCli is the same path the menu uses`, `/cli after a minted id with no transcript...` and its `transcriptExists` sibling, and the stand-down dropped-images test if present). Change the import to `import type { HandoffOpen, HandoffPort } from './chat'`. Add:

```ts
  function fakeHandoff() {
    const h = { opens: [] as HandoffOpen[], open(o: HandoffOpen) { h.opens.push(o); return { ok: true as const } } }
    return h as typeof h & HandoffPort
  }
  it('/cli without a handoff posts the cliMissing line', () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('/cli')
    const missing = pack.persona.lines.cliMissing ?? []
    expect(missing.length ? missing : ['No Claude Code is installed here.']).toContain(out.systems.at(-1))
  })
  it('/cli opens a fresh CLI in the workspace, confirms, and changes nothing else', () => {
    const out = fakeOut(); const h = fakeHandoff(); const changes: unknown[] = []
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: { ...settings(), sessionId: 'old' }, handoff: h, onSettingsChange: s => changes.push(s) })
    c.prompt('/cli')
    expect(h.opens[0]).toMatchObject({ workspace: 'C:\\repo' })
    expect(out.systems.at(-1)).toBe('Opened Claude Code in a terminal.')
    expect(changes).toEqual([])
    expect(c.status().session).toBe('old')
  })
  it('/cli works during a turn and every time', async () => {
    const out = fakeOut(); const h = fakeHandoff()
    let release!: () => void
    const brain: Brain = { async *respond() { yield { type: 'text', delta: 'x' }; await new Promise<void>(r => { release = r }); yield { type: 'done' } }, stop() {} }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings(), handoff: h })
    c.prompt('one')
    await new Promise(r => setTimeout(r, 5))
    c.prompt('/cli'); c.prompt('/cli')
    expect(h.opens).toHaveLength(2)
    release()
    await new Promise(r => setTimeout(r, 5))
  })
  it('a refusal and a spawn error post the error line', () => {
    const out = fakeOut()
    const h: HandoffPort = { open: (o) => { o.onError('boom'); return { ok: false, reason: 'no console' } } }
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings(), handoff: h })
    c.prompt('/cli')
    expect(out.systems.some(s => s.includes('boom'))).toBe(true)
    expect(out.systems.at(-1)).toContain('no console')
    expect(out.faces.at(-1)).toBe('sadness')
  })
  it('openCli is the same path the menu uses', () => {
    const out = fakeOut(); const h = fakeHandoff()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings(), handoff: h })
    c.openCli()
    expect(h.opens).toHaveLength(1)
  })
```

- [ ] **Step 6: The controller**

In `src/main/chat.ts`: remove `STAND_DOWN`, `NOT_NOW`, the `inTerminal()` helper and every use of it (the check in `prompt`, the `/stop` hand-off branch, the refusals in `new`, `clear`, `cd`), the `transcriptExists` and `uuid` deps and the `randomUUID` import, and the `HandoffStart`/`HandoffResult` imports. Replace them with:

```ts
import type { HandoffOpen, HandoffResult } from './handoff'
// What the chat controller needs from the terminal launcher (src/main/handoff.ts).
export interface HandoffPort { open(o: HandoffOpen): HandoffResult }
export type { HandoffOpen } from './handoff'
```

with the constructor deps keeping `handoff?: HandoffPort`, and `openCli` becoming:

```ts
  // /cli and the menu item: a brand-new Claude Code in a terminal window in the workspace.
  // Independent of the panel and of this session; nothing here waits for it.
  openCli(): void {
    const h = this.deps.handoff
    if (!h) { this.deps.out.system(pickLine(this.deps.pack, 'cliMissing') ?? 'No Claude Code is installed here.'); return }
    const errorLine = (reason: string): void => this.deps.out.system(`${pickLine(this.deps.pack, 'error') ?? 'Error.'} ${reason}`, 'sadness')
    const r = h.open({ workspace: this.settings.workspace, onError: errorLine })
    if (!r.ok) { errorLine(r.reason); return }
    this.deps.out.system('Opened Claude Code in a terminal.')
  }
```

`case 'cli': this.openCli(); break` stays. The dropped-images suffix helper on the busy refusal stays.

In `src/main/index.ts`: remove `transcriptExists: ...` from the `ChatController` deps and `handoff?.stop()` from the `before-quit` handler (the `Handoff` construction and the menu wiring stay). In `src/main/commands.ts` `HELP_TEXT`, the `/cli` line becomes `'/cli            open a fresh Claude Code in a terminal in the workspace (also in his right-click menu)',`.

- [ ] **Step 7: Run the unit suite and typecheck**

Run: `npx vitest run src/main/chat.test.ts src/main/handoff.test.ts src/main/commands.test.ts && npm test && npm run typecheck`
Expected: all green; `state.ts` and `process.ts` are untouched.

- [ ] **Step 8: The e2e**

In `e2e/handoff.spec.ts`, replace the first test with one that proves the launch happened and the panel kept working. The hook program writes a marker file the test names:

```ts
test('/cli launches the hook program in the workspace and the panel carries on', async () => {
  const marker = join(tmpdir(), `buddy-e2e-cli-${process.pid}-${Date.now()}.txt`)
  const hologram = await launch({ BUDDY_HANDOFF_CMD: JSON.stringify([process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.cwd())', marker]) })
  await hologram.locator('#input').fill('/cli')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.system').last()).toHaveText('Opened Claude Code in a terminal.')
  await expect.poll(() => existsSync(marker), { timeout: 10000 }).toBe(true)
  expect(readFileSync(marker, 'utf8').toLowerCase()).toBe(resolve('C:\\repo').toLowerCase())
  rmSync(marker, { force: true })

  await hologram.locator('#input').fill('still here?')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.buddy')).toHaveCount(1, { timeout: 15000 })
})
```

with `existsSync, readFileSync` added to the `node:fs` import and `resolve` to the `node:path` import. The workspace under test is the config default `C:\repo` (the isolated profile writes a fresh config with that default); if the spec's own `launch` sets a different workspace, compare against that instead. The second test (no hook, cliMissing line) stays as it is.

Run: `npm run build && npx playwright test e2e/handoff.spec.ts`
Expected: 2 passed, no console window, `Get-Process electron` count unchanged.

- [ ] **Step 9: Specs and README**

`docs/superpowers/specs/2026-09-07-terminal-handoff-design.md`: add to the status line `Revised 2026-09-08 (Peter): a fresh, independent instance; no session sharing, no stand-down.` Rewrite section 1's last sentences, section 3 (the decision: a fresh instance, independent, the panel carries on; rejected: sharing the session, which the first version did), section 4 (the new command line and options; measured: a `start`-opened console survives the app's exit plain or detached), section 5 (`/cli` at any time, the one confirmation line, the error line, no stand-down), section 7 (drop the edge cases about the shared session; keep that `/cd` inside the terminal does not move the panel), section 8 (the tests above), section 10 (out of scope: sharing the panel's session, tracking or closing the windows). In `docs/superpowers/specs/2026-09-07-cli-tab-design.md` section 1, change the sentence about `/cli` to say it opens a fresh CLI in a terminal window.

`README.md`: the `/cli` row becomes `| \`/cli\` | open a fresh Claude Code in a terminal in the workspace, independent of the panel (also in his right-click menu) |`; the Tabs paragraph's last sentence becomes `\`/cli\` is different: it opens a fresh Claude Code in its own terminal window, independent of the panel.`

- [ ] **Step 10: Full run and commit**

Run: `npm test && npm run typecheck && npm run build && npm run test:e2e`
Expected: all green (418 unit less the removed hand-off tests plus the new ones; 32 e2e).

```bash
git add src/main/handoff.ts src/main/handoff.test.ts src/main/chat.ts src/main/chat.test.ts src/main/index.ts src/main/commands.ts e2e/handoff.spec.ts README.md docs/superpowers/specs/2026-09-07-terminal-handoff-design.md docs/superpowers/specs/2026-09-07-cli-tab-design.md
git commit -m "handoff: /cli opens a fresh, independent Claude Code; no session sharing, no stand-down" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 11: Manual verification (Peter)**

`/cli` twice: two Windows Terminal windows, each a fresh Claude Code in `C:\repo`; the panel answers a question while they are open; Ctrl+Q the buddy: both windows stay.

---

### Task 2: The tab row sits under the title line

**Files:**
- Modify: `src/renderer/hologram/index.html`, `src/renderer/hologram/styles.css`, `docs/superpowers/specs/2026-09-07-cli-tab-design.md` (section 7)

**Interfaces:** none new. The ids and classes the renderer and the e2e suite use (`#tabs`, `.tab[data-tab]`, `#title`, `#cli`, `#panel.cli`) are unchanged.

Decision (Peter, 2026-09-08, from a screenshot): the tabs inside the title row squeeze the name and status onto wrapped lines. Order from the top: the information line (name and status), then a row with the two tabs, then the log and everything below it as before.

- [ ] **Step 1: Markup**

In `src/renderer/hologram/index.html`, take the `<div id="tabs">...</div>` out of the `#title` div so the title line is `<div id="title"><span id="name"></span><span id="status"></span></div>` again, and place the tabs div as the next sibling, directly after `#title` and before `#log`:

```html
      <div id="title"><span id="name"></span><span id="status"></span></div>
      <div id="tabs"><button type="button" class="tab active" data-tab="chat">Chat</button><button type="button" class="tab" data-tab="cli">CLI</button></div>
      <div id="log"></div>
```

- [ ] **Step 2: Styles**

In `src/renderer/hologram/styles.css`, replace the `#tabs` rule and the CLI-mode hide rule:

```css
#tabs { display: flex; gap: 2px; padding: 3px 8px; border-bottom: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
#panel.cli > :not(#title):not(#tabs):not(#cli) { display: none; }
```

The `#tabs .tab` and `#tabs .tab.active` rules stay as they are (they inherit the row's font, spacing and case). The tab row must stay visible on the CLI tab, which the amended hide rule guarantees.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build && npx playwright test e2e/cli-tab.spec.ts`
Expected: clean, 4 passed (the tab spec selects `#tabs .tab[data-tab=...]`, `#panel`, `#cli` and `#input`, none of which moved). Then, with the built renderer, confirm from the spec run that the panel width on the CLI tab is still about 700 and the chat tab about 480.

- [ ] **Step 4: Spec and commit**

In `docs/superpowers/specs/2026-09-07-cli-tab-design.md` section 7, change the first bullet's opening to: "A tab row under the title line with two buttons, `Chat` and `CLI`; the title line keeps the name and status to itself."

```bash
git add src/renderer/hologram/index.html src/renderer/hologram/styles.css docs/superpowers/specs/2026-09-07-cli-tab-design.md
git commit -m "panel: the tab row sits under the title line instead of inside it" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Manual verification (Peter)**

Open the panel: name and status on one line, the two tabs on the line under it, the log below; the status no longer wraps; the CLI tab still widens the panel and keeps the tab row visible.
