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
