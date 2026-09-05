import { describe, it, expect } from 'vitest'
import { Motion } from './motion'

describe('Motion', () => {
  it('moves toward the target at the given speed', () => {
    const m = new Motion(0, 100); m.setTarget({ x: 1000, y: 100 }, 500)
    m.advance(1000); expect(m.vx).toBeCloseTo(500); expect(m.vy).toBe(100)
  })
  it('snaps and reports arrival once', () => {
    const m = new Motion(900, 100); m.setTarget({ x: 1000, y: 100 }, 500)
    expect(m.advance(1000)).toEqual({ arrived: true })
    expect(m.vx).toBe(1000)
    expect(m.advance(1000)).toEqual({ arrived: false })
  })
  it('moves left too and ignores a missing target', () => {
    const m = new Motion(500, 100); m.setTarget({ x: 0, y: 100 }, 100)
    m.advance(1000); expect(m.vx).toBeCloseTo(400)
    m.setTarget(undefined, 0); m.advance(1000); expect(m.vx).toBeCloseTo(400)
  })

  it('interpolates a diagonal on both axes and arrives exactly once', () => {
    // 300-400-500 triangle: at 250 px/s the trip takes two seconds.
    const m = new Motion(0, 0); m.setTarget({ x: 300, y: -400 }, 250)
    expect(m.advance(1000)).toEqual({ arrived: false })
    expect(m.vx).toBeCloseTo(150); expect(m.vy).toBeCloseTo(-200)
    expect(m.advance(1000)).toEqual({ arrived: true })
    expect(m.vx).toBe(300); expect(m.vy).toBe(-400)
    expect(m.advance(1000)).toEqual({ arrived: false })
  })
  it('clamps to the target instead of overshooting on a long frame', () => {
    const m = new Motion(0, 0); m.setTarget({ x: 10, y: 0 }, 1000)
    expect(m.advance(5000)).toEqual({ arrived: true })
    expect(m.vx).toBe(10)
  })
  it('reports arrival for a zero-length target rather than dividing by zero', () => {
    const m = new Motion(42, 7); m.setTarget({ x: 42, y: 7 }, 500)
    expect(m.advance(16)).toEqual({ arrived: true })
    expect(m.vx).toBe(42); expect(m.vy).toBe(7)
  })
  it('place() drops any target so a resting position is not re-animated', () => {
    const m = new Motion(0, 0); m.setTarget({ x: 999, y: 0 }, 500)
    m.place(120, 1032)
    expect(m.target).toBeUndefined()
    m.advance(1000)
    expect(m.vx).toBe(120); expect(m.vy).toBe(1032)
  })
})
