import { describe, it, expect } from 'vitest'
import {
  roster, byOrd, primaryOf, relate, desktopBounds, displayAt, planDrop, floorY, walkBand, fromFraction, toFraction, planRoute,
  type ScreenLike, type DisplayInfo,
} from './displays'

// The development machine's real three-screen layout, measured 2026-09-05. The ultrawide
// sits above both 1080p panels and overhangs each side, so the fixture carries negative
// virtual coordinates throughout. Work areas are 48 px shorter than bounds (the taskbar).
const D3: ScreenLike = { id: 3, primary: false, workArea: { x: -575, y: -1440, width: 5120, height: 1392 } }
const D2: ScreenLike = { id: 2, primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1032 } }
const D1: ScreenLike = { id: 1, primary: false, workArea: { x: 1920, y: 0, width: 1920, height: 1032 } }
const RIG = [D1, D2, D3] // deliberately unsorted going in

const CHAR_W = 200
const THRESH = 0.25
// Derived once so the expectations below read as geometry rather than magic numbers.
const BAND = { ultrawide: { min: -475, max: 4445 }, primary: { min: 100, max: 1820 }, right: { min: 2020, max: 3740 } }
const FLOOR = { ultrawide: -48, primary: 1032, right: 1032 }

const rig = (): DisplayInfo[] => roster(RIG)
const ord = (n: number): DisplayInfo => byOrd(rig(), n)!

describe('roster', () => {
  it('orders top-to-bottom then left-to-right, surviving negative origins', () => {
    expect(rig().map(d => d.id)).toEqual([3, 2, 1])
    expect(rig().map(d => d.ord)).toEqual([1, 2, 3])
  })
  it('marks the primary and finds it regardless of position', () => {
    expect(primaryOf(rig()).id).toBe(2)
    expect(byOrd(rig(), 2)!.primary).toBe(true)
  })
  it('numbers a single display as 1', () => {
    expect(roster([D2]).map(d => d.ord)).toEqual([1])
  })
})

describe('relate', () => {
  it('classifies the rig', () => {
    expect(relate(D2.workArea, D1.workArea)).toBe('beside')
    expect(relate(D1.workArea, D2.workArea)).toBe('beside')
    expect(relate(D2.workArea, D3.workArea)).toBe('above')
    expect(relate(D3.workArea, D2.workArea)).toBe('below')
    expect(relate(D1.workArea, D3.workArea)).toBe('above')
    expect(relate(D3.workArea, D1.workArea)).toBe('below')
    expect(relate(D2.workArea, D2.workArea)).toBe('same')
  })
  it('calls a corner-touching diagonal pair apart, not beside', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 }
    const b = { x: 100, y: -100, width: 100, height: 100 }
    expect(relate(a, b)).toBe('apart')
  })
  it('calls physically separated displays apart', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 }
    const b = { x: 500, y: 0, width: 100, height: 100 }
    expect(relate(a, b)).toBe('apart')
  })
})

describe('bands and fractions', () => {
  it('puts the floor on the bottom edge of the work area', () => {
    expect(floorY(D2.workArea)).toBe(FLOOR.primary)
    expect(floorY(D3.workArea)).toBe(FLOOR.ultrawide)
  })
  it('insets the walk band by half a character, matching the old fraction span', () => {
    expect(walkBand(D2.workArea, CHAR_W)).toEqual(BAND.primary)
    expect(walkBand(D3.workArea, CHAR_W)).toEqual(BAND.ultrawide)
    const b = walkBand(D2.workArea, CHAR_W)
    expect(b.max - b.min).toBe(D2.workArea.width - CHAR_W)
  })
  it('degenerates to a point when the character is wider than the display', () => {
    expect(walkBand({ x: 0, y: 0, width: 100, height: 100 }, 400)).toEqual({ min: 50, max: 50 })
  })
  it('round-trips a fraction through virtual pixels', () => {
    for (const f of [0, 0.25, 0.5, 1]) {
      expect(toFraction(fromFraction(f, D3.workArea, CHAR_W), D3.workArea, CHAR_W)).toBeCloseTo(f, 10)
    }
  })
  it('clamps a fraction outside 0..1 and a pixel outside the band', () => {
    expect(fromFraction(2, D2.workArea, CHAR_W)).toBe(BAND.primary.max)
    expect(toFraction(-9999, D2.workArea, CHAR_W)).toBe(0)
  })
})

