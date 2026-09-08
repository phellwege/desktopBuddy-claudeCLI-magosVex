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
export type PtySpawnResult = { ok: true } | { ok: false; reason: string }

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

  start(s: PtyStart): PtySpawnResult {
    if (this.pty) return { ok: false, reason: 'already running' }
    let p: PtyLike
    try {
      p = this.deps.factory(s.file, s.args, { name: 'xterm-256color', cols: s.cols, rows: s.rows, cwd: s.cwd, env: ptyEnv(s.env) })
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
    this.pty = p
    p.onData((d) => this.dataCb(d))
    p.onExit(({ exitCode }) => {
      // A stale or duplicate exit from a pty that is no longer the current one (a real
      // ConPTY quirk on Windows) must not report a since-restarted session as dead.
      if (this.pty === p) { this.pty = null; this.exitCb(exitCode) }
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
