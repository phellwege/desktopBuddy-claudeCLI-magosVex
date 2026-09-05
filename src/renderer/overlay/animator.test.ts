import { describe, it, expect } from 'vitest'
import { Animator } from './animator'
import type { Animations } from '../../shared/types'

const anims = {
  idle: { right: ['i0', 'i1'], left: ['i0', 'i1'], fps: 10, loop: true, mirrorLeft: false, repeat: 1 },
  walk: { right: ['w0', 'w1'], left: ['w0', 'w1'], fps: 10, loop: true, mirrorLeft: true, repeat: 1 },
  emote_happy: { right: ['h0', 'h1'], left: ['h0', 'h1'], fps: 10, loop: false, mirrorLeft: false, repeat: 1 },
  emote_alarmed: { right: ['a0', 'a1'], left: ['a0', 'a1'], fps: 10, loop: false, mirrorLeft: false, repeat: 3 },
} as unknown as Animations

describe('Animator', () => {
  it('loops', () => {
    const a = new Animator(anims)
    expect(a.current().frame).toBe('i0')
    a.advance(100); expect(a.current().frame).toBe('i1')
    a.advance(100); expect(a.current().frame).toBe('i0')
  })
  it('finishes a one-shot exactly once and holds the last frame', () => {
    const a = new Animator(anims); a.set('emote_happy')
    expect(a.advance(100).justFinished).toBe(false)
    expect(a.current().frame).toBe('h1')
    expect(a.advance(100).justFinished).toBe(true)
    expect(a.advance(100).justFinished).toBe(false)
    expect(a.current().frame).toBe('h1')
  })
  it('plays a repeated one-shot repeat times, then finishes once', () => {
    const a = new Animator(anims); a.set('emote_alarmed')
    // 3 passes of 2 frames: only the 6th frame step ends it.
    for (let i = 0; i < 5; i++) expect(a.advance(100).justFinished).toBe(false)
    expect(a.current().frame).toBe('a1')
    expect(a.advance(100).justFinished).toBe(true)
    expect(a.advance(100).justFinished).toBe(false)
    expect(a.current().frame).toBe('a1')
  })
  it('restarts the repeat count when the key changes', () => {
    const a = new Animator(anims); a.set('emote_alarmed')
    a.advance(100); a.advance(100)          // one pass done, into the second
    a.set('emote_happy')
    expect(a.advance(100).justFinished).toBe(false)
    expect(a.advance(100).justFinished).toBe(true)
  })
  it('mirrors only when the animation asks for it', () => {
    const a = new Animator(anims); a.setFacing('left')
    expect(a.current().mirror).toBe(false)
    a.set('walk'); expect(a.current().mirror).toBe(true)
  })
  it('does not restart when set to the same key', () => {
    const a = new Animator(anims); a.advance(100); a.set('idle')
    expect(a.current().frame).toBe('i1')
  })
  it('accumulates partial frames', () => {
    const a = new Animator(anims); a.advance(60); a.advance(60)
    expect(a.current().frame).toBe('i1')
  })
})
