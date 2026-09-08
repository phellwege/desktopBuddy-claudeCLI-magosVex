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
  // The session id is the one unquoted token on the cmd /c line; anything outside a UUID's
  // character set could otherwise be read as extra tokens or shell syntax by start.
  if (!/^[0-9a-f-]+$/i.test(sessionId)) return { ok: false, reason: 'a session id with unexpected characters cannot be handed to start' }
  const dir = /^[A-Za-z]:\\$/.test(workspace) ? workspace : workspace.replace(/[\\/]+$/, '')
  const flag = fresh ? '--session-id' : '--resume'
  return { ok: true, file: 'cmd.exe', args: ['/c', `start "Claude Code" /wait /d "${dir}" "${cliPath}" ${flag} ${sessionId}`], verbatim: true }
}

export class Handoff {
  private child: ChildProcess | null = null
  // Guards stop() against a second call on the same child: the injected killer (tests, and
  // any future non-Windows kill) has no exitCode check of its own the way killTree does, so
  // idempotency has to live here rather than be assumed from the child.
  private stopping = false
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
    this.stopping = false
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
    if (!child || this.stopping) return
    this.stopping = true
    ;(this.deps.kill ?? killTree)(child)
  }
}
