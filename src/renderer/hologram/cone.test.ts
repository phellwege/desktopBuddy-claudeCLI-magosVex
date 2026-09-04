import { describe, it, expect } from 'vitest'
import { hexToRgb, edgePoints } from './cone'

describe('cone helpers', () => {
  it('parses theme hex colors', () => {
    expect(hexToRgb('#37c4ff')).toEqual([55, 196, 255])
    expect(hexToRgb('#fff')).toEqual([255, 255, 255])
    expect(hexToRgb('nonsense')).toEqual([91, 192, 190])
  })
  it('spreads edge points around a rounded rect', () => {
    const pts = edgePoints({ left: 10, top: 10, right: 110, bottom: 60 }, 40, 0, 12)
    expect(pts).toHaveLength(40)
    for (const p of pts) { expect(p.x).toBeGreaterThanOrEqual(9); expect(p.x).toBeLessThanOrEqual(111); expect(p.y).toBeGreaterThanOrEqual(9); expect(p.y).toBeLessThanOrEqual(61) }
  })
})
