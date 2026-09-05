import { describe, it, expect } from 'vitest'
import { Buddy } from './buddy'
import { RUN_SPEED, WALK_SPEED } from '../shared/types'
import { byOrd, fromFraction, planDrop, planTravel, roster, type ScreenLike } from './displays'

function seq(values: number[]) {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}
// rng consumption order: tick#1 -> wander interval; wander -> target; arrival -> rest kind, rest length

describe('Buddy wander', () => {
  it('does nothing before the first wander time, then moves', () => {
    const b = new Buddy({ rng: seq([0, 0.9]), initialX: 0 })
    b.tick(0)
    b.tick(7999)
    expect(b.view().state.activity).toBe('idle')
    b.tick(8000)
    const v = b.view()
    expect(v.state.activity).toBe('running')
    expect(v.state.targetX).toBeCloseTo(0.9)
    expect(v.state.facing).toBe('right')
    expect(v.animation).toBe('run')
    expect(v.speed).toBe(RUN_SPEED)
  })
  it('walks when the target is near', () => {
    const b = new Buddy({ rng: seq([0, 0.1]), initialX: 0 })
    b.tick(0); b.tick(8000)
    expect(b.view().state.activity).toBe('walking')
    expect(b.view().speed).toBe(WALK_SPEED)
  })
  it('rests on arrival then wanders again', () => {
    const b = new Buddy({ rng: seq([0, 0.9, 0.5, 0, 0, 0.2]), initialX: 0 })
    b.tick(0); b.tick(8000)
    b.arrived()                       // rest kind 0.5 -> sitting, rest 0 -> 5000 ms
    expect(b.view().state.x).toBeCloseTo(0.9)
    expect(b.view().state.activity).toBe('sitting')
    expect(b.view().state.targetX).toBeUndefined()
    b.tick(12999)
    expect(b.view().state.activity).toBe('sitting')
    b.tick(13000)                     // rest over -> idle, next wander at +8000
    expect(b.view().state.activity).toBe('idle')
    b.tick(21000)
    expect(['walking', 'running']).toContain(b.view().state.activity)
  })
  it('does not wander while the panel is open, resumes after close', () => {
    const b = new Buddy({ rng: seq([0]), initialX: 0.5 })
    b.tick(0)
    b.openPanel()
    expect(b.view().state.activity).toBe('projecting')
    b.tick(60000)
    expect(b.view().state.activity).toBe('projecting')
    b.closePanel()
    expect(b.view().state.activity).toBe('idle')
    b.tick(68000)
    expect(['walking', 'running']).toContain(b.view().state.activity)
  })
  it('a wander rest can land on looking; oneShotDone ends it, then a later wander resumes', () => {
    // rng order: tick#1 wander interval, wander target, arrival rest kind, arrival rest length, tick(13000) wander target
    const b = new Buddy({ rng: seq([0, 0.9, 0.9, 0, 0.9]), initialX: 0 })
    b.tick(0); b.tick(8000)
    b.arrived()                       // rest kind 0.9 -> looking, rest 0 -> 5000 ms -> restUntil 13000
    expect(b.view().state.activity).toBe('looking')
    b.oneShotDone()
    expect(b.view().state.activity).toBe('idle')
    b.tick(12999)
    expect(b.view().state.activity).toBe('idle')
    b.tick(13000)
    expect(['walking', 'running']).toContain(b.view().state.activity)
  })
})

describe('Buddy commands', () => {
  it('goTo clamps, faces, runs when asked, and idles on arrival', () => {
    const b = new Buddy({ rng: seq([0]), initialX: 0.5 })
    b.tick(0)
    b.goTo(1.7, true)
    expect(b.view().state.targetX).toBe(1)
    expect(b.view().state.activity).toBe('running')
    expect(b.view().state.facing).toBe('right')
    b.arrived()
    expect(b.view().state.activity).toBe('idle')
    expect(b.view().state.x).toBe(1)
  })
  it('goTo without run picks walk or run by distance', () => {
    const b = new Buddy({ rng: seq([0]), initialX: 0.5 })
    b.tick(0)
    b.goTo(0.4)
    expect(b.view().state.activity).toBe('walking')
    expect(b.view().state.facing).toBe('left')
    b.arrived()
    b.goTo(0.0)
    expect(b.view().state.activity).toBe('running')
  })
  it('fires arrive listeners', () => {
    const b = new Buddy({ rng: seq([0]) })
    let n = 0
    b.onArrive(() => n++)
    b.tick(0); b.goTo(0.1); b.arrived()
    expect(n).toBe(1)
  })
})

