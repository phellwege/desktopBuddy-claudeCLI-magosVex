// Minimum overlay strip height. The overlay canvas itself is always exactly charH tall
// (the pack's own maxFrameSize * scale) and anchored to the bottom of the window, so the
// window must be at least that tall plus a small margin or the top of the sprite clips
// against the window's own top edge.
export const OVERLAY_HEIGHT = 260
export const HOLOGRAM_SIZE = { width: 480, height: 360 }
export interface Rect { x: number; y: number; width: number; height: number }

export function overlayBounds(wa: Rect, charH: number): Rect {
  const height = Math.max(OVERLAY_HEIGHT, charH + 24)
  return { x: wa.x, y: wa.y + wa.height - height, width: wa.width, height }
}

export function hologramBounds(wa: Rect, xFraction: number, charW: number, charH: number): Rect {
  const cx = wa.x + xFraction * Math.max(0, wa.width - charW) + charW / 2
  const bias = cx < wa.x + wa.width / 2 ? 1 : -1
  let x = Math.round(cx - HOLOGRAM_SIZE.width / 2 + bias * HOLOGRAM_SIZE.width * 0.35)
  x = Math.max(wa.x, Math.min(wa.x + wa.width - HOLOGRAM_SIZE.width, x))
  const charTop = wa.y + wa.height - charH
  const y = Math.max(wa.y, charTop - HOLOGRAM_SIZE.height + 24)
  return { x, y, width: HOLOGRAM_SIZE.width, height: HOLOGRAM_SIZE.height }
}
