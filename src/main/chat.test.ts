import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { ChatController, type ChatOut } from './chat'
import { loadPack } from './pack'
import { HELP_TEXT } from './commands'
import type { Brain, BrainEvent } from './brain/types'
import type { BuddyActions } from './actions'

const pack = (() => { const r = loadPack(join(__dirname, '../../test/fixtures/pack-min')); if (!r.ok) throw new Error(r.errors.join()); return r.pack })()

function fakeOut() {
  const o = { deltas: [] as string[], systems: [] as string[], faces: [] as string[], dones: 0, doneArgs: [] as unknown[], statuses: [] as unknown[],
    delta(t: string) { o.deltas.push(t) }, activity() {}, done(d: unknown) { o.dones++; o.doneArgs.push(d) }, system(t: string, e?: string) { o.systems.push(t); o.faces.push(e ?? 'neutral') }, status(s: unknown) { o.statuses.push(s) } }
  return o as typeof o & ChatOut
}
function fakeActions() {
  const a = { calls: [] as string[],
    goTo: async (x: number, o?: { run?: boolean }) => { a.calls.push(`goTo ${x} ${o?.run ?? false}`) },
    setMood: (m: string) => { a.calls.push(`mood ${m}`) },
    emote: async (k: string) => { a.calls.push(`emote ${k}`) },
    say() {}, openPanel() {}, closePanel() {}, sleep: () => a.calls.push('sleep'), wake: () => a.calls.push('wake'),
    getState: () => ({ x: 0.5, facing: 'right', activity: 'idle', mood: 'calm', panelOpen: true, asleep: false }) }
  return a as typeof a & BuddyActions
}
function scriptedBrain(events: BrainEvent[]): Brain & { stopped: number } {
  return { stopped: 0, async *respond() { for (const e of events) yield e }, stop() { this.stopped++ } }
}
const settings = () => ({ workspace: 'C:\\repo', model: null, sessionId: null })

