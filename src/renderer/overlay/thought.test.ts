import { describe, it, expect } from 'vitest'
import { DOT_FRACTIONS, DOT_SIZES, START_INSET, headPoint, trailDots, trailStart } from './thought'

describe('headPoint', () => {
  it('is the horizontal centre, three quarters of the way from the vertical centre to the top', () => {
    // 80 wide, 160 tall at (100, 200): centre y 280, half height 80, 0.75 * 80 = 60 above it
    expect(headPoint({ x: 100, y: 200, w: 80, h: 160 })).toEqual({ x: 140, y: 220 })
  })
  it('works for a canvas-box fallback the same way', () => {
    expect(headPoint({ x: 0, y: 0, w: 96, h: 96 })).toEqual({ x: 48, y: 12 })
  })
})

describe('trailStart', () => {
  const bubble = { x: 100, y: 50, w: 200, h: 60 } // right edge 300, bottom 110
  it('above: bottom edge, under the head when the head is within the edge', () => {
    expect(trailStart(bubble, 'above', { x: 180, y: 300 })).toEqual({ x: 180, y: 110 })
  })
  it('above: clamps to the corners with the inset when the head is off to a side', () => {
    expect(trailStart(bubble, 'above', { x: 20, y: 300 })).toEqual({ x: 100 + START_INSET, y: 110 })
    expect(trailStart(bubble, 'above', { x: 900, y: 300 })).toEqual({ x: 300 - START_INSET, y: 110 })
  })
  it('left: right edge, level with the head, clamped by the inset', () => {
    expect(trailStart(bubble, 'left', { x: 400, y: 80 })).toEqual({ x: 300, y: 80 })
    expect(trailStart(bubble, 'left', { x: 400, y: 5 })).toEqual({ x: 300, y: 50 + START_INSET })
    expect(trailStart(bubble, 'left', { x: 400, y: 500 })).toEqual({ x: 300, y: 110 - START_INSET })
  })
  it('right: left edge, level with the head', () => {
    expect(trailStart(bubble, 'right', { x: 10, y: 80 })).toEqual({ x: 100, y: 80 })
  })
})

describe('trailDots', () => {
  it('places the big dot at 35% and the small dot at 70% of the way from start to head', () => {
    const dots = trailDots({ x: 0, y: 0 }, { x: 100, y: 200 })
    expect(dots).toEqual([
      { x: 100 * DOT_FRACTIONS[0], y: 200 * DOT_FRACTIONS[0], size: DOT_SIZES[0] },
      { x: 100 * DOT_FRACTIONS[1], y: 200 * DOT_FRACTIONS[1], size: DOT_SIZES[1] },
    ])
  })
  it('a bubble clamped to the right of him gives a trail stepping left and down toward the head', () => {
    // bubble far right (edge-clamped), head well to the left and below it
    const bubble = { x: 600, y: 0, w: 200, h: 60 }
    const head = { x: 300, y: 200 }
    const start = trailStart(bubble, 'above', head)
    expect(start).toEqual({ x: 600 + START_INSET, y: 60 })
    const dots = trailDots(start, head) as [{ x: number; y: number; size: number }, { x: number; y: number; size: number }]
    const big = dots[0]
    const small = dots[1]
    expect(big.x).toBeLessThan(start.x)
    expect(small.x).toBeLessThan(big.x)
    expect(big.y).toBeGreaterThan(start.y)
    expect(small.y).toBeGreaterThan(big.y)
    expect(small.x).toBeGreaterThan(head.x)
    expect(small.y).toBeLessThan(head.y)
  })
})
