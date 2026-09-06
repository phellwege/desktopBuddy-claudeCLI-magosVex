import { describe, it, expect } from 'vitest'
import { grownHeight } from './compose'

describe('grownHeight', () => {
  it('returns the scroll height as is when under the cap', () => {
    expect(grownHeight(100, 18)).toBe(100)
  })
  it('clamps to lineHeight * maxRows + padding when over the cap', () => {
    expect(grownHeight(400, 18)).toBe(18 * 6 + 12)
  })
  it('returns zero for a zero scroll height', () => {
    expect(grownHeight(0, 18)).toBe(0)
  })
  it('honours a custom maxRows and padding', () => {
    expect(grownHeight(400, 18, 3, 20)).toBe(18 * 3 + 20)
  })
})
