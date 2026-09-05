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
    // Faces sit side by side in the log; on one shared keyframe schedule they pulse in
    // lockstep, which reads as one animation. A random phase and a slightly different
    // period per face makes each one flicker on its own.
    c.style.animationDuration = `${(2.6 + Math.random() * 1.2).toFixed(2)}s`
    c.style.animationDelay = `-${(Math.random() * 3).toFixed(2)}s`
    const scale = size / Math.max(f.w, f.h)
    // CSS size is what the bubble lays out; the backing store follows the device pixel
    // ratio so the face stays crisp on HiDPI screens instead of being upscaled by the
    // compositor.
    const cssW = Math.round(f.w * scale)
    const cssH = Math.round(f.h * scale)
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    c.width = Math.round(cssW * dpr)
    c.height = Math.round(cssH * dpr)
    c.style.width = `${cssW}px`
    c.style.height = `${cssH}px`
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(this.image, f.x, f.y, f.w, f.h, 0, 0, c.width, c.height)
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillStyle = this.accent
    ctx.globalAlpha = tintAlpha()
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.globalAlpha = 0.25
    ctx.fillStyle = '#000'
    for (const y of scanlineRows(cssH)) ctx.fillRect(0, y * dpr, c.width, dpr)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    return c
  }
}
