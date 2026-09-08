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
