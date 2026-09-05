// Session persistence: a tiny sibling to config.json that remembers which CLI session (and
// which workspace it belongs to) the buddy was last using, so a relaunch can resume the same
// conversation instead of always starting fresh. Kept separate from config.json on purpose:
// config.json holds settings the user edits by hand, state.json is machine-written bookkeeping.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface AppState { sessionId: string | null; workspace: string }

export function loadState(path: string): AppState | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (typeof raw.workspace !== 'string') return null
    if (raw.sessionId !== null && typeof raw.sessionId !== 'string') return null
    return { sessionId: raw.sessionId as string | null, workspace: raw.workspace }
  } catch {
    return null
  }
}

export function saveState(path: string, state: AppState): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n')
}

// The CLI stores each session's transcript at <home>/.claude/projects/<encoded
// workspace>/<sessionId>.jsonl, where the encoding turns every drive-letter colon and path
// separator into a dash (C:\repo -> C--repo). Used to confirm a remembered session id still
// has a transcript on disk before resuming it.
export function sessionTranscriptExists(homeDir: string, workspace: string, sessionId: string): boolean {
  const encoded = workspace.replace(/[:\\/]/g, '-')
  return existsSync(join(homeDir, '.claude', 'projects', encoded, `${sessionId}.jsonl`))
}