describe('Buddy emotes and moods', () => {
  it('plays a one-shot emote from idle and returns to idle', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0)
    expect(b.emote('confused')).toBe('started')
    expect(b.view().state.activity).toBe('emoting')
    expect(b.view().animation).toBe('emote_confused')
    b.oneShotDone()
    expect(b.view().state.activity).toBe('idle')
  })
  it('returns to sitting after an emote started while sitting', () => {
    const b = new Buddy({ rng: seq([0, 0.9, 0.5, 0]), initialX: 0 })
    b.tick(0); b.tick(8000); b.arrived()
    expect(b.view().state.activity).toBe('sitting')
    b.emote('happy')
    b.oneShotDone()
    expect(b.view().state.activity).toBe('sitting')
  })
  it('queues an emote behind movement', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.goTo(0.6)
    expect(b.emote('alarmed')).toBe('queued')
    expect(b.view().state.activity).toBe('walking')
    b.arrived()
    expect(b.view().animation).toBe('emote_alarmed')
  })
  it('an emote while projecting plays, returns to projecting on oneShotDone, and mood still applies', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.openPanel()
    expect(b.emote('happy')).toBe('started')
    expect(b.view().animation).toBe('emote_happy')
    b.oneShotDone()
    expect(b.view().state.activity).toBe('projecting')
    expect(b.view().animation).toBe('project')
    b.setMood('happy')
    expect(b.view().state.mood).toBe('happy')
  })
  it('thinking replaces the project pose while projecting', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.openPanel()
    b.setMood('thinking')
    expect(b.view().animation).toBe('emote_thinking')
    b.setMood('calm')
    expect(b.view().animation).toBe('project')
  })
  it('thinking loops from idle until the mood changes', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0)
    b.setMood('thinking')
    expect(b.view().animation).toBe('emote_thinking')
    expect(b.view().state.activity).toBe('emoting')
    b.setMood('calm')
    expect(b.view().state.activity).toBe('idle')
  })
  it('hop plays hop then fall', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.emote('hop')
    expect(b.view().animation).toBe('hop')
    b.oneShotDone()
    expect(b.view().animation).toBe('fall')
    b.oneShotDone()
    expect(b.view().state.activity).toBe('idle')
  })
  it('emote(look) plays the look pose from idle and returns to idle', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0)
    b.emote('look')
    expect(b.view().state.activity).toBe('looking')
    expect(b.view().animation).toBe('look')
    b.oneShotDone()
    expect(b.view().state.activity).toBe('idle')
  })
  it('thinking set while walking becomes visible once he settles on arrival', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0)
    b.goTo(0.6)
    expect(b.view().state.activity).toBe('walking')
    b.setMood('thinking')
    expect(b.view().state.activity).toBe('walking')   // still finishing the move
    b.arrived()
    expect(b.view().animation).toBe('emote_thinking')
  })
  it('emote(thinking) while running becomes visible on arrival and clears on calm', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0)
    b.goTo(0.9, true)
    expect(b.view().state.activity).toBe('running')
    b.emote('thinking')
    b.arrived()
    expect(b.view().animation).toBe('emote_thinking')
    b.setMood('calm')
    expect(b.view().state.activity).toBe('idle')
  })
  it('emote(thinking) while asleep is a no-op', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0)
    b.sleep()
    expect(b.view().state.asleep).toBe(true)
    b.emote('thinking')
    expect(b.view().state.mood).toBe('calm')
  })
})

