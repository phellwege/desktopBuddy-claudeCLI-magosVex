// Geometry for the thought bubble's two lead-in dots. Pure, no DOM: placeMutter in
// main.ts feeds it the drawn sprite rect and the bubble rect it has already placed, and
// positions two real elements from what comes back. The point of it: the dots start at
// his HEAD and run in a straight line to the bubble, so a bubble that has been clamped
// away from him by a window edge gets a diagonal trail that still ends on him, instead of
// two circles hanging off the bubble wherever it happens to sit.
export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export type Side = 'above' | 'left' | 'right'

// From the sprite's vertical centre, this fraction of the half-height toward the top:
// about the middle of a hood on a humanoid frame (Peter's call, 2026-09-07).
export const HEAD_FRACTION = 0.75
// Big dot nearest the bubble, small dot nearest him.
export const DOT_SIZES: readonly [number, number] = [12, 8]
export const DOT_FRACTIONS: readonly [number, number] = [0.35, 0.7]
// Keeps the trail start off the bubble's rounded corners.
export const START_INSET = DOT_SIZES[0] / 2 + 2

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

export function headPoint(drawn: Rect): Point {
  return { x: drawn.x + drawn.w / 2, y: drawn.y + drawn.h / 2 - HEAD_FRACTION * (drawn.h / 2) }
}

// The point on the bubble's near edge closest to the head, inset from the corners.
export function trailStart(bubble: Rect, side: Side, head: Point): Point {
  const right = bubble.x + bubble.w
  const bottom = bubble.y + bubble.h
  if (side === 'above') return { x: clamp(head.x, bubble.x + START_INSET, right - START_INSET), y: bottom }
  const y = clamp(head.y, bubble.y + START_INSET, bottom - START_INSET)
  return { x: side === 'left' ? right : bubble.x, y }
}

// Dot centres along the segment from the trail start to the head.
export function trailDots(start: Point, head: Point): Array<{ x: number; y: number; size: number }> {
  return [
    {
      x: start.x + (head.x - start.x) * DOT_FRACTIONS[0],
      y: start.y + (head.y - start.y) * DOT_FRACTIONS[0],
      size: DOT_SIZES[0],
    },
    {
      x: start.x + (head.x - start.x) * DOT_FRACTIONS[1],
      y: start.y + (head.y - start.y) * DOT_FRACTIONS[1],
      size: DOT_SIZES[1],
    },
  ]
}
