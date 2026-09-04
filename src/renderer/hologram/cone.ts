// Ported from the portfolio's ProjectionOverlay.js, reduced to a single target (the chat
// panel) with no scroll-driven source, no DOM target queries, no planets, and no
// occlusion: the hologram window has exactly one thing to project onto.
const DEFAULT_RGB: [number, number, number] = [91, 192, 190]

// Intensity. The portfolio original sits on a black page; a desktop wallpaper needs a
// much stronger presence, so these are tuned up and kept in one place.
export const LINES = 280            // jittered light lines from the source to the panel edge
export const LINE_ALPHA = 0.34      // base alpha of a line before flicker, fade, and pulse
export const LINE_WIDTH = 0.9       // base stroke width in px
export const WEDGE_ALPHA = 0.16     // filled beam between the source and the panel's bottom edge
export const GLOW_RADIUS = 18       // source glow radius in px

export function hexToRgb(hex: string): [number, number, number] {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex)
  if (short) {
    const [, r, g, b] = short
    return [parseInt(r! + r!, 16), parseInt(g! + g!, 16), parseInt(b! + b!, 16)]
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (long) {
    const [, r, g, b] = long
    return [parseInt(r!, 16), parseInt(g!, 16), parseInt(b!, 16)]
  }
  return DEFAULT_RGB
}

export interface EdgeRect { left: number; top: number; right: number; bottom: number }

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

function getRoundedPoint(rect: EdgeRect, frac: number, rad: number): { x: number; y: number } {
  const width = rect.right - rect.left
  const height = rect.bottom - rect.top
  const r = Math.min(rad, width / 2, height / 2)
  const straightW = width - 2 * r
  const straightH = height - 2 * r
  const cornerArc = Math.PI * r / 2
  const perim = 2 * (straightW + straightH) + 4 * cornerArc
  let d = (((frac % 1) + 1) % 1) * perim

  if (d < straightW) return { x: rect.left + r + d, y: rect.top }
  d -= straightW
  if (d < cornerArc) {
    const a = -Math.PI / 2 + (d / cornerArc) * (Math.PI / 2)
    return { x: rect.right - r + Math.cos(a) * r, y: rect.top + r + Math.sin(a) * r }
  }
  d -= cornerArc
  if (d < straightH) return { x: rect.right, y: rect.top + r + d }
  d -= straightH
  if (d < cornerArc) {
    const a = (d / cornerArc) * (Math.PI / 2)
    return { x: rect.right - r + Math.cos(a) * r, y: rect.bottom - r + Math.sin(a) * r }
  }
  d -= cornerArc
  if (d < straightW) return { x: rect.right - r - d, y: rect.bottom }
  d -= straightW
  if (d < cornerArc) {
    const a = Math.PI / 2 + (d / cornerArc) * (Math.PI / 2)
    return { x: rect.left + r + Math.cos(a) * r, y: rect.bottom - r + Math.sin(a) * r }
  }
  d -= cornerArc
  if (d < straightH) return { x: rect.left, y: rect.bottom - r - d }
  d -= straightH
  const a = Math.PI + (d / cornerArc) * (Math.PI / 2)
  return { x: rect.left + r + Math.cos(a) * r, y: rect.top + r + Math.sin(a) * r }
}

export function edgePoints(rect: EdgeRect, count: number, t: number, rad = 12): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = []
  for (let i = 0; i < count; i++) {
    const jitter = Math.sin(t * 2.3 + i * 0.97) * 0.003 + Math.sin(t * 5.1 + i * 0.31) * 0.002
    const frac = i / count + jitter
    points.push(getRoundedPoint(rect, frac, rad))
  }
  return points
}

export class ProjectionCone {
  private rgb: [number, number, number] = [91, 192, 190]
  private source = { x: 0, y: 0 }
  private target: { left: number; top: number; right: number; bottom: number } | null = null
  private t = 0
  private raf = 0
  constructor(private canvas: HTMLCanvasElement, private lines = LINES) {}
  setColor(hex: string): void { this.rgb = hexToRgb(hex) }
  setSource(x: number, y: number): void { this.source = { x, y } }
  setTarget(rect: DOMRect | null): void { this.target = rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null }
  start(): void { if (!this.raf) this.raf = requestAnimationFrame(this.frame) }
  stop(): void { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.clear() }
  private clear(): void { this.canvas.getContext('2d')!.clearRect(0, 0, this.canvas.width, this.canvas.height) }
  private frame = (): void => { this.draw(); this.raf = requestAnimationFrame(this.frame) }

