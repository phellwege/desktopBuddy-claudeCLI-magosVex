import type { BrainEvent } from './types'

export interface ParsedInit { sessionId: string; model?: string }
export type StreamOutput = BrainEvent | { type: 'init'; init: ParsedInit } | { type: 'ignore' }

const IGNORE: StreamOutput[] = [{ type: 'ignore' }]

function asString(v: unknown): string { return typeof v === 'string' ? v : '' }
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}
function contentBlocks(msg: unknown): Record<string, unknown>[] {
  const message = asRecord(msg).message
  const content = asRecord(message).content
  return Array.isArray(content) ? content.filter(b => b && typeof b === 'object') : []
}

function parseSystem(msg: Record<string, unknown>): StreamOutput[] {
  if (msg.subtype !== 'init') return IGNORE
  const init: ParsedInit = { sessionId: asString(msg.session_id) }
  if (typeof msg.model === 'string') init.model = msg.model
  return [{ type: 'init', init }]
}

function parseStreamEvent(msg: Record<string, unknown>): StreamOutput[] {
  const event = asRecord(msg.event)
  if (event.type !== 'content_block_delta') return IGNORE
  const delta = asRecord(event.delta)
  if (delta.type !== 'text_delta' || typeof delta.text !== 'string') return IGNORE
  return [{ type: 'text', delta: delta.text }]
}

function parseAssistant(msg: Record<string, unknown>, buddyToolPrefix: string): StreamOutput[] {
  const out: StreamOutput[] = []
  for (const block of contentBlocks(msg)) {
    if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue
    if (block.name.startsWith(buddyToolPrefix)) continue
    out.push({ type: 'activity', id: block.id, label: activityLabel(block.name, block.input), toolName: block.name })
  }
  return out.length ? out : IGNORE
}

function parseUser(msg: Record<string, unknown>): StreamOutput[] {
  const out: StreamOutput[] = []
  for (const block of contentBlocks(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    out.push({ type: 'activity', id: block.tool_use_id, label: '', toolName: '', done: true })
  }
  return out.length ? out : IGNORE
}

function parseResult(msg: Record<string, unknown>): StreamOutput[] {
  const sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined
  const ok = msg.is_error !== true && msg.subtype === 'success'
  if (ok) return [{ type: 'done', sessionId }]
  const error = typeof msg.result === 'string' ? msg.result : 'unknown error'
  return [{ type: 'done', sessionId, error }]
}

export function parseStreamLine(line: string, buddyToolPrefix = 'mcp__buddy__'): StreamOutput[] {
  let parsed: unknown
  try { parsed = JSON.parse(line) }
  catch (err) { console.error('parseStreamLine: malformed line', err); return IGNORE }
  const msg = asRecord(parsed)
  switch (msg.type) {
    case 'system': return parseSystem(msg)
    case 'stream_event': return parseStreamEvent(msg)
    case 'assistant': return parseAssistant(msg, buddyToolPrefix)
    case 'user': return parseUser(msg)
    case 'result': return parseResult(msg)
    default: return IGNORE
  }
}

export function activityLabel(toolName: string, input: unknown): string {
  const rec = asRecord(input)
  let label: string
  switch (toolName) {
    case 'Read': label = `reading ${asString(rec.file_path)}`; break
    case 'Grep': label = `searching for ${asString(rec.pattern)}`; break
    case 'Glob': label = `finding ${asString(rec.pattern)}`; break
    case 'Bash': label = `running: ${asString(rec.command)}`; break
    case 'Edit': label = `editing ${asString(rec.file_path)}`; break
    case 'Write': label = `writing ${asString(rec.file_path)}`; break
    default: label = toolName
  }
  return label.length > 80 ? label.slice(0, 80) : label
}

export function isAuthError(text: string): boolean {
  return /authenticat|log ?in|unauthorized|api key/i.test(text)
}
