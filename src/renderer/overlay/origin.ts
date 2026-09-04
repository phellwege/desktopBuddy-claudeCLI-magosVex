import type { AtlasFrame } from '../../shared/types'

export function originScreenPosition(
  f: AtlasFrame, mirror: boolean, scale: number,
  canvas: { width: number; height: number },
  canvasRect: { left: number; top: number },
  windowPos: { x: number; y: number },
): { x: number; y: number } | null {
  if (!f.origin) return null
  const baselineY = canvas.height - 4
  const dx = canvas.width / 2 - f.ax * scale
  const dy = baselineY - f.ay * scale
  const ox = f.origin[0] * scale, oy = f.origin[1] * scale
  const localX = mirror ? canvas.width - (dx + ox) : dx + ox
  const localY = dy + oy
  return { x: Math.round(windowPos.x + canvasRect.left + localX), y: Math.round(windowPos.y + canvasRect.top + localY) }
}
