// Minimum overlay strip height. The overlay canvas itself is always exactly charH tall
// (the pack's own maxFrameSize * scale) and anchored to the bottom of the window, so the
// window must be at least that tall plus a small margin or the top of the sprite clips
// against the window's own top edge.
export const OVERLAY_HEIGHT = 260
// Rect lives in shared/types so the renderer can name it too; re-exported here because
// every caller of this module already imports its geometry from it.
export type { Rect } from '../shared/types'
import type { Rect } from '../shared/types'

export function overlayBounds(wa: Rect, charH: number): Rect {
  const height = Math.max(OVERLAY_HEIGHT, charH + 24)
  return { x: wa.x, y: wa.y + wa.height - height, width: wa.width, height }
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

// Margin around the travel rect, so a sprite drawn a few pixels outside the strict union
// (the baseline inset, a rounding step) is not clipped by the window edge.
export const TRAVEL_MARGIN = 8

// Bounds the overlay window takes for the duration of a flight. A straight line between
// two points inside a bounding box stays inside it, so the union of the two work areas
// contains the whole path; each display's own work area already provides the headroom
// above its floor that the character occupies while standing there.
export function travelBounds(from: Rect, to: Rect): Rect {
  const u = unionRect(from, to)
  return { x: u.x - TRAVEL_MARGIN, y: u.y - TRAVEL_MARGIN, width: u.width + 2 * TRAVEL_MARGIN, height: u.height + 2 * TRAVEL_MARGIN }
}

export const PANEL_SIZE = { width: 480, height: 360 }
// The panel while the CLI tab is active (spec 2026-09-07-cli-tab-design, 6): about 95
// columns by 26 rows at the pack's 12 px monospace font.
export const CLI_PANEL_SIZE = { width: 700, height: 480 }
export const CONE_SIDE_MARGIN = 120     // room either side of the panel for the cone
export const PANEL_GAP = 16             // gap between the panel bottom and the character's top
export const SKULL_REACH = 0.75         // window bottom reaches this far down the character

export function hologramBounds(wa: Rect, xFraction: number, charW: number, charH: number, panel = PANEL_SIZE): Rect {
  const width = panel.width + 2 * CONE_SIDE_MARGIN
  const cx = wa.x + xFraction * Math.max(0, wa.width - charW) + charW / 2
  const bias = cx < wa.x + wa.width / 2 ? 1 : -1
  let x = Math.round(cx - width / 2 + bias * panel.width * 0.25)
  x = Math.max(wa.x, Math.min(wa.x + wa.width - width, x))
  const charTop = wa.y + wa.height - charH
  const y = Math.max(wa.y, charTop - panel.height - PANEL_GAP)
  const bottom = Math.min(wa.y + wa.height, charTop + charH * SKULL_REACH)
  return { x, y, width, height: Math.max(panel.height, Math.round(bottom - y)) }
}

export function originToWindow(origin: { x: number; y: number }, b: Rect): { x: number; y: number } {
  return { x: origin.x - b.x, y: origin.y - b.y }
}

// Minimum x-fraction movement before the hologram is worth re-placing mid-walk. Small
// enough to track a walking character, large enough not to thrash setBounds on every
// per-frame origin report (which fires whenever the drawn origin moves by a pixel or more).
export const HOLOGRAM_REPLACE_THRESHOLD = 0.005

export function shouldReplaceHologramX(lastPlacedX: number, xFraction: number): boolean {
  return Math.abs(xFraction - lastPlacedX) > HOLOGRAM_REPLACE_THRESHOLD
}
