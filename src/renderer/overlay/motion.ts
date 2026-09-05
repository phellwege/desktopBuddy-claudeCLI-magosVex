// Straight-line motion over virtual-desktop pixels. The position is the character's
// floor-center point, so a walk holds vy constant along a display's bottom edge and a
// flight interpolates both axes at once. Speeds are pixels per second: they used to be a
// fraction of the walk band per second, which made him cross a 5120 px ultrawide 2.7x
// faster than a 1920 px panel.
export interface Point { x: number; y: number }

export class Motion {
  vx: number
  vy: number
  target: Point | undefined
  speed = 0

  constructor(vx = 0, vy = 0) { this.vx = vx; this.vy = vy }

  setTarget(target: Point | undefined, speed: number): void {
    this.target = target
    this.speed = speed
  }
  place(vx: number, vy: number): void {
    this.vx = vx; this.vy = vy; this.target = undefined; this.speed = 0
  }

  advance(dtMs: number): { arrived: boolean } {
    if (this.target === undefined || this.speed <= 0) return { arrived: false }
    const step = this.speed * dtMs / 1000
    const dx = this.target.x - this.vx, dy = this.target.y - this.vy
    const dist = Math.hypot(dx, dy)
    if (dist <= step || dist === 0) {
      this.vx = this.target.x; this.vy = this.target.y
      this.target = undefined
      return { arrived: true }
    }
    this.vx += dx / dist * step
    this.vy += dy / dist * step
    return { arrived: false }
  }
}
