// Display roster and route planning. Pure: no Electron import, so all of it is unit
// testable against fixture rects. Every coordinate here is a virtual-desktop pixel, and
// every position is the character's floor-center point (the spot under the middle of him,
// on the bottom edge of a display's work area). Virtual coordinates are routinely
// negative: a monitor placed above or left of the primary has a negative origin.
import type { Rect } from './geometry'
import { FLY_SPEED, RUN_SPEED, WALK_SPEED, type Facing, type Leg, type PlannedLeg, type Point } from '../shared/types'

export type { Leg, PlannedLeg, Point }

export interface ScreenLike { id: number; workArea: Rect; primary: boolean }
export interface DisplayInfo { ord: number; id: number; wa: Rect; primary: boolean }

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const clamp01 = (n: number): number => clamp(n, 0, 1)

// Ordinals are 1-based, top-to-bottom then left-to-right, re-derived on every roster
// change. Deliberately not Electron's display ids: those are opaque, unfriendly to type
// in /goto, and can renumber across a driver or hotplug event. The id is kept alongside
// so a caller can still match a roster entry back to a live Display.
export function roster(screens: ScreenLike[]): DisplayInfo[] {
  return [...screens]
    .sort((a, b) => a.workArea.y - b.workArea.y || a.workArea.x - b.workArea.x || a.id - b.id)
    .map((s, i) => ({ ord: i + 1, id: s.id, wa: s.workArea, primary: s.primary }))
}

export function byOrd(list: DisplayInfo[], ord: number): DisplayInfo | undefined {
  return list.find(d => d.ord === ord)
}
export function byId(list: DisplayInfo[], id: number): DisplayInfo | undefined {
  return list.find(d => d.id === id)
}
export function primaryOf(list: DisplayInfo[]): DisplayInfo {
  return list.find(d => d.primary) ?? list[0]!
}

export type Relation = 'same' | 'beside' | 'above' | 'below' | 'apart'

// Half-open overlap: two ranges that merely touch at an edge do not overlap.
const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1

export function relate(from: Rect, to: Rect): Relation {
  if (from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height) return 'same'
  const fx0 = from.x, fx1 = from.x + from.width, fy0 = from.y, fy1 = from.y + from.height
  const tx0 = to.x, tx1 = to.x + to.width, ty0 = to.y, ty1 = to.y + to.height
  const yOverlap = overlaps(fy0, fy1, ty0, ty1)
  // Beside: the work areas share a vertical edge and their vertical extents overlap, so
  // there is a seam he can hop across at (roughly) floor level.
  if ((fx1 === tx0 || tx1 === fx0) && yOverlap) return 'beside'
  // Above or below: vertically disjoint with a shared column he can rise or drop through.
  if (!yOverlap && overlaps(fx0, fx1, tx0, tx1)) return ty1 <= fy0 ? 'above' : 'below'
  // Everything else: diagonal, corner-touching, or physically separated.
  return 'apart'
}

export function floorY(wa: Rect): number { return wa.y + wa.height }

// The range his floor-center can occupy on a display: half a character in from each edge,
// which is the same span today's 0..1 fraction covers (wa.width - charW). Degenerates to a
// single point if the character is wider than the display.
export function walkBand(wa: Rect, charW: number): { min: number; max: number } {
  const half = charW / 2
  const min = wa.x + half
  const max = wa.x + wa.width - half
  if (max < min) { const mid = wa.x + wa.width / 2; return { min: mid, max: mid } }
  return { min, max }
}

export function fromFraction(f: number, wa: Rect, charW: number): number {
  const b = walkBand(wa, charW)
  return b.min + clamp01(f) * (b.max - b.min)
}
export function toFraction(vx: number, wa: Rect, charW: number): number {
  const b = walkBand(wa, charW)
  return b.max === b.min ? 0 : clamp01((vx - b.min) / (b.max - b.min))
}

export interface RouteArgs {
  from: DisplayInfo
  to: DisplayInfo
  startVX: number          // current floor-center x, virtual px
  landFraction: number     // requested 0..1 position on the target display
  charW: number
  runThreshold: number     // fraction of the source walk band above which a walk becomes a run
  run?: boolean            // explicit override from /run or the tool's run flag
}

