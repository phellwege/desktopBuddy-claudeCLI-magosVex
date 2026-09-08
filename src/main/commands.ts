import type { EmoteKind, Mood } from '../shared/types'

export type Command =
  | { kind: 'goto'; x: number; run: boolean; display?: number }
  | { kind: 'displays' }
  | { kind: 'mood'; mood: Mood }
  | { kind: 'emote'; emote: EmoteKind }
  | { kind: 'sleep' } | { kind: 'wake' } | { kind: 'stop' } | { kind: 'new' } | { kind: 'clear' } | { kind: 'help' }
  | { kind: 'cli' }
  | { kind: 'cd'; path: string | null }
  | { kind: 'ls'; path: string | null }
  | { kind: 'model'; model: string | null }

export type ParseResult =
  | { ok: true; command: Command }
  | { ok: false; error: string }
  | { ok: false; notCommand: true }

const MOODS: Mood[] = ['calm', 'happy', 'thinking', 'confused', 'alarmed']
const EMOTES: EmoteKind[] = ['happy', 'thinking', 'confused', 'alarmed', 'look', 'hop']

export const HELP_TEXT = [
  '/goto [display:]<0-100|left|center|right>  walk there',
  '/run [display:]<target>            run there',
  '/displays                          list the attached monitors',
  '/mood <calm|happy|thinking|confused|alarmed>',
  '/emote <happy|thinking|confused|alarmed|look|hop>',
  '/sleep  /wake  /stop  /new  /clear',
  '/cd [path]      change workspace (next session); no path shows where you are',
  '/ls [path]      list a directory (relative to the workspace)',
  '/model [name]   set or clear the model (next session)',
  '/cli            open a fresh Claude Code in a terminal in the workspace (also in his right-click menu)',
  'Ctrl+Tab       switch between the Chat tab and the CLI tab (the real Claude Code, embedded)',
  '/help',
  'Dictation: Win+H (Windows) or your dictation key (Mac) types into this box.',
].join('\n')

function parseTarget(arg: string | undefined): number | null {
  if (arg === undefined) return null
  if (arg === 'left') return 0
  if (arg === 'center') return 0.5
  if (arg === 'right') return 1
  if (!/^-?\d+(\.\d+)?$/.test(arg)) return null
  const n = Number(arg)
  return Math.min(1, Math.max(0, n / 100))
}

export function parseCommand(input: string): ParseResult {
  const text = input.trim()
  if (!text.startsWith('/')) return { ok: false, notCommand: true }
  const [rawWord, ...rest] = text.slice(1).split(/\s+/)
  const word = (rawWord ?? '').toLowerCase()
  const arg = rest.join(' ') || undefined
  switch (word) {
    case 'goto':
    case 'run': {
      // "<target>" stays on the current display; "<display>:<target>" travels to another.
      const usage = `usage: /${word} [display:]<0-100|left|center|right>`
      const raw = rest[0]
      if (raw === undefined) return { ok: false, error: usage }
      const colon = raw.indexOf(':')
      let display: number | undefined
      let target = raw
      if (colon >= 0) {
        const d = raw.slice(0, colon)
        if (!/^\d+$/.test(d) || Number(d) < 1) return { ok: false, error: usage }
        display = Number(d)
        target = raw.slice(colon + 1)
      }
      const x = parseTarget(target)
      if (x === null) return { ok: false, error: usage }
      return { ok: true, command: { kind: 'goto', x, run: word === 'run', display } }
    }
    case 'displays':
      return { ok: true, command: { kind: 'displays' } }
    case 'mood': {
      const mood = rest[0] as Mood | undefined
      if (!mood || !MOODS.includes(mood)) return { ok: false, error: `unknown mood: ${rest[0] ?? ''}` }
      return { ok: true, command: { kind: 'mood', mood } }
    }
    case 'emote': {
      const emote = rest[0] as EmoteKind | undefined
      if (!emote || !EMOTES.includes(emote)) return { ok: false, error: `unknown emote: ${rest[0] ?? ''}` }
      return { ok: true, command: { kind: 'emote', emote } }
    }
    case 'sleep': case 'wake': case 'stop': case 'new': case 'clear': case 'help':
      return { ok: true, command: { kind: word } }
    case 'cd':
      return { ok: true, command: { kind: 'cd', path: arg ?? null } }
    case 'ls':
      return { ok: true, command: { kind: 'ls', path: arg ?? null } }
    case 'model':
      return { ok: true, command: { kind: 'model', model: arg ?? null } }
    case 'cli':
      if (arg !== undefined) return { ok: false, error: 'usage: /cli' }
      return { ok: true, command: { kind: 'cli' } }
    default:
      return { ok: false, error: `unknown command: /${word} (try /help)` }
  }
}
