import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { EchoBrain } from './echo'
import { loadPack } from '../pack'
import type { BuddyActions } from '../actions'

const pack = (() => { const r = loadPack(join(__dirname, '../../../test/fixtures/pack-min')); if (!r.ok) throw new Error(r.errors.join()); return r.pack })()
const actionsImpl = { moods: [] as string[], setMood(m: string) { this.moods.push(m) } }
const actions = actionsImpl as unknown as BuddyActions & { moods: string[] }
const ctx = { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null }

describe('EchoBrain', () => {
  it('streams a reply containing the prompt and ends with done', async () => {
    const b = new EchoBrain(pack, actions, { delayMs: 0, rng: () => 0 })
    const events = []
    for await (const e of b.respond('hello there', ctx)) events.push(e)
    const text = events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')
    expect(text).toContain('hi')
    expect(text).toContain('hello there')
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(actions.moods).toEqual(['happy'])
  })
})
