import { describe, it, expect } from 'vitest'
import { Buddy } from './buddy'
import { Actions, type ActionHost } from './actions'

function host(): ActionHost & { shown: number; hidden: number; texts: string[] } {
  return { shown: 0, hidden: 0, texts: [],
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
  })
  it('openPanel and closePanel drive the host and the state', () => {
    const b = new Buddy({ rng: () => 0 }); b.tick(0)
    const h = host(); const a = new Actions(b, h)
    a.openPanel()
    expect(h.shown).toBe(1); expect(b.getState().panelOpen).toBe(true)
    a.closePanel()
    expect(h.hidden).toBe(1); expect(b.getState().panelOpen).toBe(false)
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
})
