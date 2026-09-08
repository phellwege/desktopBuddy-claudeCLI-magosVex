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
