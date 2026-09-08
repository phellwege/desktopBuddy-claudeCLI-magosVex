import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseStreamLine, activityLabel, isAuthError } from './stream'

const lines = (name: string) =>
  readFileSync(join(__dirname, '../../../test/fixtures/stream', name), 'utf8').split('\n').filter(Boolean)
const events = (name: string) => lines(name).flatMap(l => parseStreamLine(l))

describe('parseStreamLine', () => {
  it('turns a text turn into init, deltas, and done', () => {
    const ev = events('text.jsonl')
    expect(ev[0]).toEqual({ type: 'init', init: { sessionId: 's1', model: 'm' } })
    expect(ev.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')).toBe('Hello')
    expect(ev.at(-1)).toEqual({ type: 'done', sessionId: 's1' })
  })
  it('emits activity for tools, closes it on the result, and skips buddy tools', () => {
    const ev = events('tool.jsonl')
    const acts = ev.filter(e => e.type === 'activity') as Array<{ id: string; done?: boolean; toolName?: string }>
    expect(acts).toHaveLength(2)
    expect(acts[0]).toMatchObject({ id: 't1', label: 'reading src/a.ts', toolName: 'Read' })
    expect(acts[1]).toMatchObject({ id: 't1', done: true })
  })
  it('maps an error result to done with error', () => {
    expect(events('error.jsonl').at(-1)).toEqual({ type: 'done', sessionId: 's1', error: 'boom' })
  })
  it('flags auth errors', () => {
    expect(isAuthError('Not logged in. Please run /login')).toBe(true)
    expect(isAuthError('boom')).toBe(false)
  })
  it('ignores unknown and malformed lines', () => {
    expect(parseStreamLine('{"type":"weird"}')).toEqual([{ type: 'ignore' }])
    expect(parseStreamLine('not json')).toEqual([{ type: 'ignore' }])
  })
  it('ignores the system lines that are not init, and the top-level rate limit line', () => {
    for (const subtype of ['thinking_tokens', 'post_turn_summary']) {
      expect(parseStreamLine(JSON.stringify({ type: 'system', subtype, session_id: 's1' }))).toEqual([{ type: 'ignore' }])
    }
    expect(parseStreamLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }))).toEqual([{ type: 'ignore' }])
  })
  it('never throws and never emits done on a truncated stream missing its final result line', () => {
    const ev = events('truncated.jsonl')
    expect(() => events('truncated.jsonl')).not.toThrow()
    expect(ev.some(e => e.type === 'done')).toBe(false)
    expect(ev[0]).toEqual({ type: 'init', init: { sessionId: 's1', model: 'm' } })
    expect(ev.some(e => e.type === 'text' && e.delta === 'Hi')).toBe(true)
  })
})

describe('activityLabel', () => {
  it('labels the common tools', () => {
    expect(activityLabel('Read', { file_path: 'src/a.ts' })).toBe('reading src/a.ts')
    expect(activityLabel('Grep', { pattern: 'TODO' })).toBe('searching for TODO')
    expect(activityLabel('Glob', { pattern: '**/*.ts' })).toBe('finding **/*.ts')
    expect(activityLabel('Bash', { command: 'git status' })).toBe('running: git status')
    expect(activityLabel('Edit', { file_path: 'x.ts' })).toBe('editing x.ts')
    expect(activityLabel('Write', { file_path: 'x.ts' })).toBe('writing x.ts')
    expect(activityLabel('Other', {})).toBe('Other')
    expect(activityLabel('Bash', { command: 'x'.repeat(200) }).length).toBeLessThanOrEqual(80)
  })
})