// A leg shorter than this is not worth emitting: it would be a sub-pixel walk that the
// renderer would report as an instant arrival anyway.
const MIN_LEG_PX = 0.5

export function planRoute(a: RouteArgs): Leg[] {
  const fromFloor = floorY(a.from.wa), toFloor = floorY(a.to.wa)
  const fromBand = walkBand(a.from.wa, a.charW), toBand = walkBand(a.to.wa, a.charW)
  const legs: Leg[] = []

  const pushWalk = (fromX: number, toX: number, floor: number, band: { min: number; max: number }): void => {
    if (Math.abs(toX - fromX) <= MIN_LEG_PX) return
    const span = band.max - band.min
    const run = a.run ?? (span > 0 && Math.abs(toX - fromX) / span >= a.runThreshold)
    legs.push({ kind: 'walk', to: { x: toX, y: floor }, run })
  }

  // Same display: exactly today's behavior, one walk along the current floor.
  if (a.from.ord === a.to.ord) {
    pushWalk(a.startVX, fromFraction(a.landFraction, a.from.wa, a.charW), fromFloor, fromBand)
    return legs
  }

  const landVX = fromFraction(a.landFraction, a.to.wa, a.charW)
  const rel = relate(a.from.wa, a.to.wa)
  let launchVX: number, touchVX: number, hop = false

  if (rel === 'beside') {
    // Run to the seam, hop across it, land just inside the other display.
    const goingRight = a.to.wa.x > a.from.wa.x
    launchVX = goingRight ? fromBand.max : fromBand.min
    touchVX = goingRight ? toBand.min : toBand.max
    hop = true
  } else if (rel === 'above' || rel === 'below') {
    // Rise or drop straight through the shared column, as close to the requested landing
    // spot as that column allows, so the trailing walk is usually zero.
    const lo = Math.max(fromBand.min, toBand.min), hi = Math.min(fromBand.max, toBand.max)
    launchVX = lo <= hi ? clamp(landVX, lo, hi) : clamp(landVX, fromBand.min, fromBand.max)
    touchVX = clamp(launchVX, toBand.min, toBand.max)
  } else {
    // Diagonal or separated (Peter, 2026-09-04): run to the halfway point along this
    // display's floor, then hover up or down and over to the target in one straight line.
    launchVX = (fromBand.min + fromBand.max) / 2
    touchVX = clamp(launchVX, toBand.min, toBand.max)
  }

  pushWalk(a.startVX, launchVX, fromFloor, fromBand)
  legs.push({ kind: 'fly', to: { x: touchVX, y: toFloor }, hop })
  pushWalk(touchVX, clamp(landVX, toBand.min, toBand.max), toFloor, toBand)
  return legs
}

export function legSpeed(leg: Leg): number {
  if (leg.kind === 'fly') return FLY_SPEED
  return leg.run ? RUN_SPEED : WALK_SPEED
}

// Annotates each leg with where he stands once it completes, so the state machine can play
// the queue without knowing any display geometry. Everything from the fly leg onward is on
// the target display; the walk before it is still on the source.
export function planTravel(a: RouteArgs): PlannedLeg[] {
  const legs = planRoute(a)
  const flyIndex = legs.findIndex(l => l.kind === 'fly')
  let prevX = a.startVX
  return legs.map((leg, i) => {
    const onTarget = flyIndex >= 0 && i >= flyIndex
    const d = onTarget ? a.to : a.from
    const facing: Facing = leg.to.x === prevX ? (a.to.wa.x >= a.from.wa.x ? 'right' : 'left')
      : leg.to.x > prevX ? 'right' : 'left'
    prevX = leg.to.x
    return { ...leg, display: d.ord, fraction: toFraction(leg.to.x, d.wa, a.charW), facing }
  })
}

// Rough wall-clock cost of a journey, used only to size the arrival timeout that stops a
// lost renderer report from wedging him mid-flight forever.
export function routeDurationMs(legs: PlannedLeg[], start: Point): number {
  let at = start, total = 0
  for (const leg of legs) {
    total += Math.hypot(leg.to.x - at.x, leg.to.y - at.y) / legSpeed(leg) * 1000
    at = leg.to
  }
  return Math.ceil(total)
}