describe('drop', () => {
  it('spans every display, including the negative origin', () => {
    // The ultrawide overhangs both panels, so it sets the left and right edges alike:
    // x from -575 to 4545, y from -1440 (its top) to 1032 (the 1080p floors).
    expect(desktopBounds(rig())).toEqual({ x: -575, y: -1440, width: 5120, height: 2472 })
  })
  it('resolves a point inside a display to that display', () => {
    expect(displayAt(rig(), { x: 960, y: 500 }).ord).toBe(2)
    expect(displayAt(rig(), { x: 2800, y: 500 }).ord).toBe(3)
    expect(displayAt(rig(), { x: 1000, y: -700 }).ord).toBe(1)
  })
  it('falls back to the nearest display for a point in a gap', () => {
    // Below the ultrawide but left of both 1080p panels: nothing contains it.
    expect(displayAt(rig(), { x: -400, y: 500 }).ord).toBe(2)
    // Under the primary's taskbar strip, which is outside every work area.
    expect(displayAt(rig(), { x: 960, y: 1060 }).ord).toBe(2)
  })
  it('drops straight down onto the floor of the display under the release point', () => {
    const leg = planDrop(rig(), { x: 2800, y: 300 }, CHAR_W)
    expect(leg).toEqual({
      kind: 'fly', to: { x: 2800, y: FLOOR.right }, hop: false,
      display: 3, fraction: toFraction(2800, D1.workArea, CHAR_W), facing: 'right',
    })
  })
  it('pulls a drop near the edge back inside the walk band', () => {
    const leg = planDrop(rig(), { x: 1910, y: 300 }, CHAR_W)
    expect(leg.display).toBe(2)             // still the primary, which reaches x=1920
    expect(leg.to.x).toBe(BAND.primary.max) // but inset so he is not half off the screen
    expect(leg.facing).toBe('left')         // and he leans back the way he was pulled
  })
  it('lands on the ultrawide when dropped over it', () => {
    const leg = planDrop(rig(), { x: 1000, y: -900 }, CHAR_W)
    expect(leg.display).toBe(1)
    expect(leg.to).toEqual({ x: 1000, y: FLOOR.ultrawide })
  })
})

