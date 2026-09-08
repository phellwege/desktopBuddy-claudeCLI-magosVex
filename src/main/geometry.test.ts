import { describe, it, expect } from 'vitest'
import { hologramBounds, overlayBounds, originToWindow, shouldReplaceHologramX, unionRect, travelBounds, PANEL_SIZE, CLI_PANEL_SIZE, OVERLAY_HEIGHT, TRAVEL_MARGIN } from './geometry'

// The real rig: an ultrawide above two 1080p panels, overhanging both.
const ULTRA = { x: -575, y: -1440, width: 5120, height: 1392 }
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1032 }
const RIGHT = { x: 1920, y: 0, width: 1920, height: 1032 }

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

  it('sized for the CLI panel, the window is wider and its top moves up by the extra height', () => {
    const charW = 352, charH = 326
    const chat = hologramBounds(wa, 0.5, charW, charH)
    const cli = hologramBounds(wa, 0.5, charW, charH, CLI_PANEL_SIZE)
    expect(cli.width).toBe(CLI_PANEL_SIZE.width + 2 * 120)
    expect(cli.width).toBe(940)
    expect(cli.y).toBe(chat.y - (CLI_PANEL_SIZE.height - PANEL_SIZE.height))
    expect(cli.height).toBeGreaterThanOrEqual(CLI_PANEL_SIZE.height)
    expect(cli.x).toBeGreaterThanOrEqual(wa.x)
    expect(cli.x + cli.width).toBeLessThanOrEqual(wa.x + wa.width)
  })
  it('the CLI panel still clamps to a small work area', () => {
    const small = { x: 100, y: 50, width: 1000, height: 600 }
    const b = hologramBounds(small, 0.5, 200, 200, CLI_PANEL_SIZE)
    expect(b.x).toBeGreaterThanOrEqual(100)
    expect(b.x + b.width).toBeLessThanOrEqual(1100)
    expect(b.y).toBe(50)
  })
  it('the default panel size keeps every chat-tab placement unchanged', () => {
    expect(hologramBounds(wa, 0.3, 352, 326)).toEqual(hologramBounds(wa, 0.3, 352, 326, PANEL_SIZE))
  })

  it('originToWindow subtracts the window position', () => {
    expect(originToWindow({ x: 500, y: 700 }, { x: 400, y: 600, width: 10, height: 10 })).toEqual({ x: 100, y: 100 })
  })

  describe('travel bounds', () => {
    it('unions two rects across negative origins', () => {
      // The ultrawide reaches x=-575..4545 and y=-1440..-48; the right-hand panel reaches
      // x=1920..3840 and y=0..1032. Together: 4415 x 2472 anchored at (-575, -1440).
      expect(unionRect(ULTRA, RIGHT)).toEqual({ x: -575, y: -1440, width: 5120, height: 2472 })
      expect(unionRect(PRIMARY, RIGHT)).toEqual({ x: 0, y: 0, width: 3840, height: 1032 })
    })
    it('is order independent', () => {
      expect(unionRect(ULTRA, PRIMARY)).toEqual(unionRect(PRIMARY, ULTRA))
    })
    it('adds a margin so the sprite is never clipped at the window edge', () => {
      const b = travelBounds(PRIMARY, ULTRA)
      const u = unionRect(PRIMARY, ULTRA)
      expect(b.x).toBe(u.x - TRAVEL_MARGIN)
      expect(b.y).toBe(u.y - TRAVEL_MARGIN)
      expect(b.width).toBe(u.width + 2 * TRAVEL_MARGIN)
      expect(b.height).toBe(u.height + 2 * TRAVEL_MARGIN)
    })
    it('contains both floors and the whole straight path between them', () => {
      const b = travelBounds(PRIMARY, ULTRA)
      const from = { x: 960, y: PRIMARY.y + PRIMARY.height }   // primary floor
      const to = { x: 1820, y: ULTRA.y + ULTRA.height }        // ultrawide floor
      for (let t = 0; t <= 1; t += 0.05) {
        const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
        expect(p.x).toBeGreaterThanOrEqual(b.x)
        expect(p.x).toBeLessThanOrEqual(b.x + b.width)
        expect(p.y).toBeGreaterThanOrEqual(b.y)
        expect(p.y).toBeLessThanOrEqual(b.y + b.height)
      }
    })
    it('of a display with itself is just that display plus the margin', () => {
      expect(travelBounds(PRIMARY, PRIMARY)).toEqual({
        x: -TRAVEL_MARGIN, y: -TRAVEL_MARGIN,
        width: 1920 + 2 * TRAVEL_MARGIN, height: 1032 + 2 * TRAVEL_MARGIN,
      })
    })
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
