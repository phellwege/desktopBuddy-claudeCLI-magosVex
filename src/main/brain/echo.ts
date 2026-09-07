import type { PackData } from '../../shared/types'
import type { BuddyActions } from '../actions'
import { pickLine } from '../pack'
import type { Brain, BrainContext, BrainEvent } from './types'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export class EchoBrain implements Brain {
  private stopped = false
  constructor(private readonly pack: PackData, private readonly actions: BuddyActions,
    private readonly opts: { delayMs?: number; rng?: () => number } = {}) {}

  async *respond(prompt: string, _ctx: BrainContext): AsyncIterable<BrainEvent> {
    this.stopped = false
    const rng = this.opts.rng ?? Math.random
    const delay = this.opts.delayMs ?? 40
    const line = pickLine(this.pack, rng() < 0.5 ? 'greeting' : 'idleMutter', rng) ?? 'Acknowledged.'
    // The echo brain is what runs on a machine with no Claude Code installed (and in the
    // e2e suite), so the tail says how to get a real brain rather than promising one.
    // Picked with a fixed roll so the rng draws below stay where the tests expect them.
    const tail = pickLine(this.pack, 'cliMissing', () => 0) ?? 'No brain is installed here; I can only repeat you.'
    const text = `${line} You said: "${prompt}". ${tail}`
    if (rng() < 0.5) this.actions.setMood('happy')
    for (const word of text.split(/(?<=\s)/)) {
      if (this.stopped) break
      yield { type: 'text', delta: word }
      if (delay > 0) await sleep(delay)
    }
    yield { type: 'expression', name: rng() < 0.1 ? 'happy' : 'neutral' }
    yield { type: 'done' }
  }
  stop(): void { this.stopped = true }
}
