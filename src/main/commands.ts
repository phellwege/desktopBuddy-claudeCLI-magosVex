import type { EmoteKind, Mood } from '../shared/types'

export type Command =
  | { kind: 'goto'; x: number; run: boolean }
  | { kind: 'mood'; mood: Mood }
  | { kind: 'emote'; emote: EmoteKind }
  | { kind: 'sleep' } | { kind: 'wake' } | { kind: 'stop' } | { kind: 'new' } | { kind: 'help' }
  | { kind: 'cd'; path: string }
  | { kind: 'model'; model: string | null }

export type ParseResult =
  | { ok: true; command: Command }
  | { ok: false; error: string }
  | { ok: false; notCommand: true }

const MOODS: Mood[] = ['calm', 'happy', 'thinking', 'confused', 'alarmed']
const EMOTES: EmoteKind[] = ['happy', 'thinking', 'confused', 'alarmed', 'look', 'hop']

export const HELP_TEXT = [
  '/goto <0-100|left|center|right>  walk there',
  '/run <target>                     run there',
  '/mood <calm|happy|thinking|confused|alarmed>',
  '/emote <happy|thinking|confused|alarmed|look|hop>',
  '/sleep  /wake  /stop  /new',
  '/cd <path>      change workspace (next session)',
  '/model [name]   set or clear the model (next session)',
  '/help',
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
      const x = parseTarget(rest[0])
      if (x === null) return { ok: false, error: `usage: /${word} <0-100|left|center|right>` }
      return { ok: true, command: { kind: 'goto', x, run: word === 'run' } }
    }
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
    case 'sleep': case 'wake': case 'stop': case 'new': case 'help':
      return { ok: true, command: { kind: word } }
    case 'cd':
      if (!arg) return { ok: false, error: 'usage: /cd <path>' }
      return { ok: true, command: { kind: 'cd', path: arg } }
    case 'model':
      return { ok: true, command: { kind: 'model', model: arg ?? null } }
    default:
      return { ok: false, error: `unknown command: /${word} (try /help)` }
  }
}
