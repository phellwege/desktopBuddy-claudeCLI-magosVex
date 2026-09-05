import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { loadPack, ANIMATION_KEYS } from './pack'
import { EXPRESSIONS } from '../shared/types'

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
  it('carries a looping hover over the four hover frames the atlas already had', () => {
    const r = loadPack(join(__dirname, '../../packs/mechanicus'))
    if (!r.ok) throw new Error(r.errors.join('\n'))
    const hover = r.pack.animations.hover
    expect(hover.right).toEqual(['hover_0', 'hover_1', 'hover_2', 'hover_3'])
    expect(hover.loop).toBe(true)
    for (const frame of hover.right) expect(r.pack.atlas.frames[frame], frame).toBeTruthy()
  })
  it('maps all nine expressions to real face frames', () => {
    const r = loadPack(join(__dirname, '../../packs/mechanicus'))
    if (!r.ok) throw new Error(r.errors.join('\n'))
    expect(r.pack.faces).not.toBeNull()
    for (const name of EXPRESSIONS) {
      expect(r.pack.faces?.[name], name).toBeTruthy()
    }
    expect(Object.keys(r.pack.faces ?? {}).length).toBe(9)
  })
})