  private draw(): void {
    const canvas = this.canvas
    const ctx = canvas.getContext('2d')!
    const w = canvas.width, h = canvas.height
    const t = this.t
    this.t += 0.008

    ctx.clearRect(0, 0, w, h)
    const rect = this.target
    if (!rect) return

    const [r, g, b] = this.rgb
    const sourceX = this.source.x, sourceY = this.source.y
    // Distance fade against the canvas diagonal, the farthest a line can actually be -
    // the portfolio original faded against page width, which does not make sense for a
    // window that is often taller than it is wide.
    const diag = Math.hypot(w, h)

    // Soft beam: a filled wedge from the source to the panel's bottom corners, so the
    // projection reads at a glance even where the thin lines get lost in a wallpaper.
    const wedge = ctx.createLinearGradient(sourceX, sourceY, sourceX, rect.bottom)
    wedge.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${WEDGE_ALPHA * (0.85 + Math.sin(t * 2.7) * 0.15)})`)
    wedge.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${WEDGE_ALPHA * 0.3})`)
    ctx.beginPath()
    ctx.moveTo(sourceX, sourceY)
    ctx.lineTo(rect.left, rect.bottom)
    ctx.lineTo(rect.right, rect.bottom)
    ctx.closePath()
    ctx.fillStyle = wedge
    ctx.fill()

    let lineIndex = 0
    for (const pt of edgePoints(rect, this.lines, t)) {
      const dx = pt.x - sourceX
      const dy = pt.y - sourceY
      const dist = Math.sqrt(dx * dx + dy * dy)

      const flicker = 0.6 + Math.sin(t * 3.5 + lineIndex * 0.37) * 0.2 + Math.sin(t * 8.1 + lineIndex * 0.13) * 0.12
      const distFade = Math.max(0, 1 - dist / diag)
      const scanPulse = (Math.sin(t * 3 - dist * 0.005 + lineIndex * 0.04) + 1) * 0.5
      const alpha = flicker * distFade * LINE_ALPHA * (0.5 + scanPulse * 0.5)

      ctx.beginPath()
      ctx.moveTo(sourceX, sourceY)
      ctx.lineTo(pt.x, pt.y)

      const grad = ctx.createLinearGradient(sourceX, sourceY, pt.x, pt.y)
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha * 0.8})`)
      grad.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, ${alpha * 0.2})`)
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${alpha * 1.8})`)
      ctx.strokeStyle = grad
      ctx.lineWidth = LINE_WIDTH + Math.sin(t * 4.5 + lineIndex * 0.47) * 0.3
      ctx.stroke()

      lineIndex++
    }

    // Mask out the panel interior so lines appear to pass behind it.
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = 'rgba(0,0,0,1)'
    roundedRectPath(ctx, rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top, 12)
    ctx.fill()
    ctx.restore()

    // Border glow where projection lines hit the panel edge.
    ctx.save()
    const cx = (rect.left + rect.right) / 2
    const cy = (rect.top + rect.bottom) / 2
    const angleToSource = Math.atan2(sourceY - cy, sourceX - cx)

    const pulse1 = 0.5 + Math.sin(t * 4) * 0.3 + Math.sin(t * 9) * 0.2
    const pulse2 = 0.4 + Math.sin(t * 5.7 + 1.3) * 0.25 + Math.sin(t * 11.3) * 0.15
    const pulse3 = 0.6 + Math.sin(t * 3.2 + 2.7) * 0.2 + Math.sin(t * 7.8) * 0.15
    const baseAlpha = 0.7

    const gradLen = Math.max(rect.right - rect.left, rect.bottom - rect.top)
    const drift = Math.sin(t * 1.5) * 0.15
    const gx1 = cx + Math.cos(angleToSource + drift) * gradLen
    const gy1 = cy + Math.sin(angleToSource + drift) * gradLen
    const gx2 = cx - Math.cos(angleToSource + drift) * gradLen
    const gy2 = cy - Math.sin(angleToSource + drift) * gradLen

    const borderGrad = ctx.createLinearGradient(gx1, gy1, gx2, gy2)
    borderGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${pulse1 * baseAlpha * 0.7})`)
    borderGrad.addColorStop(0.2, `rgba(${r}, ${g}, ${b}, ${pulse2 * baseAlpha * 0.4})`)
    borderGrad.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, ${pulse3 * baseAlpha * 0.15})`)
    borderGrad.addColorStop(0.7, `rgba(${r}, ${g}, ${b}, ${pulse2 * baseAlpha * 0.08})`)
    borderGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)

    ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${pulse1 * baseAlpha})`
    ctx.shadowBlur = 10 + Math.sin(t * 3) * 4 + Math.sin(t * 7.5) * 2
    ctx.strokeStyle = borderGrad
    ctx.lineWidth = 1.2 + Math.sin(t * 6) * 0.3

    roundedRectPath(ctx, rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top, 12)
    ctx.stroke()

    ctx.shadowBlur = 0
    ctx.restore()

    // Source glow.
    const glowSize = GLOW_RADIUS + Math.sin(t * 4) * 4
    const glowGrad = ctx.createRadialGradient(sourceX, sourceY, 0, sourceX, sourceY, glowSize)
    glowGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.4)`)
    glowGrad.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, 0.15)`)
    glowGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
    ctx.fillStyle = glowGrad
    ctx.fillRect(sourceX - glowSize, sourceY - glowSize, glowSize * 2, glowSize * 2)
  }
}
