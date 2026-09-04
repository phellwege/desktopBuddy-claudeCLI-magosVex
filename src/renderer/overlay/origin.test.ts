import { describe, it, expect } from 'vitest'
import { originScreenPosition } from './origin'

const f = { x: 0, y: 0, w: 100, h: 200, ax: 50, ay: 200, origin: [20, 30] as [number, number] }
const canvas = { width: 200, height: 260 }

describe('originScreenPosition', () => {
  it('maps a crop-local origin through the draw transform', () => {
    // dx = 200/2 - 50 = 50, dy = (260-4) - 200 = 56 at scale 1
    const p = originScreenPosition(f, false, 1, canvas, { left: 10, top: 20 }, { x: 1000, y: 2000 })
    expect(p).toEqual({ x: 1000 + 10 + 50 + 20, y: 2000 + 20 + 56 + 30 })
  })
  it('mirrors horizontally when the frame is flipped', () => {
    const p = originScreenPosition(f, true, 1, canvas, { left: 0, top: 0 }, { x: 0, y: 0 })
    expect(p).toEqual({ x: 200 - (50 + 20), y: 56 + 30 })
  })
  it('returns null without an origin', () => {
    expect(originScreenPosition({ ...f, origin: undefined }, false, 1, canvas, { left: 0, top: 0 }, { x: 0, y: 0 })).toBeNull()
  })
})