describe('Buddy sleep', () => {
  it('sleeps after the quiet period and wakes on interaction', () => {
    const b = new Buddy({ rng: seq([0]), wanderIntervalMs: [1e9, 1e9] })   // never wanders in this test
    b.tick(0)
    b.tick(599999)
    expect(b.view().state.asleep).toBe(false)
    b.tick(600000)
    expect(b.view().state.asleep).toBe(true)
    expect(b.view().animation).toBe('sleep')
    b.tick(700000)
    expect(b.view().state.activity).toBe('sleeping')
    b.interact()
    expect(b.view().state.asleep).toBe(false)
    expect(b.view().state.activity).toBe('idle')
  })
  it('sleep() while the panel is open closes the panel and sleeps, wake() restores idle', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.openPanel(); b.sleep()
    expect(b.view().state.panelOpen).toBe(false)
    expect(b.view().state.asleep).toBe(true)
    b.wake()
    expect(b.view().state.activity).toBe('idle')
  })
  it('emits change events only when the view changes', () => {
    const b = new Buddy({ rng: seq([0]) })
    let n = 0
    b.onChange(() => n++)
    b.tick(0); b.tick(100); b.tick(200)
    expect(n).toBe(0)
    b.goTo(0.9)
    expect(n).toBe(1)
  })
  it('sleep() during a move finishes the move, fires onArrive, then sleeps', () => {
    const b = new Buddy({ rng: seq([0]) })
    let arrives = 0
    b.onArrive(() => arrives++)
    b.tick(0)
    b.goTo(0.9)
    expect(b.view().state.activity).toBe('running')
    b.sleep()
    expect(b.view().state.activity).toBe('running')
    expect(b.view().state.asleep).toBe(false)
    b.arrived()
    expect(arrives).toBe(1)
    expect(b.view().state.asleep).toBe(true)
    expect(b.view().animation).toBe('sleep')
    b.interact()
    expect(b.view().state.asleep).toBe(false)
  })
  it('opening the panel before arrival cancels a pending sleep', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0)
    b.goTo(0.9)
    b.sleep()
    b.openPanel()
    b.arrived()
    expect(b.view().state.activity).toBe('projecting')
    expect(b.view().state.asleep).toBe(false)
  })
  it('a new command before arrival cancels a pending sleep, and a later sleep() still works', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0)
    b.goTo(0.9)
    b.sleep()
    b.goTo(0.2)
    b.arrived()
    expect(b.view().state.activity).toBe('idle')
    expect(b.view().state.asleep).toBe(false)
    b.sleep()
    expect(b.view().state.asleep).toBe(true)
  })
  it('an emote plays while projecting and returns to the project pose', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.openPanel()
    expect(b.emote('happy')).toBe('started')
    expect(b.view().animation).toBe('emote_happy')
    b.oneShotDone()
    expect(b.view().state.activity).toBe('projecting')
    expect(b.view().animation).toBe('project')
  })
  it('sleep while the panel is open closes the panel and sleeps', () => {
    const b = new Buddy({ rng: seq([0]) })
    b.tick(0); b.openPanel()
    b.sleep()
    expect(b.getState().panelOpen).toBe(false)
    expect(b.getState().asleep).toBe(true)
    expect(b.view().animation).toBe('sleep')
  })
})

