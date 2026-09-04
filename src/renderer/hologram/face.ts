import type { Atlas, Expression } from '../../shared/types'

export function scanlineRows(height: number): number[] {
  const rows: number[] = []
  for (let y = 0; y < height; y += 3) rows.push(y)
  return rows
}
export function tintAlpha(): number { return 0.55 }

export class HoloFace {
  constructor(private image: HTMLImageElement, private atlas: Atlas,
    private faces: Record<Expression, string>, private accent: string) {}

  render(expression: Expression, size = 56): HTMLCanvasElement {
    // Guaranteed present: the loader validates every faces entry against real atlas frames
    // (src/main/pack.ts resolveFaces) before a pack is ever accepted.
    const f = this.atlas.frames[this.faces[expression] ?? this.faces.neutral]!
    const c = document.createElement('canvas')
    c.className = 'face'
    const scale = size / Math.max(f.w, f.h)
    c.width = Math.round(f.w * scale)
    c.height = Math.round(f.h * scale)
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(this.image, f.x, f.y, f.w, f.h, 0, 0, c.width, c.height)
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillStyle = this.accent
    ctx.globalAlpha = tintAlpha()
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.globalAlpha = 0.25
    ctx.fillStyle = '#000'
    for (const y of scanlineRows(c.height)) ctx.fillRect(0, y, c.width, 1)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    return c
  }
}
