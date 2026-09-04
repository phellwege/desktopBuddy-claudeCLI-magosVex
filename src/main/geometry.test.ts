import { describe, it, expect } from 'vitest'
import { hologramBounds, overlayBounds, originToWindow, shouldReplaceHologramX, PANEL_SIZE, OVERLAY_HEIGHT } from './geometry'

const wa = { x: 0, y: 0, width: 2560, height: 1392 }
describe('geometry', () => {
  it('overlay is a strip on the bottom of the work area, at least OVERLAY_HEIGHT tall', () => {
    expect(overlayBounds(wa, 200)).toEqual({ x: 0, y: 1392 - OVERLAY_HEIGHT, width: 2560, height: OVERLAY_HEIGHT })
  })
  it('overlay grows to fit a character taller than OVERLAY_HEIGHT, with a margin above it', () => {
    const charH = 326 // e.g. the mechanicus pack's 2x maxFrameSize height
    const b = overlayBounds(wa, charH)
    expect(b.height).toBe(charH + 24)
    expect(b.y + b.height).toBe(1392) // still anchored to the bottom of the work area
  })
  it('hologram window sits above the character and shifts toward the screen center', () => {
    const left = hologramBounds(wa, 0, 200, 200)
    const right = hologramBounds(wa, 1, 200, 200)
    const width = PANEL_SIZE.width + 2 * 120
    expect(left.width).toBe(width)
    expect(left.x).toBeGreaterThanOrEqual(0)
    expect(right.x + right.width).toBeLessThanOrEqual(2560)
    expect(left.x).toBeGreaterThan(100 - width / 2)     // biased right of the character
    expect(right.x).toBeLessThan(2460 - width / 2)      // biased left of the character
    expect(left.y).toBeGreaterThanOrEqual(0)
  })
  it('never leaves a small work area', () => {
    const small = { x: 100, y: 50, width: 1000, height: 600 }
    const b = hologramBounds(small, 0.5, 200, 200)
    expect(b.x).toBeGreaterThanOrEqual(100)
    expect(b.x + b.width).toBeLessThanOrEqual(1100)
    expect(b.y).toBeGreaterThanOrEqual(50)
  })

  it('hologram window reaches from above the panel down into the skull region', () => {
    const charW = 352, charH = 326
    const b = hologramBounds(wa, 0.5, charW, charH)
    const charTop = wa.y + wa.height - charH
    expect(b.y).toBeLessThanOrEqual(charTop - PANEL_SIZE.height - 16)
    expect(b.y + b.height).toBeGreaterThanOrEqual(charTop + charH * 0.75)
    expect(b.width).toBeGreaterThanOrEqual(PANEL_SIZE.width + 2 * 120)
    expect(b.x).toBeGreaterThanOrEqual(wa.x)
    expect(b.x + b.width).toBeLessThanOrEqual(wa.x + wa.width)
  })

  it('hologram window contains any origin within the character box', () => {
    const charW = 352, charH = 326
    for (const xf of [0, 0.5, 1]) {
      const b = hologramBounds(wa, xf, charW, charH)
      const cx = wa.x + xf * (wa.width - charW) + charW / 2
      const charTop = wa.y + wa.height - charH
      for (const [dx, dy] of [[-charW / 2, charH * 0.1], [charW / 2, charH * 0.6]] as [number, number][]) {
        const p = originToWindow({ x: cx + dx, y: charTop + dy }, b)
        expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(b.width)
        expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(b.height)
      }
    }
  })

  it('originToWindow subtracts the window position', () => {
    expect(originToWindow({ x: 500, y: 700 }, { x: 400, y: 600, width: 10, height: 10 })).toEqual({ x: 100, y: 100 })
  })

  describe('shouldReplaceHologramX', () => {
    it('is false for no movement or movement under the threshold', () => {
      expect(shouldReplaceHologramX(0.5, 0.5)).toBe(false)
      expect(shouldReplaceHologramX(0.5, 0.502)).toBe(false)
    })
    it('is true once movement clearly exceeds the threshold, in either direction', () => {
      expect(shouldReplaceHologramX(0.5, 0.51)).toBe(true)
      expect(shouldReplaceHologramX(0.5, 0.49)).toBe(true)
    })
  })
})
