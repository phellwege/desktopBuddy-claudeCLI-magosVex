import type { BuddyState, EmoteKind, Mood, PlannedLeg } from '../shared/types'
import type { Buddy } from './buddy'

// What the model and the user see of a display: a stable ordinal, its pixel size, and
// whether it is the primary or the one he is standing on.
export interface DisplaySummary { ord: number; width: number; height: number; primary: boolean; current: boolean }

export interface ActionHost {
  showPanel(): void; hidePanel(): void; pushSystem(text: string): void; log(line: string): void
  // Width of the current display's walk band, in pixels: speeds are px/s, so converting an
  // x fraction into a distance needs it. Defaults to a 1920 px display when absent, which
  // reproduces the timeouts this had before speeds became pixel-based.
  bandWidth?(): number
  // The display roster, and a planner that turns a target into a route. Both are supplied
  // by main, which owns the Electron screen module. Absent in tests and wherever there is
  // nothing to plan across, in which case travel degrades to a plain same-screen move.
  displays?(): DisplaySummary[]
  planTravel?(display: number, xFraction: number, run?: boolean): { legs: PlannedLeg[]; estimatedMs: number }
  // Called with the whole route before the first leg starts, so the overlay window can grow
  // to span both displays (and the panel can step aside) before anything moves.
  beginFlight?(legs: PlannedLeg[]): void
}
export const DEFAULT_BAND_WIDTH = 1720

// How long a commanded move is given to report arrival before Actions gives up on it and
// resolves anyway: the time the move should take at its speed, plus a 2 s cushion for
// the overlay to actually render and report the arrival event. Distance and speed must
// share a unit; both are pixels and pixels per second.
export function arrivalTimeoutMs(distance: number, speed: number): number {
  return Math.ceil((distance / speed) * 1000) + 2000
}

export interface BuddyActions {
  goTo(xFraction: number, opts?: { run?: boolean }): Promise<void>
  travel(legs: PlannedLeg[], estimatedMs: number): Promise<void>
  goToDisplay(display: number | undefined, xFraction: number, opts?: { run?: boolean }): Promise<void>
  displays(): DisplaySummary[]
  /** null when the ordinal names an attached display, otherwise the error to show. */
  checkDisplay(display: number): string | null
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

  // The move currently awaiting arrival, if any: a new commanded move supersedes it,
  // which settles its promise and drops its timer and listener so a stale timeout can
  // never force-complete the move that replaced it.
  private pendingMove: (() => void) | undefined

  // Resolves on the overlay's arrival event, or after arrivalTimeoutMs if it never comes
  // (the overlay hidden, or a report lost): the wander scheduler must not stay stuck in
  // walking forever, so on timeout this settles the move itself and logs one line.
  // Shared journey machinery for goTo and travel: begin() starts the movement and returns
  // the timeout to allow, or undefined if there was nothing to do. On timeout the journey
  // is force-completed, draining any remaining legs, so a lost renderer report cannot wedge
  // him mid-stride or mid-air forever.
  private journey(begin: () => number | undefined, describe: (ms: number) => string): Promise<void> {
    return new Promise((resolve) => {
      this.pendingMove?.()
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        off()
        if (this.pendingMove === settle) this.pendingMove = undefined
        resolve()
      }
      const off = this.buddy.onArrive(settle)
      this.pendingMove = settle
      const ms = begin()
      if (ms === undefined) { settle(); return }
      timer = setTimeout(() => {
        this.host.log(describe(ms))
        settle()
        if (this.buddy.getState().leg === undefined) { this.buddy.arrived(); return }
        // Drain the rest of the queue; the guard is paranoia against a leg list that never
        // empties, which would otherwise spin here forever.
        for (let i = 0; i < 16 && this.buddy.getState().leg !== undefined; i++) this.buddy.arrived()
      }, ms)
    })
  }

  private bandWidth(): number { return this.host.bandWidth?.() ?? DEFAULT_BAND_WIDTH }

  goTo(xFraction: number, opts?: { run?: boolean }): Promise<void> {
    const startX = this.buddy.getState().x
    return this.journey(
      () => {
        this.buddy.goTo(xFraction, opts?.run)
        const targetX = this.buddy.getState().targetX
        if (targetX === undefined) return undefined
        return arrivalTimeoutMs(Math.abs(targetX - startX) * this.bandWidth(), this.buddy.view().speed)
      },
      (ms) => `arrival timeout: goTo(${xFraction}) never reported arrival after ${ms} ms`,
    )
  }

  displays(): DisplaySummary[] {
    return this.host.displays?.() ?? [{ ord: 1, width: 0, height: 0, primary: true, current: true }]
  }
  checkDisplay(display: number): string | null {
    const list = this.displays()
    if (list.some(d => d.ord === display)) return null
    return `no display ${display} (${list.length === 1 ? 'only 1 attached' : `1-${list.length} attached`})`
  }

  // The one entry point for a commanded move. Without a display, or on a build with no
  // roster to plan against, this is exactly the old same-screen walk.
  async goToDisplay(display: number | undefined, xFraction: number, opts?: { run?: boolean }): Promise<void> {
    const planned = display === undefined ? undefined : this.host.planTravel?.(display, xFraction, opts?.run)
    if (!planned) { await this.goTo(xFraction, opts); return }
    await this.travel(planned.legs, planned.estimatedMs)
  }

  travel(legs: PlannedLeg[], estimatedMs: number): Promise<void> {
    return this.journey(
      () => {
        if (legs.length === 0) { this.buddy.travel(legs); return undefined }
        this.host.beginFlight?.(legs)
        this.buddy.travel(legs)
        return estimatedMs + 2000
      },
      (ms) => `arrival timeout: travel of ${legs.length} legs never reported arrival after ${ms} ms`,
    )
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
