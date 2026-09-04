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
    const text = `${line} You said: "${prompt}". The cogitator that answers properly arrives in the next slice.`
    if (rng() < 0.5) this.actions.setMood('happy')
    for (const word of text.split(/(?<=\s)/)) {
      if (this.stopped) break
      yield { type: 'text', delta: word }
      if (delay > 0) await sleep(delay)
    }
    yield { type: 'done' }
  }
  stop(): void { this.stopped = true }
}
