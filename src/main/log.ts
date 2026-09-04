import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

// Every process-level log (renderer console, renderer crash, main-process crash) lands
// in one file so a single tail after a bad run shows the whole story.
export function formatLogLine(scope: string, message: string): string {
  return `${new Date().toISOString()} ${scope} ${message}\n`
}

// Called from uncaughtException/unhandledRejection handlers, so it must never throw:
// a throw here would escape the handler and Node would terminate the process anyway,
// defeating the point of catching the crash in the first place.
export function appendLog(logDir: string, scope: string, message: string): void {
  try {
    appendFileSync(join(logDir, 'renderer.log'), formatLogLine(scope, message))
  } catch (err) {
    console.error('appendLog failed:', err)
  }
}
