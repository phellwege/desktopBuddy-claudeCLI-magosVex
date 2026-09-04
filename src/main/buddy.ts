import type { Activity, AnimationKey, BuddyState, EmoteKind, Facing, Mood } from '../shared/types'
import { RUN_SPEED, WALK_SPEED } from '../shared/types'

export interface BuddyOptions {
  rng?: () => number
  wanderIntervalMs?: [number, number]
  restMs?: [number, number]
  sleepAfterMs?: number
  runThreshold?: number
  initialX?: number
  initialMood?: Mood
}
export interface BuddyView { state: BuddyState; animation: AnimationKey; speed: number }

const RESTFUL: Activity[] = ['idle', 'sitting', 'looking']
const EMOTE_ANIM: Record<EmoteKind, AnimationKey> = {
  happy: 'emote_happy', thinking: 'emote_thinking', confused: 'emote_confused',
  alarmed: 'emote_alarmed', look: 'look', hop: 'hop',
}
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export class Buddy {
  private readonly rng: () => number
  private readonly wander: [number, number]
  private readonly rest: [number, number]
  private readonly sleepAfter: number
  private readonly runThreshold: number

  private x: number
  private facing: Facing = 'right'
  private activity: Activity = 'idle'
  private mood: Mood
  private panelOpen = false
  private asleep = false
  private targetX: number | undefined
  private commanded = false
  private now = 0
  private started = false
  private lastInteractionAt = 0
  private nextWanderAt = Infinity
  private restUntil: number | undefined
  private queuedEmote: EmoteKind | undefined
  private pendingSleep = false
  private resumeActivity: Activity = 'idle'
  private currentEmote: AnimationKey = 'idle'
  private changeListeners: Array<(v: BuddyView) => void> = []
  private arriveListeners: Array<() => void> = []
  private lastViewKey = ''

  constructor(opts: BuddyOptions = {}) {
    this.rng = opts.rng ?? Math.random
    this.wander = opts.wanderIntervalMs ?? [8000, 30000]
    this.rest = opts.restMs ?? [5000, 20000]
    this.sleepAfter = opts.sleepAfterMs ?? 600000
    this.runThreshold = opts.runThreshold ?? 0.25
    this.x = clamp01(opts.initialX ?? 0.5)
    this.mood = opts.initialMood ?? 'calm'
    this.lastViewKey = JSON.stringify(this.view())
  }

  onChange(l: (v: BuddyView) => void): () => void {
    this.changeListeners.push(l)
    return () => { this.changeListeners = this.changeListeners.filter(x => x !== l) }
  }
  onArrive(l: () => void): () => void {
    this.arriveListeners.push(l)
    return () => { this.arriveListeners = this.arriveListeners.filter(x => x !== l) }
  }

  getState(): BuddyState {
    return { x: this.x, facing: this.facing, activity: this.activity, mood: this.mood,
      panelOpen: this.panelOpen, asleep: this.asleep, targetX: this.targetX }
  }
  view(): BuddyView {
    return { state: this.getState(), animation: this.animation(), speed: this.speed() }
  }

  private animation(): AnimationKey {
    switch (this.activity) {
      case 'sleeping': return 'sleep'
      case 'projecting': return this.mood === 'thinking' ? 'emote_thinking' : 'project'
      case 'walking': return 'walk'
      case 'running': return 'run'
      case 'sitting': return 'sit'
      case 'looking': return 'look'
      case 'hopping': return this.currentEmote
      case 'emoting': return this.currentEmote
      default: return 'idle'
    }
  }
  private speed(): number {
    return this.activity === 'walking' ? WALK_SPEED : this.activity === 'running' ? RUN_SPEED : 0
  }
  private rand(range: [number, number]): number {
    return range[0] + this.rng() * (range[1] - range[0])
  }
  private emit(): void {
    const v = this.view()
    const key = JSON.stringify(v)
    if (key === this.lastViewKey) return
    this.lastViewKey = key
    for (const l of this.changeListeners) l(v)
  }
  private scheduleWander(): void { this.nextWanderAt = this.now + this.rand(this.wander) }
  private applyThinkingIfRestful(): void {
    if (this.mood === 'thinking' && RESTFUL.includes(this.activity)) {
      this.resumeActivity = this.activity
      this.currentEmote = 'emote_thinking'
      this.activity = 'emoting'
    }
  }
  private startMove(target: number, run: boolean, commanded: boolean): void {
    this.targetX = clamp01(target)
    this.commanded = commanded
    this.restUntil = undefined
    if (Math.abs(this.targetX - this.x) < 0.001) { this.arrived(); return }
    this.facing = this.targetX > this.x ? 'right' : 'left'
    this.activity = run ? 'running' : 'walking'
  }

  tick(now: number): void {
    this.now = now
    if (!this.started) {
      this.started = true
      this.lastInteractionAt = now
      this.scheduleWander()
      return
    }
    if (this.asleep || this.panelOpen) return
    if (RESTFUL.includes(this.activity) && now - this.lastInteractionAt >= this.sleepAfter) {
      this.asleep = true
      this.activity = 'sleeping'
      this.restUntil = undefined
      this.emit()
      return
    }
    if ((this.activity === 'sitting' || this.activity === 'looking') && this.restUntil !== undefined && now >= this.restUntil) {
      this.activity = 'idle'
      this.restUntil = undefined
      this.scheduleWander()
      this.emit()
    }
    if (this.activity === 'idle' && now >= this.nextWanderAt) {
      let target = this.rng()
      if (Math.abs(target - this.x) < 0.05) target = clamp01(this.x < 0.5 ? this.x + 0.3 : this.x - 0.3)
      const run = Math.abs(target - this.x) >= this.runThreshold
      this.startMove(target, run, false)
      this.emit()
    }
  }

  arrived(): void {
    if (this.targetX !== undefined) this.x = this.targetX
    this.targetX = undefined
    const wasCommanded = this.commanded
    this.commanded = false
    if (this.pendingSleep && !this.panelOpen) {
      this.pendingSleep = false
      this.queuedEmote = undefined
      this.asleep = true
      this.activity = 'sleeping'
      this.restUntil = undefined
      for (const l of this.arriveListeners) l()
      this.emit()
      return
    }
    if (this.panelOpen) {
      this.activity = 'projecting'
    } else if (this.queuedEmote) {
      const kind = this.queuedEmote
      this.queuedEmote = undefined
      this.activity = 'idle'
      this.resumeActivity = 'idle'
      this.beginEmote(kind)
    } else if (wasCommanded) {
      this.activity = 'idle'
      this.applyThinkingIfRestful()
      if (this.activity === 'idle') this.scheduleWander()
    } else {
      const pick = this.rng()
      const restLen = this.rand(this.rest)
      if (pick < 1 / 3) { this.activity = 'idle'; this.nextWanderAt = this.now + restLen }
      else if (pick < 2 / 3) { this.activity = 'sitting'; this.restUntil = this.now + restLen }
      else { this.activity = 'looking'; this.restUntil = this.now + restLen }
      this.applyThinkingIfRestful()
    }
    for (const l of this.arriveListeners) l()
    this.emit()
  }

  oneShotDone(): void {
    if (this.activity === 'hopping' && this.currentEmote === 'hop') {
      this.currentEmote = 'fall'
      this.emit()
      return
    }
    if (this.activity === 'hopping' || this.activity === 'emoting') {
      this.activity = this.resumeActivity
      this.applyThinkingIfRestful()
      if (this.activity === 'idle') this.scheduleWander()
      this.emit()
      return
    }
    if (this.activity === 'looking') {
      this.activity = 'idle'
      this.nextWanderAt = this.restUntil ?? this.now + this.rand(this.wander)
      this.restUntil = undefined
      this.applyThinkingIfRestful()
      this.emit()
    }
  }

  private beginEmote(kind: EmoteKind): void {
    if (!RESTFUL.includes(this.activity) && this.activity !== 'emoting' && this.activity !== 'hopping') return
    if (RESTFUL.includes(this.activity)) this.resumeActivity = this.activity
    this.currentEmote = EMOTE_ANIM[kind]
    this.activity = kind === 'hop' ? 'hopping' : kind === 'look' ? 'looking' : 'emoting'
  }

  emote(kind: EmoteKind): 'started' | 'queued' | 'dropped' {
    if (this.asleep) return 'dropped'
    if (kind === 'thinking') {
      const before = this.animation()
      this.setMood('thinking')
      return this.animation() !== before ? 'started' : 'dropped'
    }
    if (this.activity === 'projecting') return 'dropped'
    if (this.activity === 'walking' || this.activity === 'running') { this.queuedEmote = kind; return 'queued' }
    this.beginEmote(kind)
    this.emit()
    return 'started'
  }

  setMood(mood: Mood): void {
    const prev = this.mood
    this.mood = mood
    if (mood === 'thinking' && prev !== 'thinking') {
      if (RESTFUL.includes(this.activity)) {
        this.resumeActivity = this.activity
        this.currentEmote = 'emote_thinking'
        this.activity = 'emoting'
      }
    } else if (mood !== 'thinking' && prev === 'thinking') {
      if (this.activity === 'emoting' && this.currentEmote === 'emote_thinking') {
        this.activity = this.resumeActivity
        if (this.activity === 'idle') this.scheduleWander()
      }
      if (mood === 'happy' || mood === 'confused' || mood === 'alarmed') this.emote(mood)
    } else if (mood === 'happy' || mood === 'confused' || mood === 'alarmed') {
      this.emote(mood)
    }
    this.emit()
  }

  goTo(x: number, run?: boolean): void {
    this.interact()
    this.queuedEmote = undefined
    const target = clamp01(x)
    const shouldRun = run ?? Math.abs(target - this.x) >= this.runThreshold
    this.startMove(target, shouldRun, true)
    this.emit()
  }

  openPanel(): void {
    this.interact()
    this.panelOpen = true
    this.queuedEmote = undefined
    if (this.activity !== 'walking' && this.activity !== 'running') this.activity = 'projecting'
    this.emit()
  }
  closePanel(): void {
    this.panelOpen = false
    this.lastInteractionAt = this.now
    if (this.activity === 'projecting') {
      this.activity = 'idle'
      this.applyThinkingIfRestful()
      if (this.activity === 'idle') this.scheduleWander()
    }
    this.emit()
  }
  sleep(): void {
    if (this.panelOpen) return
    if (this.activity === 'walking' || this.activity === 'running') {
      this.pendingSleep = true
      return
    }
    this.asleep = true
    this.activity = 'sleeping'
    this.targetX = undefined
    this.restUntil = undefined
    this.emit()
  }
  wake(): void {
    if (!this.asleep) return
    this.asleep = false
    this.activity = 'idle'
    this.lastInteractionAt = this.now
    this.applyThinkingIfRestful()
    if (this.activity === 'idle') this.scheduleWander()
    this.emit()
  }
  interact(): void {
    this.lastInteractionAt = this.now
    this.pendingSleep = false
    if (this.asleep) this.wake()
  }
}
