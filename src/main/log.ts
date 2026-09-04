import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

// Every process-level log (renderer console, renderer crash, main-process crash) lands
// in one file so a single tail after a bad run shows the whole story.
export function formatLogLine(scope: string, message: string): string {
  return `${new Date().toISOString()} ${scope} ${message}\n`
}

export function appendLog(logDir: string, scope: string, message: string): void {
  appendFileSync(join(logDir, 'renderer.log'), formatLogLine(scope, message))
}
