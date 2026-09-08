# Terminal Hand-off and CLI Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the real, interactive Claude Code within reach of the panel two ways: `/cli` (and a right-click item) opens it in a terminal window on the panel's own session and the panel stands down until the window closes; a second `CLI` tab in the panel runs it in an embedded terminal on its own session, with the panel widening to fit.

**Architecture:** Both parts spawn the CLI outside the print-mode brain. The hand-off is one `Handoff` class in main that launches `cmd /c start "Claude Code" /wait ...` (the only launch shape that gives the CLI a real console from a GUI parent and still reports its exit) and a stand-down in the chat controller. The tab is a `PtySession` in main over node-pty (prebuilt binaries, no compile), a small IPC surface, `hologramBounds` parameterized by panel size, and xterm.js in the renderer behind a tab strip. Two specs, one branch, hand-off first because it is small and shares nothing with the tab except `childEnv` and the process-tree helper.

**Tech Stack:** Electron 44, node-pty 1.1.0 (runtime dependency, externalized by electron-vite like the MCP SDK), @xterm/xterm 6.0.0 with @xterm/addon-fit 0.11.0, TypeScript strict with `noUncheckedIndexedAccess`, Vitest (node), Playwright `_electron`.

Specs: `docs/superpowers/specs/2026-09-07-terminal-handoff-design.md` (sections cited as H-n) and `docs/superpowers/specs/2026-09-07-cli-tab-design.md` (cited as T-n).

## Global Constraints

- Hand-off launch shape, exactly: file `cmd.exe`, args `['/c', 'start "Claude Code" /wait /d "<workspace>" "<cliPath>" <flag> <id>']`, `flag` is `--resume` for an existing session id and `--session-id` for a minted one, spawned with `windowsVerbatimArguments: true`, `windowsHide: true`, `stdio: 'ignore'`, `cwd` the workspace, env from `childEnv` (H-4). Nothing else on the command line: no MCP config, no tool or permission flags, no model.
- Hand-off lines, exactly: `He is in the terminal. Close it to continue here.`, `Not while he is in the terminal.`, `Already in the terminal.`, `Finish or /stop the current rite first.`, `Back from the terminal.` (H-5).
- Test hooks: `BUDDY_HANDOFF_CMD` and `BUDDY_PTY_CMD` are JSON argv arrays parsed like `BUDDY_CLI_ARGS`; when set they replace the program the hand-off or the tab runs. The e2e suite always sets one of them or runs the echo brain, so it never opens a console or spawns the real CLI.
- Under the echo brain (`BUDDY_BRAIN=echo`, or no CLI on disk) neither the hand-off nor the tab ever runs the real CLI: `/cli` posts the pack's `cliMissing` line and the tab shows it.
- Tab: `CLI_PANEL_SIZE = { width: 700, height: 480 }`; the window is the panel width plus two `CONE_SIDE_MARGIN`s (940) and its top is `charTop - panel.height - PANEL_GAP`, clamped as today; on the chat tab everything returns to `PANEL_SIZE` (T-6). Terminal: `TERM=xterm-256color`, `COLORTERM=truecolor`, scrollback 5000, font from the pack's `--font` at 12 px (T-4, T-7).
- Channels, exactly: `pty:start` (invoke), `pty:input`, `pty:resize`, `pty:kill` (send), `pty:data`, `pty:exit` (events), `hologram:mode` (send), `clipboard:write` (send) (T-5).
- `src/main/pty.ts` and `src/main/handoff.ts` import nothing from node-pty or Electron; `src/main/pty-node.ts` is the only file that imports node-pty. Unit tests run under plain Node with fakes.
- `npm install --save-exact --no-audit --no-fund node-pty@1.1.0 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0` runs exactly once, in Task 4, from the worktree; through the `node_modules` junction it lands in the main tree's `node_modules`, which is intended. Never run `npm ci` in the worktree. Never run `npm run dev` from a worktree cwd.
- Every e2e spec launches on a `BUDDY_USER_DATA` temp profile (already the case on master); a buddy running from the main tree must survive every suite run.
- No em dashes anywhere (code, comments, docs, README, commit messages). Use commas, colons, hyphens.
- Commits use the repo's identity (`git config user.email` is `phellwege1@gmail.com`; never pass `-c user.email=`) and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work in a git worktree at `C:\repo\mechanicus-buddy-cli` on branch `cli-and-tab`, with `cmd //c mklink /J C:\repo\mechanicus-buddy-cli\node_modules C:\repo\mechanicus-buddy\node_modules` as earlier rounds did.
- Commands from the worktree root: `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e` (builds first).

## File Structure

Part A, the hand-off:
- Create `src/main/handoff.ts`: `buildHandoffCommand`, `Handoff` (spawn injectable, `BUDDY_HANDOFF_CMD` hook), and `src/main/handoff.test.ts`.
- Modify `src/main/brain/process.ts`: add `killPid(pid)`; `killTree` keeps its signature.
- Modify `src/main/commands.ts` (`/cli`, help line), `src/main/chat.ts` (`openCli`, the stand-down), their tests.
- Modify `src/main/menu.ts` (the item) and create `src/main/menu.test.ts`.
- Modify `src/main/index.ts` (construct the `Handoff`, pass it to the controller and the menu, kill it on quit).
- Create `e2e/handoff.spec.ts`. Modify `README.md` (the `/cli` row).

Part B, the tab:
- Modify `package.json` and `package-lock.json` (three dependencies).
- Create `src/main/pty.ts` (`PtySession`, `ptyEnv`, the `PtyLike` and `PtyFactory` interfaces), `src/main/pty-node.ts` (`nodePtyFactory`), `src/main/pty.test.ts`.
- Modify `src/main/geometry.ts` (`CLI_PANEL_SIZE`, `hologramBounds(..., panel)`) and its test.
- Modify `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts` (`PtyPort`, `setMode`, `writeClipboard`), `src/main/index.ts` (the session, the port, the panel size ref, quit).
- Modify `src/renderer/hologram/index.html`, `styles.css`, `main.ts` (tab strip, `#cli`, xterm, mode switching, focus).
- Create `e2e/cli-tab.spec.ts`. Modify `README.md` (the tabs paragraph), `src/main/commands.ts` help text.

---

### Task 1: The hand-off launcher

**Files:**
- Create: `src/main/handoff.ts`, `src/main/handoff.test.ts`
- Modify: `src/main/brain/process.ts`

**Interfaces:**
- Consumes: `childEnv(base)` from `src/main/brain/claude-cli.ts`; `killTree(child)` from `src/main/brain/process.ts`.
- Produces: `killPid(pid: number): void`; `buildHandoffCommand(cliPath, workspace, sessionId, fresh): LaunchCommand`; `class Handoff { active; start(s: HandoffStart): HandoffResult; stop(): void }` with `HandoffDeps { cliPath; spawn?; env?; command?: string[]; kill?: (child: ChildProcess) => void }`, `HandoffStart { sessionId; fresh; workspace; onExit(error?: string) }`, `HandoffResult = { ok: true } | { ok: false; reason: string }`, `LaunchCommand = { ok: true; file; args; verbatim: boolean } | { ok: false; reason }`.

- [ ] **Step 1: Add `killPid` beside `killTree`**

Replace `src/main/brain/process.ts` with:

```ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

// Kills a process and everything it spawned by pid. Windows has no process groups, so
// taskkill walks the tree; the spawn is best effort and must never throw or leave a handle
// behind. Elsewhere a plain signal is enough for the callers here.
export function killPid(pid: number): void {
  if (process.platform === 'win32') {
    const killer = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('error', () => { /* best effort only */ })
  } else {
    try { process.kill(pid) } catch { /* already gone */ }
  }
}

// Kills a CLI child and everything it spawned. Same rules as killPid, taking the child so a
// process that already exited is left alone.
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') killPid(child.pid)
  else child.kill()
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/main/handoff.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { buildHandoffCommand, Handoff, type HandoffDeps } from './handoff'

const CLI = 'C:\\Users\\p\\.local\\bin\\claude.exe'

type FakeChild = EventEmitter & { pid: number; exitCode: number | null }
function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.pid = 4242; c.exitCode = null
  return c
}
// Records every spawn and hands back a fake child the test can close or fail.
function fakeSpawn() {
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = []
  const children: FakeChild[] = []
  const spawn = ((file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options })
    const c = fakeChild(); children.push(c); return c
  }) as unknown as NonNullable<HandoffDeps['spawn']>
  return { spawn, calls, children }
}
const start = (h: Handoff, onExit: (e?: string) => void = () => {}, sessionId = 'sess-1', fresh = false) =>
  h.start({ sessionId, fresh, workspace: 'C:\\repo', onExit })

describe('buildHandoffCommand', () => {
  it('is cmd /c start "Claude Code" /wait with the workspace, the cli and --resume', () => {
    expect(buildHandoffCommand(CLI, 'C:\\repo', 'sess-1', false)).toEqual({
      ok: true, file: 'cmd.exe', verbatim: true,
      args: ['/c', `start "Claude Code" /wait /d "C:\\repo" "${CLI}" --resume sess-1`],
    })
  })
  it('uses --session-id for a minted session', () => {
    const r = buildHandoffCommand(CLI, 'C:\\repo', 'new-1', true)
    expect(r.ok && r.args[1]).toContain('--session-id new-1')
  })
  it('quotes carry spaces, a trailing backslash is stripped, a drive root keeps its backslash', () => {
    const spaced = buildHandoffCommand('C:\\Program Files\\claude.exe', 'D:\\my work\\', 's', false)
    expect(spaced.ok && spaced.args[1]).toBe('start "Claude Code" /wait /d "D:\\my work" "C:\\Program Files\\claude.exe" --resume s')
    const root = buildHandoffCommand(CLI, 'C:\\', 's', false)
    expect(root.ok && root.args[1]).toContain('/d "C:\\"')
  })
  it('refuses a path containing a double quote', () => {
    expect(buildHandoffCommand('C:\\odd"name\\claude.exe', 'C:\\repo', 's', false)).toEqual({ ok: false, reason: 'a path with a double quote cannot be handed to start' })
    expect(buildHandoffCommand(CLI, 'C:\\odd"dir', 's', false).ok).toBe(false)
  })
})

describe('Handoff', () => {
  it('spawns the built command hidden, verbatim, with stdio ignored, in the workspace, with the scrubbed env', () => {
    const f = fakeSpawn()
    const h = new Handoff({ cliPath: CLI, spawn: f.spawn, env: { CLAUDECODE: '1', ANTHROPIC_API_KEY: 'k', PATH: 'p' } })
    expect(start(h)).toEqual({ ok: true })
    expect(h.active).toBe(true)
    expect(f.calls[0]?.file).toBe('cmd.exe')
    expect(f.calls[0]?.args[1]).toContain('--resume sess-1')
    expect(f.calls[0]?.options).toMatchObject({ cwd: 'C:\\repo', stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env: { PATH: 'p' } })
    expect((f.calls[0]?.options.env as Record<string, unknown>).CLAUDECODE).toBeUndefined()
  })
  it('a hook command replaces the launcher and is not verbatim', () => {
    const f = fakeSpawn()
    const h = new Handoff({ cliPath: CLI, spawn: f.spawn, command: ['node', '-e', 'setTimeout(() => {}, 50)'] })
    expect(start(h)).toEqual({ ok: true })
    expect(f.calls[0]).toMatchObject({ file: 'node', args: ['-e', 'setTimeout(() => {}, 50)'] })
    expect(f.calls[0]?.options.windowsVerbatimArguments).toBe(false)
  })
  it('refuses a second start while one is active', () => {
    const f = fakeSpawn()
    const h = new Handoff({ cliPath: CLI, spawn: f.spawn })
    start(h)
    expect(start(h)).toEqual({ ok: false, reason: 'already in the terminal' })
    expect(f.calls).toHaveLength(1)
  })
  it('reports the exit once with no error when the wrapper closes', () => {
    const f = fakeSpawn(); const exits: (string | undefined)[] = []
    const h = new Handoff({ cliPath: CLI, spawn: f.spawn })
    start(h, (e) => exits.push(e))
    f.children[0]?.emit('close', 0)
    f.children[0]?.emit('close', 0)
    expect(exits).toEqual([undefined])
    expect(h.active).toBe(false)
  })
  it('reports a spawn error as the exit reason', () => {
    const f = fakeSpawn(); const exits: (string | undefined)[] = []
    const h = new Handoff({ cliPath: CLI, spawn: f.spawn })
    start(h, (e) => exits.push(e))
    f.children[0]?.emit('error', new Error('ENOENT cmd.exe'))
    expect(exits).toEqual(['ENOENT cmd.exe'])
    expect(h.active).toBe(false)
  })
  it('refuses when the command cannot be built, without spawning', () => {
    const f = fakeSpawn()
    const h = new Handoff({ cliPath: 'C:\\odd"name\\claude.exe', spawn: f.spawn })
    expect(start(h).ok).toBe(false)
    expect(f.calls).toHaveLength(0)
  })
  it('stop kills the wrapper tree through the injected killer', () => {
    const f = fakeSpawn(); const killed: number[] = []
    const h = new Handoff({ cliPath: CLI, spawn: f.spawn, kill: (c: ChildProcess) => killed.push(c.pid ?? -1) })
    start(h)
    h.stop()
    expect(killed).toEqual([4242])
    h.stop()
    expect(killed).toEqual([4242])
    f.children[0]?.emit('close', 1)
    h.stop()
    expect(killed).toEqual([4242])
  })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run src/main/handoff.test.ts`
Expected: FAIL, cannot find module `./handoff`.

- [ ] **Step 4: Write handoff.ts**

Create `src/main/handoff.ts`:

```ts
// The terminal hand-off (spec 2026-09-07-terminal-handoff-design): /cli opens the real
// Claude Code in a console window on the panel's own session. Measured on Electron 44: a
// console program spawned directly by the main process gets no console at all, and
// `cmd /c start "" /wait <program>` opens a real one whose exit is the wrapper's exit, so
// that is the launch shape. Windows Terminal takes the window when it is the default
// terminal; conhost otherwise; nothing here depends on which.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { childEnv } from './brain/claude-cli'
import { killTree } from './brain/process'

export interface HandoffDeps {
  cliPath: string
  spawn?: typeof nodeSpawn
  env?: NodeJS.ProcessEnv
  // Test hook (BUDDY_HANDOFF_CMD): a full argv that replaces the launcher, so the e2e
  // suite runs a short-lived node process instead of opening a console.
  command?: string[]
  kill?: (child: ChildProcess) => void
}
export interface HandoffStart { sessionId: string; fresh: boolean; workspace: string; onExit: (error?: string) => void }
export type HandoffResult = { ok: true } | { ok: false; reason: string }
export type LaunchCommand = { ok: true; file: string; args: string[]; verbatim: boolean } | { ok: false; reason: string }

// cmd /c start "<title>" /wait /d "<dir>" "<program>" <flag> <id>. The quotes carry paths
// with spaces; a double quote inside a path cannot be passed to start and is refused. A
// trailing backslash right before a closing quote would escape it, so it is stripped,
// except on a drive root, where "C:\" is the form start expects.
export function buildHandoffCommand(cliPath: string, workspace: string, sessionId: string, fresh: boolean): LaunchCommand {
  if (cliPath.includes('"') || workspace.includes('"')) return { ok: false, reason: 'a path with a double quote cannot be handed to start' }
  const dir = /^[A-Za-z]:\\$/.test(workspace) ? workspace : workspace.replace(/[\\/]+$/, '')
  const flag = fresh ? '--session-id' : '--resume'
  return { ok: true, file: 'cmd.exe', args: ['/c', `start "Claude Code" /wait /d "${dir}" "${cliPath}" ${flag} ${sessionId}`], verbatim: true }
}

export class Handoff {
  private child: ChildProcess | null = null
  constructor(private readonly deps: HandoffDeps) {}
  get active(): boolean { return this.child !== null }

  start(s: HandoffStart): HandoffResult {
    if (this.child) return { ok: false, reason: 'already in the terminal' }
    const hook = this.deps.command
    const cmd: LaunchCommand = hook && hook.length > 0
      ? { ok: true, file: hook[0] ?? '', args: hook.slice(1), verbatim: false }
      : buildHandoffCommand(this.deps.cliPath, s.workspace, s.sessionId, s.fresh)
    if (!cmd.ok) return cmd
    const spawnFn = this.deps.spawn ?? nodeSpawn
    let child: ChildProcess
    try {
      child = spawnFn(cmd.file, cmd.args, {
        cwd: s.workspace, env: childEnv(this.deps.env ?? process.env), stdio: 'ignore',
        windowsHide: true, windowsVerbatimArguments: cmd.verbatim,
      })
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
    this.child = child
    // One settle per start: a spawn error and a later close must not both report.
    let settled = false
    const settle = (error?: string): void => {
      if (settled) return
      settled = true
      this.child = null
      s.onExit(error)
    }
    child.on('error', (e: Error) => settle(e.message))
    child.on('close', () => settle())
    return { ok: true }
  }

  // Kills the wrapper's tree; the CLI is inside it. Idempotent, and a no-op once the
  // wrapper has closed.
  stop(): void {
    const child = this.child
    if (!child) return
    ;(this.deps.kill ?? killTree)(child)
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/main/handoff.test.ts src/main/brain && npm run typecheck`
Expected: PASS, 11 handoff tests; everything under `brain` unchanged; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/handoff.ts src/main/handoff.test.ts src/main/brain/process.ts
git commit -m "handoff: launch the real CLI in a console window through start /wait, exit observed" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `/cli` and the stand-down in the chat controller

**Files:**
- Modify: `src/main/commands.ts`, `src/main/commands.test.ts`, `src/main/chat.ts`, `src/main/chat.test.ts`

**Interfaces:**
- Consumes: `Handoff`'s shape from Task 1 as `HandoffPort { readonly active: boolean; start(s: HandoffStart): HandoffResult; stop(): void }`.
- Produces: `Command` gains `{ kind: 'cli' }`; `ChatController` deps gain `handoff?: HandoffPort` and `uuid?: () => string`; `ChatController.openCli(): void`.

