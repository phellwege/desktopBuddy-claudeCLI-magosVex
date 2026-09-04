import type { AtlasFrame } from '../../shared/types'

export class HitTester {
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  private w = 0
  private h = 0
  update(image: CanvasImageSource, frame: AtlasFrame): void {
    this.w = frame.w; this.h = frame.h
    this.canvas.width = frame.w; this.canvas.height = frame.h
    this.ctx.clearRect(0, 0, frame.w, frame.h)
    this.ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h)
  }
  hit(fx: number, fy: number): boolean {
    if (fx < 0 || fy < 0 || fx >= this.w || fy >= this.h) return false
    return (this.ctx.getImageData(Math.floor(fx), Math.floor(fy), 1, 1).data[3] ?? 0) > 40
  }
}
