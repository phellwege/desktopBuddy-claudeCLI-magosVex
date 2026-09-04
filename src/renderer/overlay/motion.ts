export class Motion {
  x: number
  target: number | undefined
  speed = 0
  constructor(x = 0.5) { this.x = x }
  setTarget(target: number | undefined, speed: number): void { this.target = target; this.speed = speed }
  advance(dtMs: number): { arrived: boolean } {
    if (this.target === undefined || this.speed <= 0) return { arrived: false }
    const step = this.speed * dtMs / 1000
    const d = this.target - this.x
    if (Math.abs(d) <= step) { this.x = this.target; this.target = undefined; return { arrived: true } }
    this.x += Math.sign(d) * step
    return { arrived: false }
  }
}