- [ ] **Step 1: Write the failing tests**

In `src/main/commands.test.ts`, add inside `describe('parseCommand', ...)`:

```ts
  it('parses /cli and refuses arguments', () => {
    expect(parseCommand('/cli')).toEqual({ ok: true, command: { kind: 'cli' } })
    expect(parseCommand('/cli now')).toEqual({ ok: false, error: 'usage: /cli' })
  })
```

In `src/main/chat.test.ts`, add the imports `import type { HandoffPort, HandoffStart } from './chat'` and, inside `describe('ChatController', ...)`, this helper and these tests:

```ts
  function fakeHandoff() {
    const h = { active: false, starts: [] as HandoffStart[], stopped: 0,
      start(s: HandoffStart) { h.starts.push(s); h.active = true; return { ok: true as const } },
      stop() { h.stopped++ },
      exit(error?: string) { h.active = false; h.starts.at(-1)?.onExit(error) } }
    return h as typeof h & HandoffPort
  }
  const STAND_DOWN = 'He is in the terminal. Close it to continue here.'

  it('/cli without a handoff posts the cliMissing line', () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('/cli')
    const missing = pack.persona.lines.cliMissing ?? []
    expect(missing.length ? missing : ['No Claude Code is installed here.']).toContain(out.systems.at(-1))
  })
  it('/cli mints and persists a session id when there is none, and starts fresh', () => {
    const out = fakeOut(); const h = fakeHandoff(); const changes: unknown[] = []
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings(), handoff: h, uuid: () => 'u1', onSettingsChange: s => changes.push({ ...s }) })
    c.prompt('/cli')
    expect(h.starts[0]).toMatchObject({ sessionId: 'u1', fresh: true, workspace: 'C:\\repo' })
    expect(changes.at(-1)).toMatchObject({ sessionId: 'u1' })
    expect(c.status().session).toBe('u1')
    expect(out.systems.at(-1)).toBe(STAND_DOWN)
  })
  it('/cli resumes an existing session without touching settings', () => {
    const out = fakeOut(); const h = fakeHandoff(); const changes: unknown[] = []
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: { ...settings(), sessionId: 'old' }, handoff: h, onSettingsChange: s => changes.push(s) })
    c.prompt('/cli')
    expect(h.starts[0]).toMatchObject({ sessionId: 'old', fresh: false })
    expect(changes).toEqual([])
  })
  it('/cli while a turn runs is refused', async () => {
    const out = fakeOut(); const h = fakeHandoff()
    let release!: () => void
    const brain: Brain = { async *respond() { yield { type: 'text', delta: 'x' }; await new Promise<void>(r => { release = r }); yield { type: 'done' } }, stop() {} }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings(), handoff: h })
    c.prompt('one')
    await new Promise(r => setTimeout(r, 5))
    c.prompt('/cli')
    expect(out.systems.at(-1)).toBe('Finish or /stop the current rite first.')
    expect(h.starts).toEqual([])
    release()
    await new Promise(r => setTimeout(r, 5))
  })
  it('while in the terminal: prompts, /new, /cd, /clear are refused, body commands run, /cli is already, /stop ends it', () => {
    const out = fakeOut(); const h = fakeHandoff(); const a = fakeActions(); const prompts: unknown[] = []
    const brain: Brain = { async *respond(p) { prompts.push(p); yield { type: 'done' } }, stop() {} }
    const c = new ChatController({ brain, actions: a, pack, out, fs: permissiveFs, settings: { ...settings(), sessionId: 'old' }, handoff: h })
    c.prompt('/cli')
    c.prompt('hello there')
    expect(out.systems.at(-1)).toBe(STAND_DOWN)
    expect(prompts).toEqual([])
    c.prompt('/new'); expect(out.systems.at(-1)).toBe('Not while he is in the terminal.')
    c.prompt('/cd D:\\w'); expect(out.systems.at(-1)).toBe('Not while he is in the terminal.')
    c.prompt('/clear'); expect(out.systems.at(-1)).toBe('Not while he is in the terminal.')
    expect(c.status()).toMatchObject({ session: 'old', workspace: 'C:\\repo' })
    expect(out.clears).toBe(0)
    c.prompt('/mood happy'); expect(a.calls).toContain('mood happy')
    c.prompt('/cli'); expect(out.systems.at(-1)).toBe('Already in the terminal.')
    c.prompt('/stop')
    expect(h.stopped).toBe(1)
    const stopped = pack.persona.lines.stopped ?? []
    expect(stopped.length ? stopped : ['stopped']).toContain(out.systems.at(-1))
  })
  it('the return posts the back line and a status; an exit error posts the error line', () => {
    const out = fakeOut(); const h = fakeHandoff()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: { ...settings(), sessionId: 'old' }, handoff: h })
    c.prompt('/cli')
    const statuses = out.statuses.length
    h.exit()
    expect(out.systems.at(-1)).toBe('Back from the terminal.')
    expect(out.statuses.length).toBe(statuses + 1)
    c.prompt('/cli')
    h.exit('spawn failed')
    expect(out.systems.at(-1)).toContain('spawn failed')
    expect(out.faces.at(-1)).toBe('sadness')
  })
  it('a start refusal posts the error line and leaves the panel usable', () => {
    const out = fakeOut(); const prompts: unknown[] = []
    const h: HandoffPort = { active: false, start: () => ({ ok: false, reason: 'no console' }), stop() {} }
    const brain: Brain = { async *respond(p) { prompts.push(p); yield { type: 'done' } }, stop() {} }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: { ...settings(), sessionId: 'old' }, handoff: h })
    c.prompt('/cli')
    expect(out.systems.at(-1)).toContain('no console')
    c.prompt('still here')
    expect(out.systems.at(-1)).toContain('no console')
  })
  it('openCli is the same path the menu uses', () => {
    const out = fakeOut(); const h = fakeHandoff()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: { ...settings(), sessionId: 'old' }, handoff: h })
    c.openCli()
    expect(h.starts).toHaveLength(1)
    expect(out.systems.at(-1)).toBe(STAND_DOWN)
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/main/commands.test.ts src/main/chat.test.ts`
Expected: FAIL, `/cli` is an unknown command and `HandoffPort` does not exist.

- [ ] **Step 3: The command and the help line**

In `src/main/commands.ts`: add `| { kind: 'cli' }` to the `Command` union (after `{ kind: 'help' }`); in `HELP_TEXT` add, before the `/help` line, `'/cli            open the real Claude Code in a terminal on this session; the panel waits until it closes',`; in `parseCommand`'s switch add before `default:`:

```ts
    case 'cli':
      if (arg !== undefined) return { ok: false, error: 'usage: /cli' }
      return { ok: true, command: { kind: 'cli' } }
```

- [ ] **Step 4: The controller**

In `src/main/chat.ts`:

Add the imports:

```ts
import { randomUUID } from 'node:crypto'
import type { HandoffResult, HandoffStart } from './handoff'
```

Add after the `ChatSettings` interface:

```ts
// What the chat controller needs from the terminal hand-off (src/main/handoff.ts).
export interface HandoffPort { readonly active: boolean; start(s: HandoffStart): HandoffResult; stop(): void }
export type { HandoffStart } from './handoff'
const STAND_DOWN = 'He is in the terminal. Close it to continue here.'
const NOT_NOW = 'Not while he is in the terminal.'
```

Extend the constructor's deps type with `handoff?: HandoffPort; uuid?: () => string;` (after `log?`).

In `prompt`, after the two `parsed` checks and before `const content = ...`, add:

```ts
    // The real CLI holds this session in a terminal window (spec H-5): nothing is sent or
    // steered until it closes.
    if (this.deps.handoff?.active) { this.deps.out.system(STAND_DOWN); return }
```

In `run`, change the `stop`, `new`, `clear` and `cd` cases and add `cli`:

```ts
      case 'stop':
        if (this.deps.handoff?.active) { this.deps.handoff.stop(); this.deps.out.system(pickLine(this.deps.pack, 'stopped') ?? 'stopped'); break }
        this.stop()
        this.deps.out.system(pickLine(this.deps.pack, 'stopped') ?? 'stopped')
        break
      case 'help': this.deps.out.system(HELP_TEXT); break
      case 'cli': this.openCli(); break
      case 'new':
        if (this.deps.handoff?.active) { this.deps.out.system(NOT_NOW); break }
        this.turnSerial++; this.settings.sessionId = null; this.settingsChanged()
        this.deps.out.system('new session')
        break
      case 'clear':
        if (this.deps.handoff?.active) { this.deps.out.system(NOT_NOW); break }
        // Everything /new does (a fresh session, which also drops the session allow-list via
        // settingsChanged), plus wiping the panel's own log.
        this.turnSerial++; this.settings.sessionId = null; this.settingsChanged()
        this.deps.out.clear()
        this.deps.out.system('cleared')
        break
      case 'cd': {
        if (cmd.path === null) { this.deps.out.system(`workspace: ${this.settings.workspace}`); break }
        if (this.deps.handoff?.active) { this.deps.out.system(NOT_NOW); break }
        const target = this.resolvePath(cmd.path)
```