describe('planRoute', () => {
  const route = (fromOrd: number, toOrd: number, landFraction: number, startVX: number, run?: boolean) =>
    planRoute({ from: ord(fromOrd), to: ord(toOrd), startVX, landFraction, charW: CHAR_W, runThreshold: THRESH, run })

  it('reduces to a single walk on the same display', () => {
    expect(route(2, 2, 0.25, 960)).toEqual([
      { kind: 'walk', to: { x: 530, y: FLOOR.primary }, run: true },
    ])
  })
  it('emits nothing when already standing on the requested spot', () => {
    expect(route(2, 2, 0.5, 960)).toEqual([])
  })

  it('beside: runs to the seam, hops across it, then walks in', () => {
    // primary (2) to the right-hand 1080p (3): the shared edge is x=1920.
    expect(route(2, 3, 0.5, 960)).toEqual([
      { kind: 'walk', to: { x: BAND.primary.max, y: FLOOR.primary }, run: true },
      { kind: 'fly', to: { x: BAND.right.min, y: FLOOR.right }, hop: true },
      { kind: 'walk', to: { x: 2880, y: FLOOR.right }, run: true },
    ])
  })
  it('beside: hops leftward when the target is on the left', () => {
    const legs = route(3, 2, 0.5, 2880)
    expect(legs[0]).toEqual({ kind: 'walk', to: { x: BAND.right.min, y: FLOOR.right }, run: true })
    expect(legs[1]).toEqual({ kind: 'fly', to: { x: BAND.primary.max, y: FLOOR.primary }, hop: true })
  })

  it('above: rises through the shared column as close to the landing spot as it allows', () => {
    // The ultrawide's centre (x~1985) is past the primary's right edge, so he launches from
    // the primary's rightmost point and finishes with a short walk on the ultrawide.
    const legs = route(2, 1, 0.5, 960)
    expect(legs).toEqual([
      { kind: 'walk', to: { x: BAND.primary.max, y: FLOOR.primary }, run: true },
      { kind: 'fly', to: { x: BAND.primary.max, y: FLOOR.ultrawide }, hop: false },
      { kind: 'walk', to: { x: 1985, y: FLOOR.ultrawide }, run: false },
    ])
  })
  it('above: lands into the ultrawide left overhang with a trailing walk past the seam', () => {
    const legs = route(2, 1, 0, 960)
    expect(legs).toEqual([
      { kind: 'walk', to: { x: BAND.primary.min, y: FLOOR.primary }, run: true },
      { kind: 'fly', to: { x: BAND.primary.min, y: FLOOR.ultrawide }, hop: false },
      { kind: 'walk', to: { x: BAND.ultrawide.min, y: FLOOR.ultrawide }, run: false },
    ])
  })
  it('above: rises straight up with no trailing walk when the column already lines up', () => {
    // Fraction 0.5 of the ultrawide is x=1985; ask for the fraction that maps to x=960 so
    // the launch column and the landing spot coincide.
    const f = toFraction(960, D3.workArea, CHAR_W)
    expect(route(2, 1, f, 960)).toEqual([
      { kind: 'fly', to: { x: 960, y: FLOOR.ultrawide }, hop: false },
    ])
  })
  it('below: drops from the ultrawide onto a 1080p panel', () => {
    const legs = route(1, 3, 0.5, 2880)
    expect(legs[legs.length - 1]!.to.y).toBe(FLOOR.right)
    expect(legs.some(l => l.kind === 'fly' && l.hop === false)).toBe(true)
  })

  it('apart: runs to the halfway point, then flies one diagonal to the target', () => {
    // Up and to the right, sharing no edge and no column: ord 1 is the high-right panel,
    // ord 2 the low-left one, so travel runs from ord 2 to ord 1.
    const far: DisplayInfo[] = roster([
      { id: 1, primary: true, workArea: { x: 0, y: 0, width: 1000, height: 1000 } },
      { id: 2, primary: false, workArea: { x: 3000, y: -2000, width: 1000, height: 1000 } },
    ])
    const legs = planRoute({ from: byOrd(far, 2)!, to: byOrd(far, 1)!, startVX: 400, landFraction: 0.5, charW: CHAR_W, runThreshold: THRESH })
    // halfway along the source band, then a single diagonal fly, then the trailing walk
    expect(legs[0]).toEqual({ kind: 'walk', to: { x: 500, y: 1000 }, run: false })
    expect(legs[1]).toEqual({ kind: 'fly', to: { x: 3100, y: -1000 }, hop: false })
    expect(legs[2]).toEqual({ kind: 'walk', to: { x: 3500, y: -1000 }, run: true })
  })

  it('honours an explicit run override on every walk leg', () => {
    const legs = route(2, 1, 0.5, 960, true)
    expect(legs.filter(l => l.kind === 'walk').every(l => l.kind === 'walk' && l.run)).toBe(true)
  })
  it('never emits a sub-pixel leg', () => {
    const legs = route(2, 3, 0, 1820) // already at the launch point, lands at the target band min
    expect(legs[0]!.kind).toBe('fly')
  })
})
