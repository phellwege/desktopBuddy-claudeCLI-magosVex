import type { AnimationKey, Animations, Facing } from '../../shared/types'

export class Animator {
  private key: AnimationKey = 'idle'
  private facing: Facing = 'right'
  private index = 0
  private elapsed = 0
  private finished = false
  // Completed passes of the current one-shot. A one-shot with repeat n restarts from frame 0
  // until it has played n times, then reports justFinished exactly once, as before.
  private passes = 0
  constructor(private readonly animations: Animations) {}

  set(key: AnimationKey): void {
    if (key === this.key) return
    this.key = key; this.index = 0; this.elapsed = 0; this.finished = false; this.passes = 0
  }
  setFacing(f: Facing): void { this.facing = f }
  private list(): string[] {
    const def = this.animations[this.key]
    return this.facing === 'left' ? def.left : def.right
  }
  current(): { frame: string; mirror: boolean } {
    const def = this.animations[this.key]
    const list = this.list()
    const frame = list[Math.min(this.index, list.length - 1)] ?? ''
    return { frame, mirror: this.facing === 'left' && def.mirrorLeft }
  }
  advance(dtMs: number): { justFinished: boolean } {
    if (this.finished) return { justFinished: false }
    const def = this.animations[this.key]
    const n = this.list().length
    const frameMs = 1000 / def.fps
    this.elapsed += dtMs
    while (this.elapsed >= frameMs) {
      this.elapsed -= frameMs
      if (this.index + 1 < n) this.index++
      else if (def.loop) this.index = 0
      else if (++this.passes < def.repeat) this.index = 0
      else { this.finished = true; return { justFinished: true } }
    }
    return { justFinished: false }
  }
}
