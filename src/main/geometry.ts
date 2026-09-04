// Minimum overlay strip height. The overlay canvas itself is always exactly charH tall
// (the pack's own maxFrameSize * scale) and anchored to the bottom of the window, so the
// window must be at least that tall plus a small margin or the top of the sprite clips
// against the window's own top edge.
export const OVERLAY_HEIGHT = 260
export interface Rect { x: number; y: number; width: number; height: number }

export function overlayBounds(wa: Rect, charH: number): Rect {
  const height = Math.max(OVERLAY_HEIGHT, charH + 24)
  return { x: wa.x, y: wa.y + wa.height - height, width: wa.width, height }
}

export const PANEL_SIZE = { width: 480, height: 360 }
export const CONE_SIDE_MARGIN = 120     // room either side of the panel for the cone
export const PANEL_GAP = 16             // gap between the panel bottom and the character's top
export const SKULL_REACH = 0.75         // window bottom reaches this far down the character

export function hologramBounds(wa: Rect, xFraction: number, charW: number, charH: number): Rect {
  const width = PANEL_SIZE.width + 2 * CONE_SIDE_MARGIN
  const cx = wa.x + xFraction * Math.max(0, wa.width - charW) + charW / 2
  const bias = cx < wa.x + wa.width / 2 ? 1 : -1
  let x = Math.round(cx - width / 2 + bias * PANEL_SIZE.width * 0.25)
  x = Math.max(wa.x, Math.min(wa.x + wa.width - width, x))
  const charTop = wa.y + wa.height - charH
  const y = Math.max(wa.y, charTop - PANEL_SIZE.height - PANEL_GAP)
  const bottom = Math.min(wa.y + wa.height, charTop + charH * SKULL_REACH)
  return { x, y, width, height: Math.max(PANEL_SIZE.height, Math.round(bottom - y)) }
}

export function originToWindow(origin: { x: number; y: number }, b: Rect): { x: number; y: number } {
  return { x: origin.x - b.x, y: origin.y - b.y }
}
