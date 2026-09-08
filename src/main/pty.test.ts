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
  it('a stale or duplicate exit from a replaced pty does not notify the current session', () => {
    const f = fakeFactory(); const exits: number[] = []
    const s = new PtySession({ factory: f.factory })
    s.onExit(c => exits.push(c))
    start(s)
    f.ptys[0]?.exit(1)
    start(s)
    f.ptys[0]?.exit(1)
    expect(exits).toEqual([1])
    expect(s.running).toBe(true)
    s.write('ls\r')
    expect(f.ptys[1]?.writes).toEqual(['ls\r'])
    expect(f.ptys[0]?.writes).toEqual([])
  })
})
