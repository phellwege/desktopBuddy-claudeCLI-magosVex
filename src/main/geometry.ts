export const OVERLAY_HEIGHT = 260
export const HOLOGRAM_SIZE = { width: 480, height: 360 }
export interface Rect { x: number; y: number; width: number; height: number }

export function overlayBounds(wa: Rect): Rect {
  return { x: wa.x, y: wa.y + wa.height - OVERLAY_HEIGHT, width: wa.width, height: OVERLAY_HEIGHT }
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
