import { describe, it, expect } from 'vitest'
import { hologramBounds, overlayBounds, HOLOGRAM_SIZE, OVERLAY_HEIGHT } from './geometry'

const wa = { x: 0, y: 0, width: 2560, height: 1392 }
describe('geometry', () => {
  it('overlay is a strip on the bottom of the work area', () => {
    expect(overlayBounds(wa)).toEqual({ x: 0, y: 1392 - OVERLAY_HEIGHT, width: 2560, height: OVERLAY_HEIGHT })
  })
  it('hologram sits above the character and shifts toward the screen center', () => {
    const left = hologramBounds(wa, 0, 200, 200)
    const right = hologramBounds(wa, 1, 200, 200)
    expect(left.width).toBe(HOLOGRAM_SIZE.width)
    expect(left.x).toBeGreaterThanOrEqual(0)
    expect(right.x + right.width).toBeLessThanOrEqual(2560)
    expect(left.x).toBeGreaterThan(100 - HOLOGRAM_SIZE.width / 2)     // biased right of the character
    expect(right.x).toBeLessThan(2460 - HOLOGRAM_SIZE.width / 2)      // biased left of the character
    expect(left.y + left.height).toBeLessThanOrEqual(1392 - 200 + 24)
    expect(left.y).toBeGreaterThanOrEqual(0)
  })
  it('never leaves a small work area', () => {
    const small = { x: 100, y: 50, width: 600, height: 400 }
    const b = hologramBounds(small, 0.5, 200, 200)
    expect(b.x).toBeGreaterThanOrEqual(100)
    expect(b.x + b.width).toBeLessThanOrEqual(700)
    expect(b.y).toBeGreaterThanOrEqual(50)
  })
})
