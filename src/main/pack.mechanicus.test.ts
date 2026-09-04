import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { loadPack, ANIMATION_KEYS } from './pack'

describe('mechanicus pack', () => {
  it('loads with every vocabulary key mapped to real frames', () => {
    const r = loadPack(join(__dirname, '../../packs/mechanicus'))
    if (!r.ok) throw new Error(r.errors.join('\n'))
    for (const key of ANIMATION_KEYS) {
      expect(r.pack.animations[key].right.length, key).toBeGreaterThan(0)
    }
    expect(r.pack.animations.walk.mirrorLeft).toBe(false)
    expect(r.pack.animations.walk.left[0]).toBe('walk_left_0')
    expect(r.pack.persona.lines.greeting.length).toBeGreaterThan(0)
    expect(r.pack.persona.prompt).toContain('Magos Vex')
  })
})