(the rest of `cd` unchanged). Add the method after `run`:

```ts
  // /cli and the menu item: the real CLI in a terminal on this session (spec H-5). A
  // session id is minted here when there is none yet, so the terminal and the panel share
  // the conversation from its first word; it is persisted like any other id.
  openCli(): void {
    const h = this.deps.handoff
    if (!h) { this.deps.out.system(pickLine(this.deps.pack, 'cliMissing') ?? 'No Claude Code is installed here.'); return }
    if (h.active) { this.deps.out.system('Already in the terminal.'); return }
    if (this.running) { this.deps.out.system('Finish or /stop the current rite first.'); return }
    const fresh = this.settings.sessionId === null
    const sessionId = this.settings.sessionId ?? (this.deps.uuid ?? randomUUID)()
    if (fresh) { this.settings.sessionId = sessionId; this.settingsChanged() }
    const r = h.start({
      sessionId, fresh, workspace: this.settings.workspace,
      onExit: (error) => {
        if (error) this.deps.out.system(`${pickLine(this.deps.pack, 'error') ?? 'Error.'} ${error}`, 'sadness')
        else this.deps.out.system('Back from the terminal.')
        this.deps.out.status(this.status())
      },
    })
    if (!r.ok) { this.deps.out.system(`${pickLine(this.deps.pack, 'error') ?? 'Error.'} ${r.reason}`, 'sadness'); return }
    this.deps.out.system(STAND_DOWN)
  }
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run src/main/commands.test.ts src/main/chat.test.ts && npm run typecheck`
Expected: PASS; every earlier chat test unchanged; typecheck clean (`ChatPort` in `src/main/ipc.ts` is unaffected; `openCli` is not on it).

- [ ] **Step 6: Commit**

```bash
git add src/main/commands.ts src/main/commands.test.ts src/main/chat.ts src/main/chat.test.ts
git commit -m "chat: /cli hands the session to a terminal and the panel stands down until it closes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Wiring, the menu item, the hand-off e2e, the README row

**Files:**
- Modify: `src/main/menu.ts`, `src/main/index.ts`, `README.md`
- Create: `src/main/menu.test.ts`, `e2e/handoff.spec.ts`

**Interfaces:**
- Consumes: `Handoff` (Task 1), `ChatController.openCli` (Task 2), `parseArgsPrefix` in `src/main/index.ts`, `useEcho` and `cliPath` there.
- Produces: `buildTemplate(d: { actions; buddy; quit; openCli })`, `showContextMenu(d: { actions; buddy; overlay; openCli }, x, y)`.

- [ ] **Step 1: Write the failing menu test**

Create `src/main/menu.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildTemplate } from './menu'

