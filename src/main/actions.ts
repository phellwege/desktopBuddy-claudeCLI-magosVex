import type { BuddyState, EmoteKind, Mood } from '../shared/types'
import type { Buddy } from './buddy'

export interface ActionHost { showPanel(): void; hidePanel(): void; pushSystem(text: string): void; log(line: string): void }

// How long a commanded move is given to report arrival before Actions gives up on it and
// resolves anyway: the time the move should take at its speed, plus a 2 s cushion for
// the overlay to actually render and report the arrival event.
export function arrivalTimeoutMs(distance: number, speed: number): number {
  return Math.ceil((distance / speed) * 1000) + 2000
}

export interface BuddyActions {
  goTo(xFraction: number, opts?: { run?: boolean }): Promise<void>
  setMood(mood: Mood): void
  emote(kind: EmoteKind): Promise<void>
  say(text: string): void
  openPanel(): void
  closePanel(): void
  sleep(): void
  wake(): void
  getState(): BuddyState
}

const EMOTE_ANIMS = new Set(['emote_happy', 'emote_thinking', 'emote_confused', 'emote_alarmed', 'look', 'hop', 'fall'])

export class Actions implements BuddyActions {
  constructor(private readonly buddy: Buddy, private readonly host: ActionHost) {}

  // Resolves on the overlay's arrival event, or after arrivalTimeoutMs if it never comes
  // (the overlay hidden, or a report lost): the wander scheduler must not stay stuck in
  // walking forever, so on timeout this settles the move itself and logs one line.
  goTo(xFraction: number, opts?: { run?: boolean }): Promise<void> {
    return new Promise((resolve) => {
      const startX = this.buddy.getState().x
      let timer: ReturnType<typeof setTimeout> | undefined
      const off = this.buddy.onArrive(() => {
        if (timer !== undefined) clearTimeout(timer)
        off()
        resolve()
      })
      this.buddy.goTo(xFraction, opts?.run)
      const targetX = this.buddy.getState().targetX
      if (targetX === undefined) { off(); resolve(); return }
      const distance = Math.abs(targetX - startX)
      const speed = this.buddy.view().speed
      timer = setTimeout(() => {
        off()
        this.buddy.arrived()
        this.host.log(`arrival timeout: goTo(${xFraction}) never reported arrival (distance ${distance.toFixed(3)}, speed ${speed})`)
        resolve()
      }, arrivalTimeoutMs(distance, speed))
    })
  }
  setMood(mood: Mood): void { this.buddy.setMood(mood) }
  emote(kind: EmoteKind): Promise<void> {
    return new Promise((resolve) => {
      const result = this.buddy.emote(kind)
      if (result === 'dropped') { resolve(); return }
      if (result === 'started') {
        if (!EMOTE_ANIMS.has(this.buddy.view().animation)) { resolve(); return }
        this.waitUntilEmoteEnds(resolve, 5000, false)
        return
      }
      // queued behind movement: wait for the sequence "enters the emote set, then leaves it"
      this.waitUntilEmoteEnds(resolve, 15000, true)
    })
  }
  // Shared tail logic for a playing (or about-to-play) emote: resolves once the animation
  // has left the emote set, or after timeoutMs, whichever comes first. When waitForEntry is
  // true it first waits for the animation to enter the emote set (a queued emote has not
  // started playing yet), then waits for it to leave; one onChange subscription either way.
  private waitUntilEmoteEnds(resolve: () => void, timeoutMs: number, waitForEntry: boolean): void {
    let entered = !waitForEntry
    const timer = setTimeout(() => { off(); resolve() }, timeoutMs)
    const off = this.buddy.onChange((v) => {
      const inSet = EMOTE_ANIMS.has(v.animation)
      if (!entered) { if (inSet) entered = true; return }
      if (!inSet) { clearTimeout(timer); off(); resolve() }
    })
  }
  say(text: string): void { this.host.pushSystem(text); this.openPanel() }
  openPanel(): void { this.buddy.openPanel(); this.host.showPanel() }
  closePanel(): void { this.buddy.closePanel(); this.host.hidePanel() }
  // Sleeping from the panel (typed /sleep, or the sleep tool) closes it first so the
  // hologram window is hidden through the one path that owns it.
  sleep(): void { if (this.buddy.getState().panelOpen) this.closePanel(); this.buddy.sleep() }
  wake(): void { this.buddy.wake() }
  getState(): BuddyState { return this.buddy.getState() }
}
