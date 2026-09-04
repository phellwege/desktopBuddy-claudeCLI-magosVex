// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { scanlineRows, tintAlpha } from './face'

describe('HoloFace helpers', () => {
  it('scanlines every third row', () => { expect(scanlineRows(9)).toEqual([0, 3, 6]) })
  it('tint alpha is constant and translucent', () => { expect(tintAlpha()).toBeCloseTo(0.55) })
})