describe('ChatController', () => {
  it('routes plain text to the brain and forwards events', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'text', delta: 'b' }, { type: 'done', sessionId: 's1' }]),
      actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('hello')
    await new Promise(r => setTimeout(r, 10))
    expect(out.deltas).toEqual(['a', 'b'])
    expect(out.dones).toBe(1)
    expect(c.status().session).toBe('s1')
  })
  it('runs slash commands through actions', async () => {
    const out = fakeOut(); const a = fakeActions()
    const c = new ChatController({ brain: scriptedBrain([]), actions: a, pack, out, settings: settings() })
    c.prompt('/goto 40'); c.prompt('/run right'); c.prompt('/mood confused'); c.prompt('/emote hop'); c.prompt('/sleep'); c.prompt('/wake')
    await new Promise(r => setTimeout(r, 10))
    expect(a.calls).toEqual(['goTo 0.4 false', 'goTo 1 true', 'mood confused', 'emote hop', 'sleep', 'wake'])
  })
  it('shows help and command errors as system lines', () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('/help'); c.prompt('/bogus')
    expect(out.systems[0]).toBe(HELP_TEXT)
    expect(out.systems[1]).toContain('unknown command')
  })
  it('updates settings for /cd, /model, /new and reports status', () => {
    const out = fakeOut(); const changes: unknown[] = []
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: { ...settings(), sessionId: 'old' }, onSettingsChange: s => changes.push({ ...s }) })
    c.prompt('/cd D:\\w'); c.prompt('/model sonnet'); c.prompt('/new')
    expect(c.status()).toEqual({ model: 'sonnet', workspace: 'D:\\w', session: 'new' })
    expect(changes.length).toBe(3)
    expect(out.statuses.length).toBe(3)
  })
  it('refuses a second prompt while busy and /stop stops the brain', async () => {
    const out = fakeOut()
    let release!: () => void
    const brain: Brain & { stopped: number } = { stopped: 0,
      async *respond() { yield { type: 'text', delta: 'x' }; await new Promise<void>(r => { release = r }); yield { type: 'done' } },
      stop() { this.stopped++ } }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('one')
    await new Promise(r => setTimeout(r, 5))
    expect(c.busy).toBe(true)
    c.prompt('two')
    expect(out.systems.at(-1)).toContain('/stop')
    c.prompt('/stop')
    expect(brain.stopped).toBe(1)
    release()
    await new Promise(r => setTimeout(r, 5))
    expect(c.busy).toBe(false)
  })
  it('/stop uses the pack stopped line when the pack has one', async () => {
    const out = fakeOut()
    const withLine = { ...pack, persona: { ...pack.persona, lines: { ...pack.persona.lines, stopped: ['Rite aborted.'] } } }
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack: withLine, out, settings: settings() })
    await c.prompt('/stop'); expect(out.systems.at(-1)).toBe('Rite aborted.')
  })
  it('carries the expression yielded by the brain in the done payload', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'expression', name: 'happy' }, { type: 'done' }]),
      actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('hello')
    await new Promise(r => setTimeout(r, 10))
    expect(out.doneArgs.at(-1)).toEqual({ error: undefined, expression: 'happy' })
  })
  it('defaults the done payload expression to neutral when the brain yields none', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'done' }]),
      actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('hello')
    await new Promise(r => setTimeout(r, 10))
    expect(out.doneArgs.at(-1)).toEqual({ error: undefined, expression: 'neutral' })
  })
  it('reports a brain error with the pack error line', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'done', error: 'boom' }]), actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('hello')
    await new Promise(r => setTimeout(r, 10))
    expect(out.systems.at(-1)).toContain('boom')
    expect(out.faces.at(-1)).toBe('sadness')
  })
  it('does not let a turn finishing after /new overwrite the fresh session, but a normal turn still stores its id', async () => {
    const out = fakeOut()
    let release!: () => void
    const brain: Brain = {
      async *respond() { yield { type: 'text', delta: 'x' }; await new Promise<void>(r => { release = r }); yield { type: 'done', sessionId: 'old' } },
      stop() {},
    }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('one')
    await new Promise(r => setTimeout(r, 5))
    c.prompt('/new')
    expect(c.status().session).toBe('new')
    expect(out.statuses.some(s => (s as { session: string }).session === 'new')).toBe(true)
    release()
    await new Promise(r => setTimeout(r, 5))
    expect(c.status().session).toBe('new')
    expect(out.statuses.some(s => (s as { session: string }).session === 'old')).toBe(false)

    const c2 = new ChatController({ brain: scriptedBrain([{ type: 'done', sessionId: 's2' }]), actions: fakeActions(), pack, out: fakeOut(), settings: settings() })
    c2.prompt('two')
    await new Promise(r => setTimeout(r, 10))
    expect(c2.status().session).toBe('s2')
  })
  it('every slash command confirms with one system line', async () => {
    const out = fakeOut()
    const ctrl = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings() })
    await ctrl.prompt('/goto 20'); expect(out.systems.at(-1)).toBe('moving to 20%')
    await ctrl.prompt('/run 80'); expect(out.systems.at(-1)).toBe('running to 80%')
    await ctrl.prompt('/mood happy'); expect(out.systems.at(-1)).toBe('mood: happy')
    await ctrl.prompt('/emote alarmed'); expect(out.systems.at(-1)).toBe('emote: alarmed')
    await ctrl.prompt('/sleep'); expect(out.systems.at(-1)).toBe('sleeping')
    await ctrl.prompt('/wake'); expect(out.systems.at(-1)).toBe('awake')
    await ctrl.prompt('/new'); expect(out.systems.at(-1)).toBe('new session')
    await ctrl.prompt('/cd C:\\x'); expect(out.systems.at(-1)).toBe('workspace: C:\\x')
    await ctrl.prompt('/model sonnet'); expect(out.systems.at(-1)).toBe('model: sonnet')
    await ctrl.prompt('/stop'); expect(out.systems.at(-1)).toBe('stopped')
  })
})
