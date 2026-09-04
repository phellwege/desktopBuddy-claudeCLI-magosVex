import { describe, it, expect } from 'vitest'
import { Motion } from './motion'

describe('Motion', () => {
  it('moves toward the target at the given speed', () => {
    const m = new Motion(0); m.setTarget(1, 0.5)
    m.advance(1000); expect(m.x).toBeCloseTo(0.5)
  })
  it('snaps and reports arrival once', () => {
    const m = new Motion(0.9); m.setTarget(1, 0.5)
    expect(m.advance(1000)).toEqual({ arrived: true })
    expect(m.x).toBe(1)
    expect(m.advance(1000)).toEqual({ arrived: false })
  })
  it('moves left too and ignores a missing target', () => {
    const m = new Motion(0.5); m.setTarget(0, 0.1)
    m.advance(1000); expect(m.x).toBeCloseTo(0.4)
    m.setTarget(undefined, 0); m.advance(1000); expect(m.x).toBeCloseTo(0.4)
  })
})
