import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

// Kills a CLI child and everything it spawned. Windows has no process groups, so taskkill
// walks the tree; the spawn is best effort and must never throw or leave a handle behind.
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    const killer = nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('error', () => { /* best effort only */ })
  } else {
    child.kill()
  }
}