describe('buildTemplate', () => {
  it('carries an Open in Claude Code item that calls openCli', () => {
    const openCli = vi.fn()
    const template = buildTemplate({
      actions: { goTo: vi.fn(), wake: vi.fn(), sleep: vi.fn() } as never,
      buddy: { getState: () => ({ asleep: false }) } as never,
      quit: vi.fn(), openCli,
    })
    const item = template.find(i => i.label === 'Open in Claude Code')
    expect(item).toBeDefined()
    item?.click?.(undefined as never, undefined as never, undefined as never)
    expect(openCli).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/main/menu.test.ts`
Expected: FAIL, `openCli` is not a known dep and the item is missing.

- [ ] **Step 3: The menu**

Replace `src/main/menu.ts` with:

```ts
import { Menu, type BrowserWindow } from 'electron'
import type { Actions } from './actions'
import type { Buddy } from './buddy'

export interface MenuDeps { actions: Actions; buddy: Buddy; quit: () => void; openCli: () => void }

export function buildTemplate(d: MenuDeps): Electron.MenuItemConstructorOptions[] {
  const asleep = d.buddy.getState().asleep
  return [
    { label: 'Go left', click: () => void d.actions.goTo(0) },
    { label: 'Go center', click: () => void d.actions.goTo(0.5) },
    { label: 'Go right', click: () => void d.actions.goTo(1) },
    { type: 'separator' },
    // The real CLI in a terminal on the panel's session; the panel explains any refusal.
    { label: 'Open in Claude Code', click: d.openCli },
    { type: 'separator' },
    { label: asleep ? 'Wake' : 'Sleep', click: () => (asleep ? d.actions.wake() : d.actions.sleep()) },
    { type: 'separator' },
    { label: 'Quit', click: d.quit },
  ]
}

export function showContextMenu(d: { actions: Actions; buddy: Buddy; overlay: BrowserWindow; openCli: () => void }, x: number, y: number): void {
  const menu = Menu.buildFromTemplate(buildTemplate({ ...d, quit: () => require('electron').app.quit() }))
  d.overlay.setFocusable(true)
  menu.popup({ window: d.overlay, x, y, callback: () => d.overlay.setFocusable(false) })
}
```

- [ ] **Step 4: Wire main**

In `src/main/index.ts`:

Add the import `import { Handoff } from './handoff'`.

After the line `const useEcho = process.env.BUDDY_BRAIN === 'echo' || cliMissing`, add:

```ts
  // The terminal hand-off (/cli, and the menu item). Under the echo brain there is no CLI
  // to hand to, so /cli posts the cliMissing line; the e2e suite substitutes a short-lived
  // process through BUDDY_HANDOFF_CMD and never opens a console.
  const handoffCmd = parseArgsPrefix(process.env.BUDDY_HANDOFF_CMD)
  const handoff = handoffCmd.length > 0 ? new Handoff({ cliPath, command: handoffCmd }) : (!useEcho ? new Handoff({ cliPath }) : undefined)
```

In the `new ChatController({ ... })` call, add `handoff,` after `readback,` on the `readback, log: ...` line (keep `log`).

Change the `before-quit` handler that stops the chat to `app.on('before-quit', () => { chatRef?.stop(); handoff?.stop(); readback?.stopAll(); void server.close() })`.

Change the `showContextMenu` line in the `wireIpc({ ... })` call to:

```ts
    showContextMenu: (x, y) => showContextMenu({ actions, buddy, overlay, openCli: () => { actions.openPanel(); chat.openCli() } }, x, y),
```

- [ ] **Step 5: The hand-off e2e**

Create `e2e/handoff.spec.ts`:

```ts
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanEnv } from './env'
import { loadPack } from '../src/main/pack'

// The hand-off launcher is replaced by a node process that lives 1500 ms (BUDDY_HANDOFF_CMD),
// so no console window opens and the stand-down and return are observable. The echo brain
// runs, so the second test proves /cli is refused where there is no CLI to hand to.
const loadedPack = loadPack(join(__dirname, '../packs/mechanicus'))
if (!loadedPack.ok) throw new Error(loadedPack.errors.join('\n'))
const CLI_MISSING_LINES = loadedPack.pack.persona.lines.cliMissing

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}

let app: ElectronApplication | undefined
let userDataDir: string | undefined

async function launch(extraEnv: Record<string, string>): Promise<Page> {
  userDataDir = mkdtempSync(join(tmpdir(), 'buddy-e2e-'))
  app = await electron.launch({ args: ['.'], env: cleanEnv({ BUDDY_TEST: '1', BUDDY_BRAIN: 'echo', BUDDY_USER_DATA: userDataDir, ...extraEnv }) })
  const overlay = await windowByUrl(app, 'overlay')
  await expect.poll(() => overlay.evaluate(() => (document.getElementById('buddy') as HTMLCanvasElement).width), { timeout: 15000 }).toBeGreaterThan(0)
  await app.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  const hologram = await windowByUrl(app, 'hologram')
  await hologram.waitForLoadState('networkidle')
  await hologram.locator('#input').waitFor()
  return hologram
}

test.afterEach(async () => {
  if (app) { const toClose = app; app = undefined; await toClose.close() }
  if (userDataDir) { rmSync(userDataDir, { recursive: true, force: true }); userDataDir = undefined }
})

test('/cli stands the panel down until the terminal process exits', async () => {
  const hologram = await launch({ BUDDY_HANDOFF_CMD: JSON.stringify([process.execPath, '-e', 'setTimeout(() => {}, 1500)']) })
  await hologram.locator('#input').fill('/cli')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.system').last()).toHaveText('He is in the terminal. Close it to continue here.')

  await hologram.locator('#input').fill('are you there')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.system').last()).toHaveText('He is in the terminal. Close it to continue here.')
  await expect(hologram.locator('.msg.buddy')).toHaveCount(0)

  await expect(hologram.locator('.msg.system').last()).toHaveText('Back from the terminal.', { timeout: 10000 })
  await hologram.locator('#input').fill('now?')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.buddy')).toHaveCount(1, { timeout: 15000 })
})

test('/cli with no CLI to hand to posts the cliMissing line', async () => {
  const hologram = await launch({})
  await hologram.locator('#input').fill('/cli')
  await hologram.locator('#input').press('Enter')
  const line = await hologram.locator('.msg.system').last().textContent()
  expect(CLI_MISSING_LINES).toContain(line?.trim())
})
```

- [ ] **Step 6: README**

In `README.md`, in the panel commands table, add a row after the `/model [name]` row:

```markdown
| `/cli` | open the real Claude Code in a terminal on this session; the panel waits until it closes (also in his right-click menu) |
```

- [ ] **Step 7: Verify**

Run: `npm test && npm run typecheck && npm run build && npx playwright test e2e/handoff.spec.ts`
Expected: unit and typecheck clean, build clean, 2 e2e passed, no console window appeared, `Get-Process electron` count unchanged for a buddy running from the main tree.

- [ ] **Step 8: Commit**

```bash
git add src/main/menu.ts src/main/menu.test.ts src/main/index.ts e2e/handoff.spec.ts README.md
git commit -m "handoff: wired to /cli and the right-click menu; e2e proves the stand-down and return" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: node-pty and xterm dependencies, the PtySession

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/main/pty.ts`, `src/main/pty-node.ts`, `src/main/pty.test.ts`

**Interfaces:**
- Consumes: `childEnv` (`src/main/brain/claude-cli.ts`), `killPid` (Task 1).
- Produces: `PtyLike { pid; onData(cb); onExit(cb); write(data); resize(cols, rows); kill() }`, `PtySpawnOptions { name; cols; rows; cwd; env: Record<string, string> }`, `PtyFactory = (file, args, opts) => PtyLike`, `PtyStart { file; args; cwd; env: NodeJS.ProcessEnv; cols; rows }`, `PtyStartResult = { ok: true } | { ok: false; reason }`, `ptyEnv(base): Record<string, string>`, `class PtySession { running; start(s); write(d); resize(c, r); kill(); onData(cb); onExit(cb) }`, `nodePtyFactory: PtyFactory`.

- [ ] **Step 1: Install the dependencies, once**

Run from the worktree root: `npm install --save-exact --no-audit --no-fund node-pty@1.1.0 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0`
Expected: about a second; `package.json` gains `node-pty`, `@xterm/xterm` and `@xterm/addon-fit` under `dependencies` with exact versions; no compiler output (node-pty's install script copies its prebuilt binary and only falls back to a compile when none fits). Check: `node -e "require('node-pty'); console.log('node-pty loads')"` prints the line. If `node-gyp` output appears instead, stop and report BLOCKED: the prebuild did not match and the installer promise would break.

- [ ] **Step 2: Write the failing tests**

Create `src/main/pty.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PtySession, ptyEnv, type PtyFactory, type PtyLike, type PtySpawnOptions } from './pty'

type FakePty = PtyLike & { data: (d: string) => void; exit: (code: number) => void; writes: string[]; sizes: [number, number][]; killed: number }
function fakeFactory(opts: { throws?: string } = {}) {
  const spawns: Array<{ file: string; args: string[]; opts: PtySpawnOptions }> = []
  const ptys: FakePty[] = []
  const factory: PtyFactory = (file, args, o) => {
    if (opts.throws) throw new Error(opts.throws)
    spawns.push({ file, args, opts: o })
    let onData: (d: string) => void = () => {}
    let onExit: (e: { exitCode: number }) => void = () => {}
    const p: FakePty = {
      pid: 777 + ptys.length, writes: [], sizes: [], killed: 0,
      onData(cb) { onData = cb }, onExit(cb) { onExit = cb },
      write(d) { p.writes.push(d) }, resize(c, r) { p.sizes.push([c, r]) }, kill() { p.killed++ },
      data: (d) => onData(d), exit: (code) => onExit({ exitCode: code }),
    }
    ptys.push(p)
    return p
  }
  return { factory, spawns, ptys }
}
const start = (s: PtySession, over: Partial<Parameters<PtySession['start']>[0]> = {}) =>
  s.start({ file: 'claude.exe', args: [], cwd: 'C:\\repo', env: { PATH: 'p', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'k' }, cols: 100, rows: 30, ...over })

describe('ptyEnv', () => {
  it('scrubs the CLI variables, drops undefined values, and sets the terminal type', () => {
    expect(ptyEnv({ PATH: 'p', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'k', EMPTY: undefined })).toEqual({ PATH: 'p', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
  })
})

describe('PtySession', () => {
  it('spawns with the file, args, cwd, size and terminal env', () => {
    const f = fakeFactory(); const s = new PtySession({ factory: f.factory })
    expect(start(s, { args: ['--x'] })).toEqual({ ok: true })
    expect(s.running).toBe(true)
    expect(f.spawns[0]).toEqual({ file: 'claude.exe', args: ['--x'], opts: { name: 'xterm-256color', cols: 100, rows: 30, cwd: 'C:\\repo', env: { PATH: 'p', TERM: 'xterm-256color', COLORTERM: 'truecolor' } } })
  })
  it('forwards data and the exit, and is not running after the exit', () => {
    const f = fakeFactory(); const s = new PtySession({ factory: f.factory })
    const data: string[] = []; const exits: number[] = []
    s.onData(d => data.push(d)); s.onExit(c => exits.push(c))
    start(s)
    f.ptys[0]?.data('hello')
    f.ptys[0]?.exit(3)
    expect(data).toEqual(['hello'])
    expect(exits).toEqual([3])
    expect(s.running).toBe(false)
  })
  it('write and resize pass through, and resize ignores a zero size', () => {
    const f = fakeFactory(); const s = new PtySession({ factory: f.factory })
    start(s)
    s.write('ls\r'); s.resize(80, 24); s.resize(0, 24)
    expect(f.ptys[0]?.writes).toEqual(['ls\r'])
    expect(f.ptys[0]?.sizes).toEqual([[80, 24]])
  })
  it('write and resize are no-ops with nothing running', () => {
    const s = new PtySession({ factory: fakeFactory().factory })
    expect(() => { s.write('x'); s.resize(1, 1); s.kill() }).not.toThrow()
  })
  it('refuses a second start while running, and restarts after the exit', () => {
    const f = fakeFactory(); const s = new PtySession({ factory: f.factory })
    start(s)
    expect(start(s)).toEqual({ ok: false, reason: 'already running' })
    f.ptys[0]?.exit(0)
    expect(start(s)).toEqual({ ok: true })
    expect(f.spawns).toHaveLength(2)
  })
  it('a factory that throws is a refusal with the message', () => {
    const s = new PtySession({ factory: fakeFactory({ throws: 'spawn failed' }).factory })
    expect(start(s)).toEqual({ ok: false, reason: 'spawn failed' })
    expect(s.running).toBe(false)
  })
  it('kill goes through the injected pid killer', () => {
    const f = fakeFactory(); const killed: number[] = []
    const s = new PtySession({ factory: f.factory, kill: (pid) => killed.push(pid) })
    start(s)
    s.kill()
    expect(killed).toEqual([777])
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/main/pty.test.ts`
Expected: FAIL, cannot find module `./pty`.

- [ ] **Step 4: Write pty.ts and pty-node.ts**

Create `src/main/pty.ts`:

```ts
// The embedded terminal's process (spec 2026-09-07-cli-tab-design, 4): one pty at most,
// running the CLI interactively in the workspace. node-pty is behind a factory so this file
// and its tests run under plain Node; pty-node.ts is the only importer of the native module.
import { childEnv } from './brain/claude-cli'
import { killPid } from './brain/process'

export interface PtyLike {
  pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}
export interface PtySpawnOptions { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
export type PtyFactory = (file: string, args: string[], opts: PtySpawnOptions) => PtyLike
export interface PtyStart { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }
export type PtyStartResult = { ok: true } | { ok: false; reason: string }

// The brain's scrubbed environment (no CLAUDECODE, no API key), only string values (node-pty
// refuses undefined), and the terminal type xterm.js emulates.
export function ptyEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(childEnv(base))) if (typeof v === 'string') out[k] = v
  out.TERM = 'xterm-256color'
  out.COLORTERM = 'truecolor'
  return out
}

export class PtySession {
  private pty: PtyLike | null = null
  private dataCb: (data: string) => void = () => {}
  private exitCb: (code: number) => void = () => {}
  constructor(private readonly deps: { factory: PtyFactory; kill?: (pid: number) => void }) {}
  get running(): boolean { return this.pty !== null }

  start(s: PtyStart): PtyStartResult {
    if (this.pty) return { ok: false, reason: 'already running' }
    let p: PtyLike
    try {
      p = this.deps.factory(s.file, s.args, { name: 'xterm-256color', cols: s.cols, rows: s.rows, cwd: s.cwd, env: ptyEnv(s.env) })
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
    this.pty = p
    p.onData((d) => this.dataCb(d))
    p.onExit(({ exitCode }) => {
      if (this.pty === p) this.pty = null
      this.exitCb(exitCode)
    })
    return { ok: true }
  }
  write(data: string): void { this.pty?.write(data) }
  resize(cols: number, rows: number): void { if (cols > 0 && rows > 0) this.pty?.resize(cols, rows) }
  // The whole tree: the CLI's own children go with it. The pty then reports the exit.
  kill(): void {
    const p = this.pty
    if (!p) return
    ;(this.deps.kill ?? killPid)(p.pid)
  }
  onData(cb: (data: string) => void): void { this.dataCb = cb }
  onExit(cb: (code: number) => void): void { this.exitCb = cb }
}
```

Create `src/main/pty-node.ts`:

```ts
// The production PtyFactory over node-pty. Kept apart from pty.ts so the unit tests never
// load the native module; the prebuilt binary node-pty ships loads in Electron 44 without
// a rebuild (measured 2026-09-07).
import * as nodePty from 'node-pty'
import type { PtyFactory } from './pty'

export const nodePtyFactory: PtyFactory = (file, args, opts) =>
  nodePty.spawn(file, args, { name: opts.name, cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env })
```

- [ ] **Step 5: Run the tests, typecheck, build**

Run: `npx vitest run src/main/pty.test.ts && npm run typecheck && npm run build && grep -c "require(\"node-pty\")" out/main/index.js`
Expected: 8 tests pass; typecheck clean (node-pty's `IPty` satisfies `PtyLike` structurally: its `onData` returns a disposable, which a void-returning signature accepts); build clean; the grep prints `1`, proving node-pty is required, not inlined. If the grep prints `0`, add `external: ['node-pty']` under `main.build.rollupOptions` in `electron.vite.config.ts` and rebuild.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/pty.ts src/main/pty-node.ts src/main/pty.test.ts
git commit -m "pty: a PtySession over node-pty behind an injectable factory; xterm dependencies" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The hologram window sized for the CLI panel

**Files:**
- Modify: `src/main/geometry.ts:34-49`, `src/main/geometry.test.ts`

**Interfaces:**
- Produces: `CLI_PANEL_SIZE = { width: 700, height: 480 }`, `hologramBounds(wa, xFraction, charW, charH, panel = PANEL_SIZE)`.

- [ ] **Step 1: Write the failing tests**

In `src/main/geometry.test.ts`, extend the import with `CLI_PANEL_SIZE` and add inside `describe('geometry', ...)`:

```ts
  it('sized for the CLI panel, the window is wider and its top moves up by the extra height', () => {
    const charW = 352, charH = 326
    const chat = hologramBounds(wa, 0.5, charW, charH)
    const cli = hologramBounds(wa, 0.5, charW, charH, CLI_PANEL_SIZE)
    expect(cli.width).toBe(CLI_PANEL_SIZE.width + 2 * 120)
    expect(cli.width).toBe(940)
    expect(cli.y).toBe(chat.y - (CLI_PANEL_SIZE.height - PANEL_SIZE.height))
    expect(cli.height).toBeGreaterThanOrEqual(CLI_PANEL_SIZE.height)
    expect(cli.x).toBeGreaterThanOrEqual(wa.x)
    expect(cli.x + cli.width).toBeLessThanOrEqual(wa.x + wa.width)
  })
  it('the CLI panel still clamps to a small work area', () => {
    const small = { x: 100, y: 50, width: 1000, height: 600 }
    const b = hologramBounds(small, 0.5, 200, 200, CLI_PANEL_SIZE)
    expect(b.x).toBeGreaterThanOrEqual(100)
    expect(b.x + b.width).toBeLessThanOrEqual(1100)
    expect(b.y).toBe(50)
  })
  it('the default panel size keeps every chat-tab placement unchanged', () => {
    expect(hologramBounds(wa, 0.3, 352, 326)).toEqual(hologramBounds(wa, 0.3, 352, 326, PANEL_SIZE))
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/main/geometry.test.ts`
Expected: FAIL, `CLI_PANEL_SIZE` is not exported.

- [ ] **Step 3: Implement**

In `src/main/geometry.ts`, replace lines 34 to 49 with:

```ts
export const PANEL_SIZE = { width: 480, height: 360 }
// The panel while the CLI tab is active (spec 2026-09-07-cli-tab-design, 6): about 95
// columns by 26 rows at the pack's 12 px monospace font.
export const CLI_PANEL_SIZE = { width: 700, height: 480 }
export const CONE_SIDE_MARGIN = 120     // room either side of the panel for the cone
export const PANEL_GAP = 16             // gap between the panel bottom and the character's top
export const SKULL_REACH = 0.75         // window bottom reaches this far down the character

export function hologramBounds(wa: Rect, xFraction: number, charW: number, charH: number, panel = PANEL_SIZE): Rect {
  const width = panel.width + 2 * CONE_SIDE_MARGIN
  const cx = wa.x + xFraction * Math.max(0, wa.width - charW) + charW / 2
  const bias = cx < wa.x + wa.width / 2 ? 1 : -1
  let x = Math.round(cx - width / 2 + bias * panel.width * 0.25)
  x = Math.max(wa.x, Math.min(wa.x + wa.width - width, x))
  const charTop = wa.y + wa.height - charH
  const y = Math.max(wa.y, charTop - panel.height - PANEL_GAP)
  const bottom = Math.min(wa.y + wa.height, charTop + charH * SKULL_REACH)
  return { x, y, width, height: Math.max(panel.height, Math.round(bottom - y)) }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/geometry.test.ts src/main/windows.test.ts src/main/displays.test.ts && npm run typecheck`
Expected: PASS; the bias shift for the CLI size is `panel.width * 0.25`, which the first new test tolerates through the clamp assertions.

- [ ] **Step 5: Commit**

```bash
git add src/main/geometry.ts src/main/geometry.test.ts
git commit -m "geometry: hologramBounds takes the panel size; CLI_PANEL_SIZE is 700 by 480" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: IPC, preload, and main wiring for the terminal

**Files:**
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/index.ts`

**Interfaces:**
- Consumes: `PtySession`, `nodePtyFactory` (Task 4), `CLI_PANEL_SIZE` (Task 5), `parseArgsPrefix`, `useEcho`, `cliPath`, `chat`, `placeHologram` in `src/main/index.ts`.
- Produces: channels `CH.ptyStart`, `CH.ptyInput`, `CH.ptyResize`, `CH.ptyKill`, `CH.ptyData`, `CH.ptyExit`, `CH.hologramMode`, `CH.clipboardWrite`; payloads `PtyStartPayload { cols; rows }`, `PtyStartResult = { ok: true } | { error: string }`, `PtyDataPayload { data }`, `PtyExitPayload { code }`, `HologramModePayload { cli: boolean }`; bridge `ptyStart(cols, rows): Promise<PtyStartResult>`, `ptyInput(data)`, `ptyResize(cols, rows)`, `ptyKill()`, `onPtyData(cb)`, `onPtyExit(cb)`, `setMode(cli)`, `writeClipboard(text)`; main `PtyPort { start(cols, rows): PtyStartResult; write(data); resize(cols, rows); kill() }`, `IpcDeps` gains `pty: PtyPort`, `setMode(cli: boolean): void`, `writeClipboard(text: string): void`.

- [ ] **Step 1: Shared channels and payloads**

In `src/shared/ipc.ts`, add to `CH` after `imageDiscard`:

```ts
  ptyStart: 'pty:start',
  ptyInput: 'pty:input',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  hologramMode: 'hologram:mode',
  clipboardWrite: 'clipboard:write',
```

Add after the `StageResult` type:

```ts
export interface PtyStartPayload { cols: number; rows: number }
export type PtyStartResult = { ok: true } | { error: string }
export interface PtyDataPayload { data: string }
export interface PtyExitPayload { code: number }
// Which tab the panel shows; main places the window for that tab's panel size.
export interface HologramModePayload { cli: boolean }
```

Add to `BuddyBridge` after `pathForFile(file: File): string`:

```ts
  /** The embedded terminal (the CLI tab). start spawns the CLI in the workspace at the
   * given size, or answers with the reason it cannot; data and exit come back as events. */
  ptyStart(cols: number, rows: number): Promise<PtyStartResult>
  ptyInput(data: string): void
  ptyResize(cols: number, rows: number): void
  ptyKill(): void
  onPtyData(cb: (p: PtyDataPayload) => void): () => void
  onPtyExit(cb: (p: PtyExitPayload) => void): () => void
  setMode(cli: boolean): void
  writeClipboard(text: string): void
```

- [ ] **Step 2: Preload**

In `src/preload/index.ts`, extend the shared import with `type HologramModePayload, type PtyStartPayload` and add to the bridge object after `pathForFile`:

```ts
  ptyStart: (cols, rows) => ipcRenderer.invoke(CH.ptyStart, { cols, rows } satisfies PtyStartPayload),
  ptyInput: (data) => ipcRenderer.send(CH.ptyInput, { data }),
  ptyResize: (cols, rows) => ipcRenderer.send(CH.ptyResize, { cols, rows }),
  ptyKill: () => ipcRenderer.send(CH.ptyKill),
  onPtyData: on(CH.ptyData),
  onPtyExit: on(CH.ptyExit),
  setMode: (cli) => ipcRenderer.send(CH.hologramMode, { cli } satisfies HologramModePayload),
  writeClipboard: (text) => ipcRenderer.send(CH.clipboardWrite, { text }),
```

- [ ] **Step 3: Main handlers**

In `src/main/ipc.ts`, extend the shared import with `type HologramModePayload, type PtyDataPayload, type PtyStartPayload, type PtyStartResult` (drop `PtyDataPayload` if unused after the edit) and add after `ImagePort`:

```ts
// Main's side of the CLI tab's terminal (spec T-5).
export interface PtyPort {
  start(cols: number, rows: number): PtyStartResult
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}
```

Add to `IpcDeps` after `images: ImagePort`: `pty: PtyPort` and, after `endDrag`:

```ts
  /** The panel switched tabs: place the window for that tab's panel size. */
  setMode(cli: boolean): void
  /** Copy on select in the terminal. */
  writeClipboard(text: string): void
```

Add the handlers after the `chatStop` line:

```ts
  ipcMain.handle(CH.ptyStart, (_e, p: PtyStartPayload) => d.pty.start(p.cols, p.rows))
  ipcMain.on(CH.ptyInput, (_e, p: { data: string }) => d.pty.write(p.data))
  ipcMain.on(CH.ptyResize, (_e, p: PtyStartPayload) => d.pty.resize(p.cols, p.rows))
  ipcMain.on(CH.ptyKill, () => d.pty.kill())
  ipcMain.on(CH.hologramMode, (_e, p: HologramModePayload) => d.setMode(p.cli))
  ipcMain.on(CH.clipboardWrite, (_e, p: { text: string }) => d.writeClipboard(p.text))
```

- [ ] **Step 4: Wire main**

In `src/main/index.ts`:

Imports: change the electron import to `import { app, clipboard, dialog, screen } from 'electron'`; extend the geometry import to `import { CLI_PANEL_SIZE, PANEL_SIZE, hologramBounds, originToWindow } from './geometry'`; add `import { PtySession } from './pty'`, `import { nodePtyFactory } from './pty-node'`, and extend the `./ipc` import with `type PtyPort`; extend the shared ipc type import with `type PtyDataPayload, type PtyExitPayload`.

Just before `const placeHologram = ...`, add:

```ts
  // The panel size the window is placed for: the chat tab's, or the CLI tab's while that
  // tab is active (spec T-6). Set by hologram:mode; read on every placement.
  const panelSize = { current: PANEL_SIZE }
```

and change the placement line inside `placeHologram` to `hologram.setBounds(hologramBounds(current.wa, x, charW, charH, panelSize.current))`.

After the `images: ImagePort = { ... }` block, add:

```ts
  // The CLI tab's terminal (spec T-4): the real CLI in a ConPTY on its own session, or the
  // BUDDY_PTY_CMD program under test; the pack's cliMissing line when there is neither.
  const ptyCmd = parseArgsPrefix(process.env.BUDDY_PTY_CMD)
  const ptyProgram: string[] | null = ptyCmd.length > 0 ? ptyCmd : (!useEcho ? [cliPath] : null)
  const ptySession = new PtySession({ factory: nodePtyFactory })
  ptySession.onData((data) => toHologram(CH.ptyData, { data } satisfies PtyDataPayload))
  ptySession.onExit((code) => toHologram(CH.ptyExit, { code } satisfies PtyExitPayload))
  const pty: PtyPort = {
    start: (cols, rows) => {
      if (!ptyProgram) return { error: pickLine(pack, 'cliMissing') ?? `No Claude Code at ${cliPath}` }
      const [file, ...args] = ptyProgram
      const r = ptySession.start({ file: file ?? '', args, cwd: chat.status().workspace, env: process.env, cols, rows })
      return r.ok ? { ok: true } : { error: r.reason }
    },
    write: (data) => ptySession.write(data),
    resize: (cols, rows) => ptySession.resize(cols, rows),
    kill: () => ptySession.kill(),
  }
  const setMode = (cli: boolean): void => {
    panelSize.current = cli ? CLI_PANEL_SIZE : PANEL_SIZE
    if (hologram.isVisible()) placeHologram()
  }
```

Add `pty, setMode, writeClipboard: (text) => clipboard.writeText(text),` to the `wireIpc({ ... })` call after `images,`.

Change the quit handler that destroys the windows to `app.on('before-quit', () => { ptySession.kill(); overlay.destroy(); hologram.destroy() })`.

- [ ] **Step 5: Typecheck, tests, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean; the renderer still compiles without calling any of the new bridge methods.

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/ipc.ts src/main/index.ts
git commit -m "ipc: pty start, input, resize, kill and events; panel mode places the window; clipboard write" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The CLI tab in the panel

**Files:**
- Modify: `src/renderer/hologram/index.html`, `src/renderer/hologram/styles.css`, `src/renderer/hologram/main.ts`

**Interfaces:**
- Consumes: the bridge methods from B3; `@xterm/xterm` (`Terminal`), `@xterm/addon-fit` (`FitAddon`). If an option or method name below fails to typecheck against xterm 6, look it up in `node_modules/@xterm/xterm/typings/xterm.d.ts` and use the equivalent; report the substitution.

- [ ] **Step 1: Markup**

In `src/renderer/hologram/index.html`, replace the `#title` line with:

```html
      <div id="title"><div id="tabs"><button type="button" class="tab active" data-tab="chat">Chat</button><button type="button" class="tab" data-tab="cli">CLI</button></div><span id="name"></span><span id="status"></span></div>
```

and add, after the `<textarea id="input" ...>` line:

```html
      <div id="cli" hidden></div>
```

- [ ] **Step 2: Styles**

Append to `src/renderer/hologram/styles.css`:

```css
#tabs { display: flex; gap: 2px; margin-right: 8px; }
#tabs .tab { font: inherit; letter-spacing: inherit; text-transform: inherit; background: transparent; color: var(--text); border: 1px solid transparent; padding: 0 8px; cursor: pointer; opacity: 0.55; }
#tabs .tab.active { opacity: 1; border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
#panel.cli { width: 700px; height: 480px; }
/* On the CLI tab the chat's own children give way; #cli is the only thing under the title. */
#panel.cli > :not(#title):not(#cli) { display: none; }
#cli { flex: 1; min-height: 0; padding: 4px; display: flex; }
#cli[hidden] { display: none; }
#cli .xterm { flex: 1; }
```

- [ ] **Step 3: Renderer logic**

In `src/renderer/hologram/main.ts`:

Add the imports after the existing ones:

```ts
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
```

After the `strip`/`staged` declarations, add:

```ts
const cliEl = $<HTMLDivElement>('cli')
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#tabs .tab'))
type Tab = 'chat' | 'cli'
let activeTab: Tab = 'chat'
// The embedded terminal (spec T-7): created on the first switch to the tab, kept for the
// life of the window; the session behind it lives in main, so the buffer survives hides.
let term: Terminal | null = null
let fit: FitAddon | null = null
let ptyStarted = false
let ptyExited = false
```

Replace `window.addEventListener('resize', sizeCone)` with:

```ts
window.addEventListener('resize', sizeCone)
// The panel changes size when the tab changes; the cone retargets and the terminal refits.
new ResizeObserver(() => { sizeCone(); if (activeTab === 'cli') fit?.fit() }).observe(panel)
```

After the `addUser` function, add:

```ts
function terminalTheme(): { background: string; foreground: string; cursor: string } {
  const s = getComputedStyle(document.documentElement)
  return {
    background: s.getPropertyValue('--bg').trim() || 'rgba(6, 20, 32, 0.82)',
    foreground: s.getPropertyValue('--text').trim() || '#d8f4ff',
    cursor: accent,
  }
}
function ensureTerminal(): Terminal {
  if (term) return term
  const t = new Terminal({
    fontFamily: getComputedStyle(input).fontFamily, fontSize: 12, scrollback: 5000,
    cursorBlink: true, allowTransparency: true, theme: terminalTheme(),
  })
  fit = new FitAddon()
  t.loadAddon(fit)
  t.open(cliEl)
  t.onData((d) => window.buddy.ptyInput(d))
  t.onResize(({ cols, rows }) => window.buddy.ptyResize(cols, rows))
  // Copy on select, as Windows Terminal does; paste is xterm's own Ctrl+V and Shift+Insert.
  t.onSelectionChange(() => { const s = t.getSelection(); if (s) window.buddy.writeClipboard(s) })
  // Enter on a dead terminal restarts it (spec T-7).
  t.onKey(({ key }) => { if (ptyExited && key === '\r') void startPty() })
  // Ctrl+Tab leaves for the chat tab; every other key is the CLI's, Escape included.
  t.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.key === 'Tab') { if (e.type === 'keydown') switchTab('chat'); return false }
    return true
  })
  window.buddy.onPtyData(({ data }) => t.write(data))
  window.buddy.onPtyExit(({ code }) => {
    ptyStarted = false; ptyExited = true
    t.writeln(`\r\n[Claude Code exited, code ${code}]  Enter to restart`)
  })
  term = t
  return t
}
async function startPty(): Promise<void> {
  const t = ensureTerminal()
  fit?.fit()
  ptyExited = false
  const r = await window.buddy.ptyStart(t.cols, t.rows)
  if ('error' in r) { ptyExited = true; t.writeln(`${r.error}\r\n  Enter to retry`); return }
  ptyStarted = true
}
function focusActive(): void { if (activeTab === 'cli') term?.focus(); else input.focus() }
function switchTab(tab: Tab): void {
  activeTab = tab
  for (const b of tabButtons) b.classList.toggle('active', b.dataset.tab === tab)
  panel.classList.toggle('cli', tab === 'cli')
  cliEl.hidden = tab !== 'cli'
  window.buddy.setMode(tab === 'cli')
  if (tab === 'cli') {
    const t = ensureTerminal()
    // Fit after the panel has taken its CLI size, then start the session the first time.
    requestAnimationFrame(() => { fit?.fit(); t.focus(); if (!ptyStarted && !ptyExited) void startPty() })
  } else {
    input.focus()
  }
}
for (const b of tabButtons) b.addEventListener('click', () => switchTab(b.dataset.tab === 'cli' ? 'cli' : 'chat'))
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Tab' && activeTab === 'chat') { e.preventDefault(); switchTab('cli') }
})
```

In the `onTheme` handler, add after `rebuildFace()`:

```ts
  if (term) term.options.theme = terminalTheme()
```

Replace `window.addEventListener('focus', () => input.focus())` with `window.addEventListener('focus', focusActive)`.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: clean. If `allowTransparency` or `term.options.theme` is rejected by the xterm 6 typings, consult `node_modules/@xterm/xterm/typings/xterm.d.ts` for the current option and setter names and use those, noting the change in your report. Check the built `out/renderer` contains an xterm stylesheet or inline style (grep for `xterm-viewport`).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hologram/index.html src/renderer/hologram/styles.css src/renderer/hologram/main.ts
git commit -m "panel: a CLI tab runs the real Claude Code in an embedded terminal; the panel widens for it" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: End to end: the tab against a fake program

**Files:**
- Create: `e2e/cli-tab.spec.ts`

**Interfaces:**
- Consumes: `BUDDY_PTY_CMD` (Task 6), the tab (Task 7), the pack's `cliMissing` lines.

- [ ] **Step 1: Write the spec**

Create `e2e/cli-tab.spec.ts`:

```ts
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanEnv } from './env'
import { loadPack } from '../src/main/pack'

// The tab's program is a node one-liner that prints a prompt and echoes each line back
// (BUDDY_PTY_CMD), running in a real ConPTY owned by the app, so the whole pipeline is
// exercised except the CLI itself. The echo brain runs, so the second test proves the tab
// shows the cliMissing line where there is nothing to run.
const ECHO_PROGRAM = "process.stdout.write('READY> '); process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { for (const l of String(d).split(/\\r?\\n/)) if (l.trim()) process.stdout.write('echo:' + l.trim() + '\\r\\n') })"
const loadedPack = loadPack(join(__dirname, '../packs/mechanicus'))
if (!loadedPack.ok) throw new Error(loadedPack.errors.join('\n'))
const CLI_MISSING_LINES = loadedPack.pack.persona.lines.cliMissing

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}
// The hologram is the only focusable window (the overlay is created focusable: false).
const hologramBoundsOf = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find(x => x.isFocusable())!
  return w.getBounds()
})

let app: ElectronApplication | undefined
let userDataDir: string | undefined

async function launch(extraEnv: Record<string, string>): Promise<Page> {
  userDataDir = mkdtempSync(join(tmpdir(), 'buddy-e2e-'))
  app = await electron.launch({ args: ['.'], env: cleanEnv({ BUDDY_TEST: '1', BUDDY_BRAIN: 'echo', BUDDY_USER_DATA: userDataDir, ...extraEnv }) })
  const overlay = await windowByUrl(app, 'overlay')
  await expect.poll(() => overlay.evaluate(() => (document.getElementById('buddy') as HTMLCanvasElement).width), { timeout: 15000 }).toBeGreaterThan(0)
  await app.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  const hologram = await windowByUrl(app, 'hologram')
  await hologram.waitForLoadState('networkidle')
  await hologram.locator('#input').waitFor()
  return hologram
}

test.afterEach(async () => {
  if (app) { const toClose = app; app = undefined; await toClose.close() }
  if (userDataDir) { rmSync(userDataDir, { recursive: true, force: true }); userDataDir = undefined }
})

// The panel's box includes its 1 px borders, so its CSS width shows as up to 2 px more.
const panelWidth = async (hologram: Page) => Math.round((await hologram.locator('#panel').boundingBox())!.width)
const near = (target: number) => (w: number) => w >= target && w <= target + 2

test('the CLI tab widens the panel, runs the program, echoes typed input, and keeps its buffer across tabs', async () => {
  const hologram = await launch({ BUDDY_PTY_CMD: JSON.stringify([process.execPath, '-e', ECHO_PROGRAM]) })
  expect(near(480)(await panelWidth(hologram))).toBe(true)
  expect((await hologramBoundsOf(app!)).width).toBe(720)

  await hologram.locator('#tabs .tab[data-tab="cli"]').click()
  await expect.poll(async () => near(700)(await panelWidth(hologram))).toBe(true)
  await expect.poll(() => hologramBoundsOf(app!).then(b => b.width)).toBe(940)
  await expect(hologram.locator('#cli')).toContainText('READY>', { timeout: 15000 })

  await hologram.locator('#cli').click()
  await hologram.keyboard.type('hi')
  await hologram.keyboard.press('Enter')
  await expect(hologram.locator('#cli')).toContainText('echo:hi', { timeout: 15000 })

  await hologram.locator('#tabs .tab[data-tab="chat"]').click()
  await expect.poll(async () => near(480)(await panelWidth(hologram))).toBe(true)
  await expect.poll(() => hologramBoundsOf(app!).then(b => b.width)).toBe(720)
  await expect(hologram.locator('#cli')).toBeHidden()
  await expect(hologram.locator('#input')).toBeVisible()

  await hologram.locator('#tabs .tab[data-tab="cli"]').click()
  await expect(hologram.locator('#cli')).toContainText('echo:hi')
})

test('with nothing to run, the CLI tab shows the cliMissing line', async () => {
  const hologram = await launch({})
  await hologram.locator('#tabs .tab[data-tab="cli"]').click()
  // xterm renders rows as separate elements and wraps at the column count, so compare a
  // whitespace-normalized head of each line rather than the whole line.
  await expect.poll(async () => {
    const text = ((await hologram.locator('#cli').textContent()) ?? '').replace(/\s+/g, ' ')
    return CLI_MISSING_LINES.some(l => text.includes(l.slice(0, 24)))
  }, { timeout: 15000 }).toBe(true)
})
```

- [ ] **Step 2: Run the spec**

Run: `npm run build && npx playwright test e2e/cli-tab.spec.ts`
Expected: 2 passed. Failure notes: if `READY>` never appears, print the temp profile's `logs/main.log` and `logs/hologram.log` before teardown; a `pty:start` error text lands in the terminal, so also read `#cli`'s text. If typed keys do not reach the program, the terminal did not have focus: click inside `#cli` before typing and keep that in the spec.

- [ ] **Step 3: Run the whole suite**

Run: `npm run test:e2e`
Expected: every spec passes (30 tests: the 26 on master, 2 hand-off, 2 tab). A buddy running from the main tree is untouched (`Get-Process electron` count unchanged).

- [ ] **Step 4: Commit**

```bash
git add e2e/cli-tab.spec.ts
git commit -m "e2e: the CLI tab widens the panel, runs a program in a ConPTY, echoes input, keeps its buffer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: README, help, the full run, the manual list

**Files:**
- Modify: `README.md`, `src/main/commands.ts` (help text), `src/main/commands.test.ts`

- [ ] **Step 1: Help text**

In `src/main/commands.ts` `HELP_TEXT`, add after the `/cli` line: `'Ctrl+Tab       switch between the Chat tab and the CLI tab (the real Claude Code on its own session)',`. In `src/main/commands.test.ts`, if a test asserts the full `HELP_TEXT`, it uses the constant and needs no change; run it to confirm.

- [ ] **Step 2: README**

In `README.md`, after the Images paragraph and before the Dictation paragraph, add:

```markdown
Tabs: the panel's `CLI` tab is the real, interactive Claude Code running in an embedded
terminal in the workspace, on its own session; the panel widens while it is showing.
Alt+V pastes an image there, Ctrl+Tab switches tabs, and Enter on an exited terminal
restarts it. `/cli` is different: it opens the real CLI in a terminal window on the
panel's own session, and the panel waits until that window closes.
```

In the "What you need" section, after the Claude Code bullet, add a sentence to the same bullet: `The CLI tab and \`/cli\` use the same login.`

- [ ] **Step 3: The full run**

Run: `npm test && npm run typecheck && npm run build && npm run test:e2e`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add README.md src/main/commands.ts src/main/commands.test.ts
git commit -m "docs: README and /help describe the CLI tab and the /cli hand-off" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Manual verification before merge (Peter, from the main tree after merging)**

Restart the buddy (`npm run dev` from the main tree), then: type `/cli` in the panel; a Windows Terminal window opens with the CLI on the panel's session (its first line names the session, or ask it what you last discussed); the panel answers typed text with the stand-down line; close the window; the panel says it is back and the next question shows he remembers the terminal turn. Right-click him and use Open in Claude Code. Click the `CLI` tab: the panel widens, the CLI comes up in `C:\repo` (a trust prompt if the folder is new to it); ask it something; Win+Shift+S a region and press Alt+V in the tab, then ask what it says; Ctrl+Tab back and forth; `/exit` in the tab and Enter to restart; Ctrl+Q still quits from either tab.
