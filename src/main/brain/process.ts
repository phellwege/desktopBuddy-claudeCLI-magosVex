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
