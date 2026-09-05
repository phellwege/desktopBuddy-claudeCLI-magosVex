import { describe, it, expect, vi } from 'vitest'
import { Buddy } from './buddy'
import { Actions, arrivalTimeoutMs, DEFAULT_BAND_WIDTH, type ActionHost } from './actions'
import { RUN_SPEED } from '../shared/types'

// Speeds are pixels per second, so a fraction of the walk band has to be converted before
// it can be compared against a timeout.
const timeoutForFraction = (f: number) => arrivalTimeoutMs(f * DEFAULT_BAND_WIDTH, RUN_SPEED)

function host(): ActionHost & { shown: number; hidden: number; texts: string[]; log: ReturnType<typeof vi.fn<(line: string) => void>> } {
  return { shown: 0, hidden: 0, texts: [], log: vi.fn<(line: string) => void>(),
    showPanel() { this.shown++ }, hidePanel() { this.hidden++ }, pushSystem(t) { this.texts.push(t) } }
}

describe('Actions', () => {
  it('goTo resolves when the buddy arrives', async () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const a = new Actions(b, host())
    const p = a.goTo(0.9)
    expect(b.getState().activity).toBe('running')
    b.arrived()
    await p
    expect(b.getState().x).toBe(0.9)
  })
  it('goTo resolves immediately when already there', async () => {
    const b = new Buddy({ rng: () => 0, initialX: 0.5 }); b.tick(0)
    await new Actions(b, host()).goTo(0.5)
    expect(b.getState().x).toBe(0.5)
    expect(b.getState().activity).toBe('idle')
  })
  it('openPanel and closePanel drive the host and the state', () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const h = host(); const a = new Actions(b, h)
    a.openPanel()
    expect(h.shown).toBe(1); expect(b.getState().panelOpen).toBe(true)
    a.closePanel()
    expect(h.hidden).toBe(1); expect(b.getState().panelOpen).toBe(false)
  })
  it('sleep while the panel is open hides the panel first, then sleeps', () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const h = host(); const a = new Actions(b, h)
    a.openPanel()
    a.sleep()
    expect(h.hidden).toBe(1)
    expect(b.getState().panelOpen).toBe(false); expect(b.getState().asleep).toBe(true)
  })
  it('say opens the panel and pushes the text', () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const h = host(); new Actions(b, h).say('hello')
    expect(h.texts).toEqual(['hello']); expect(h.shown).toBe(1)
  })
  it('emote resolves after the one-shot finishes', async () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const a = new Actions(b, host())
    const p = a.emote('confused')
    expect(b.view().animation).toBe('emote_confused')
    b.oneShotDone()
    await p
    expect(b.getState().activity).toBe('idle')
  })
  it('emote queued behind a walk does not resolve before arrival, resolves after arrival then the one-shot finishes', async () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    b.goTo(0.6)
    const a = new Actions(b, host())
    let resolved = false
    const p = a.emote('alarmed').then(() => { resolved = true })
    expect(b.getState().activity).toBe('walking')
    await Promise.resolve()
    expect(resolved).toBe(false)
    b.arrived()
    expect(b.view().animation).toBe('emote_alarmed')
    await Promise.resolve()
    expect(resolved).toBe(false)
    b.oneShotDone()
    await p
    expect(resolved).toBe(true)
  })
  it('emote while projecting plays, then resolves and returns to the project pose', async () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    b.openPanel()
    const a = new Actions(b, host())
    const p = a.emote('happy')
    expect(b.view().animation).toBe('emote_happy')
    b.oneShotDone()
    await p
    expect(b.getState().activity).toBe('projecting')
  })
  it('goTo resolves through the arrival timeout when the renderer never reports', async () => {
    vi.useFakeTimers()
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const h = host(); const a = new Actions(b, h)
    const p = a.goTo(0.9)
    vi.advanceTimersByTime(timeoutForFraction(0.4) + 1)
    await p
    expect(b.getState().activity).toBe('idle')
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('arrival timeout'))
    vi.useRealTimers()
  })
  it('a new goTo supersedes the previous move: its promise settles and its timer never fires', async () => {
    vi.useFakeTimers()
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const h = host(); const a = new Actions(b, h)
    const first = a.goTo(0.9)
    const second = a.goTo(0.05)
    await first
    vi.advanceTimersByTime(timeoutForFraction(0.4) + 1)
    expect(b.getState().activity).not.toBe('idle')
    expect(b.getState().targetX).toBe(0.05)
    expect(h.log).not.toHaveBeenCalled()
    b.arrived()
    await second
    expect(b.getState().x).toBe(0.05)
    vi.useRealTimers()
  })
})