describe('Buddy travel', () => {
  // Routes come from the real planner over the real three-screen fixture, so these exercise
  // the state machine and the route geometry together rather than hand-written legs.
  const D3: ScreenLike = { id: 3, primary: false, workArea: { x: -575, y: -1440, width: 5120, height: 1392 } }
  const D2: ScreenLike = { id: 2, primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1032 } }
  const D1: ScreenLike = { id: 1, primary: false, workArea: { x: 1920, y: 0, width: 1920, height: 1032 } }
  const RIG = roster([D1, D2, D3]) // ord 1 = ultrawide (above), 2 = primary, 3 = right-hand panel
  const CHAR_W = 200

  const plan = (fromOrd: number, toOrd: number, landFraction: number, startFraction = 0.5) => planTravel({
    from: byOrd(RIG, fromOrd)!, to: byOrd(RIG, toOrd)!,
    startVX: fromFraction(startFraction, byOrd(RIG, fromOrd)!.wa, CHAR_W),
    landFraction, charW: CHAR_W, runThreshold: 0.25,
  })
  // Standing on the primary, mid-screen, awake and idle.
  const onPrimary = () => { const b = new Buddy({ rng: seq([0]), initialX: 0.5, initialDisplay: 2 }); b.tick(0); return b }

  it('plays a three-leg route as walk, hover, walk, then idles', () => {
    const b = onPrimary()
    const legs = plan(2, 1, 0.5)
    expect(legs).toHaveLength(3)
    b.travel(legs)
    expect(b.view().state.activity).toBe('running')   // the launch leg crosses half the primary
    b.arrived()
    expect(b.view().state.activity).toBe('hovering')
    expect(b.view().animation).toBe('hover')
    b.arrived()
    expect(b.view().state.activity).toBe('walking')
    b.arrived()
    expect(b.view().state.activity).toBe('idle')
    expect(b.view().state.leg).toBeUndefined()
  })

  it('changes display exactly once, when the flight leg lands', () => {
    const b = onPrimary()
    const seen: number[] = []
    b.onChange(v => seen.push(v.state.display))
    b.travel(plan(2, 1, 0.5))
    expect(b.getState().display).toBe(2)
    b.arrived()                                        // launch walk done, now airborne
    expect(b.getState().display).toBe(2)               // still on the source until he lands
    b.arrived()                                        // flight done
    expect(b.getState().display).toBe(1)
    b.arrived()
    expect(b.getState().display).toBe(1)
    expect(new Set(seen)).toEqual(new Set([2, 1]))
  })

  it('fires arrival listeners once for the whole journey, not once per leg', () => {
    const b = onPrimary()
    let arrivals = 0
    b.onArrive(() => { arrivals++ })
    b.travel(plan(2, 1, 0.5))
    b.arrived(); expect(arrivals).toBe(0)
    b.arrived(); expect(arrivals).toBe(0)
    b.arrived(); expect(arrivals).toBe(1)
  })

  it('opens a seam crossing with the hop one-shot, then settles into the hover loop', () => {
    const b = onPrimary()
    const legs = plan(2, 3, 0.5)                       // beside: primary to the right-hand panel
    expect(legs.some(l => l.kind === 'fly' && l.hop)).toBe(true)
    b.travel(legs)
    b.arrived()                                        // run to the seam is done
    expect(b.view().state.activity).toBe('hovering')
    expect(b.view().animation).toBe('hop')
    b.oneShotDone()
    expect(b.view().state.activity).toBe('hovering')   // still airborne
    expect(b.view().animation).toBe('hover')
  })

  it('lands on the requested fraction of the target display', () => {
    const b = onPrimary()
    b.travel(plan(2, 3, 0.25))
    b.arrived(); b.arrived(); b.arrived()
    expect(b.getState().display).toBe(3)
    expect(b.getState().x).toBeCloseTo(0.25, 6)
  })

  it('does not force the projecting pose while airborne, and takes it on landing', () => {
    const b = onPrimary()
    b.travel(plan(2, 1, 0.5))
    b.arrived()
    expect(b.getState().activity).toBe('hovering')
    b.openPanel()
    expect(b.getState().activity).toBe('hovering')     // keeps flying rather than posing mid-air
    expect(b.getState().panelOpen).toBe(true)
    b.arrived(); b.arrived()
    expect(b.getState().activity).toBe('projecting')
  })

  it('defers sleep until he has landed', () => {
    const b = onPrimary()
    b.travel(plan(2, 1, 0.5))
    b.arrived()
    b.sleep()
    expect(b.getState().asleep).toBe(false)
    expect(b.getState().activity).toBe('hovering')
    b.arrived(); b.arrived()
    expect(b.getState().asleep).toBe(true)
    expect(b.getState().display).toBe(1)               // still travelled all the way there
  })

  it('queues an emote raised mid-flight instead of interrupting it', () => {
    const b = onPrimary()
    b.travel(plan(2, 1, 0.5))
    b.arrived()
    expect(b.emote('alarmed')).toBe('queued')
    expect(b.getState().activity).toBe('hovering')
    b.arrived(); b.arrived()
    expect(b.view().animation).toBe('emote_alarmed')
  })

  it('a second journey supersedes the first and drops its remaining legs', () => {
    const b = onPrimary()
    b.travel(plan(2, 1, 0.5))
    b.arrived()
    expect(b.getState().activity).toBe('hovering')
    b.travel(plan(2, 3, 0.5))                          // change of mind, now head sideways
    expect(b.getState().activity).toBe('running')      // back on the ground, running to the seam
    b.arrived(); b.arrived(); b.arrived()
    expect(b.getState().display).toBe(3)
  })

  it('a same-display goTo mid-flight drops the journey', () => {
    const b = onPrimary()
    b.travel(plan(2, 1, 0.5))
    b.arrived()
    b.goTo(0.1)
    expect(b.getState().leg).toBeUndefined()
    expect(b.getState().targetX).toBeCloseTo(0.1)
    b.arrived()
    expect(b.getState().display).toBe(2)               // never left the primary
    expect(b.getState().activity).toBe('idle')
  })

  it('an empty route settles immediately without moving', () => {
    const b = onPrimary()
    b.travel([])
    expect(b.getState().activity).toBe('idle')
    expect(b.getState().display).toBe(2)
    expect(b.getState().x).toBeCloseTo(0.5)
  })

  it('picking him up hovers him and drops any journey in progress', () => {
    const b = onPrimary()
    b.travel(plan(2, 1, 0.5))
    b.beginDrag()
    expect(b.getState().dragging).toBe(true)
    expect(b.getState().activity).toBe('hovering')
    expect(b.getState().leg).toBeUndefined()      // no route: the pointer is steering
    expect(b.getState().targetX).toBeUndefined()
    expect(b.view().animation).toBe('hover')
  })

  it('does not wander or doze off while held', () => {
    const b = new Buddy({ rng: seq([0, 0.9]), initialX: 0.5, initialDisplay: 2, sleepAfterMs: 1000 })
    b.tick(0)
    b.beginDrag()
    b.tick(60000)
    expect(b.getState().activity).toBe('hovering')
    expect(b.getState().asleep).toBe(false)
    expect(b.getState().dragging).toBe(true)
  })

  it('releasing him flies him down onto the display he was dropped over', () => {
    const b = onPrimary()
    b.beginDrag()
    const landing = planDrop(RIG, { x: 2800, y: 300 }, CHAR_W)   // over the right-hand panel
    b.endDrag(landing)
    expect(b.getState().dragging).toBe(false)
    expect(b.getState().activity).toBe('hovering')               // still hovering, now falling
    expect(b.getState().leg).toMatchObject({ kind: 'fly', hop: false })
    b.arrived()
    expect(b.getState().display).toBe(3)
    expect(b.getState().activity).toBe('idle')
  })

  it('a release without a pickup does nothing', () => {
    const b = onPrimary()
    const before = b.getState()
    b.endDrag(planDrop(RIG, { x: 2800, y: 300 }, CHAR_W))
    expect(b.getState().activity).toBe(before.activity)
    expect(b.getState().display).toBe(before.display)
  })

  it('takes the projecting pose after being dropped if the panel is open', () => {
    const b = onPrimary()
    b.openPanel()
    b.beginDrag()
    expect(b.getState().activity).toBe('hovering')               // not posing while carried
    b.endDrag(planDrop(RIG, { x: 1000, y: -900 }, CHAR_W))       // dropped over the ultrawide
    b.arrived()
    expect(b.getState().display).toBe(1)
    expect(b.getState().activity).toBe('projecting')
  })

  it('wandering never leaves the current display', () => {
    const b = new Buddy({ rng: seq([0, 0.9]), initialX: 0, initialDisplay: 3 })
    b.tick(0); b.tick(8000)
    expect(b.getState().activity).toBe('running')
    expect(b.getState().display).toBe(3)
    expect(b.getState().leg).toBeUndefined()
    b.arrived()
    expect(b.getState().display).toBe(3)
  })
})
