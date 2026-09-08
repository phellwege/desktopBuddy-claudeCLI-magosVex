import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { ChatController, type ChatOut } from './chat'
import { loadPack } from './pack'
import { HELP_TEXT } from './commands'
import type { Brain, BrainEvent } from './brain/types'
import type { BuddyActions } from './actions'

const pack = (() => { const r = loadPack(join(__dirname, '../../test/fixtures/pack-min')); if (!r.ok) throw new Error(r.errors.join()); return r.pack })()

function fakeOut() {
  const o = { deltas: [] as string[], systems: [] as string[], faces: [] as string[], dones: 0, doneArgs: [] as unknown[], statuses: [] as unknown[], readbacks: [] as unknown[], clears: 0,
    delta(t: string) { o.deltas.push(t) }, activity() {}, done(d: unknown) { o.dones++; o.doneArgs.push(d) }, system(t: string, e?: string) { o.systems.push(t); o.faces.push(e ?? 'neutral') }, status(s: unknown) { o.statuses.push(s) }, readback(p: unknown) { o.readbacks.push(p) }, clear() { o.clears++ } }
  return o as typeof o & ChatOut
}
function fakeReadback(result: { ok: true; text: string } | { ok: false; reason: string }) {
  const r = { calls: [] as string[], async run(text: string) { r.calls.push(text); return result } }
  return r
}
function fakeActions() {
  const a = { calls: [] as string[],
    goTo: async (x: number, o?: { run?: boolean }) => { a.calls.push(`goTo ${x} ${o?.run ?? false}`) },
    travel: async () => { a.calls.push('travel') },
    goToDisplay: async (d: number | undefined, x: number, o?: { run?: boolean }) => {
      a.calls.push(d === undefined ? `goTo ${x} ${o?.run ?? false}` : `goTo ${d}:${x} ${o?.run ?? false}`)
    },
    // Two displays attached, so the roster and the unknown-ordinal path are both reachable.
    displays: () => [
      { ord: 1, width: 1920, height: 1032, primary: true, current: true },
      { ord: 2, width: 2560, height: 1392, primary: false, current: false },
    ],
    checkDisplay: (d: number) => (d === 1 || d === 2) ? null : `no display ${d} (1-2 attached)`,
    setMood: (m: string) => { a.calls.push(`mood ${m}`) },
    emote: async (k: string) => { a.calls.push(`emote ${k}`) },
    say() {}, openPanel() {}, closePanel() {}, sleep: () => a.calls.push('sleep'), wake: () => a.calls.push('wake'),
    getState: () => ({ x: 0.5, display: 1, facing: 'right', activity: 'idle', mood: 'calm', panelOpen: true, asleep: false }) }
  return a as typeof a & BuddyActions
}
function scriptedBrain(events: BrainEvent[]): Brain & { stopped: number } {
  return { stopped: 0, async *respond() { for (const e of events) yield e }, stop() { this.stopped++ } }
}
const settings = () => ({ workspace: 'C:\\repo', model: null, sessionId: null })
// /cd and /ls never touch the disk in tests.
const permissiveFs = { isDirectory: () => true, list: () => [] as { name: string; dir: boolean }[] }

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
    c.prompt('/goto 40'); c.prompt('/run right'); c.prompt('/goto 2:50')
    c.prompt('/mood confused'); c.prompt('/emote hop'); c.prompt('/sleep'); c.prompt('/wake')
    await new Promise(r => setTimeout(r, 10))
    expect(a.calls).toEqual(['goTo 0.4 false', 'goTo 1 true', 'goTo 2:0.5 false', 'mood confused', 'emote hop', 'sleep', 'wake'])
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
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, fs: permissiveFs, settings: { ...settings(), sessionId: 'old' }, onSettingsChange: s => changes.push({ ...s }) })
    c.prompt('/cd D:\\w'); c.prompt('/model sonnet'); c.prompt('/new')
    expect(c.status()).toEqual({ model: 'sonnet', workspace: 'D:\\w', session: 'new', readback: false })
    expect(changes.length).toBe(3)
    expect(out.statuses.length).toBe(3)
  })
  it('/clear does everything /new does, then clears the panel and confirms with "cleared"', async () => {
    const out = fakeOut(); const changes: unknown[] = []
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out,
      settings: { ...settings(), sessionId: 'old' }, onSettingsChange: s => changes.push({ ...s }) })
    await c.prompt('/clear')
    expect(out.clears).toBe(1)
    expect(out.systems.at(-1)).toBe('cleared')
    expect(c.status().session).toBe('new')
    expect(changes.at(-1)).toMatchObject({ sessionId: null })
  })
  it('refuses a second prompt while busy when the brain cannot steer, and /stop stops the brain', async () => {
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
  it('steers a second prompt into the running turn when the brain can take it, and posts nothing', async () => {
    const out = fakeOut()
    let release!: () => void
    const steers: string[] = []
    const brain: Brain = {
      async *respond() { yield { type: 'text', delta: 'x' }; await new Promise<void>(r => { release = r }); yield { type: 'done' } },
      stop() {},
      steer(content) { if (typeof content === 'string') steers.push(content); return true },
    }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('one')
    await new Promise(r => setTimeout(r, 5))
    expect(c.busy).toBe(true)
    c.prompt('  how is it going?  ')
    expect(steers).toEqual(['how is it going?'])
    expect(out.systems).toEqual([])
    release()
    await new Promise(r => setTimeout(r, 5))
    expect(c.busy).toBe(false)
    expect(out.dones).toBe(1)
  })
  it('falls back to the refusal line when the brain declines the steer', async () => {
    const out = fakeOut()
    let release!: () => void
    const brain: Brain = {
      async *respond() { yield { type: 'text', delta: 'x' }; await new Promise<void>(r => { release = r }); yield { type: 'done' } },
      stop() {},
      steer() { return false },
    }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('one')
    await new Promise(r => setTimeout(r, 5))
    c.prompt('two')
    expect(out.systems.at(-1)).toContain('/stop')
    release()
    await new Promise(r => setTimeout(r, 5))
  })
  it('readback gets the whole reply, including text that arrives after a drained follow-on turn', async () => {
    const out = fakeOut()
    const rb = fakeReadback({ ok: true, text: 'spoken' })
    const c = new ChatController({
      brain: scriptedBrain([{ type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' }, { type: 'text', delta: ' and the answer' }, { type: 'done', sessionId: 's2' }]),
      actions: fakeActions(), pack, out, settings: settings(), readback: rb,
    })
    c.prompt('hi')
    await new Promise(r => setTimeout(r, 10))
    expect(rb.calls).toEqual(['Hello and the answer'])
    expect(c.status().session).toBe('s2')
  })
  it('/stop uses the pack stopped line when the pack has one', async () => {
    const out = fakeOut()
    const withLine = { ...pack, persona: { ...pack.persona, lines: { ...pack.persona.lines, stopped: ['Rite aborted.'] } } }
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack: withLine, out, settings: settings() })
    await c.prompt('/stop'); expect(out.systems.at(-1)).toBe('Rite aborted.')
  })
  it('a user /stop mid-turn posts only the stopped line, not the pack error line, when the killed brain reports done(stopped: true)', async () => {
    const out = fakeOut()
    let release!: () => void
    const brain: Brain = {
      async *respond() {
        yield { type: 'text', delta: 'x' }
        await new Promise<void>(r => { release = r })
        yield { type: 'done', error: 'stopped (exit code null)', stopped: true }
      },
      stop() { release() },
    }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('one')
    await new Promise(r => setTimeout(r, 5))
    c.prompt('/stop')
    await new Promise(r => setTimeout(r, 5))
    expect(out.systems).toEqual(['stopped'])
    expect(out.dones).toBe(1)
    expect(out.doneArgs.at(-1)).toMatchObject({ error: 'stopped (exit code null)' })
  })
  it('a brain-reported done error without stopped still posts the pack error line (e.g. a real crash)', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'done', error: 'exit code 1' }]), actions: fakeActions(), pack, out, settings: settings() })
    await c.prompt('hello')
    await new Promise(r => setTimeout(r, 10))
    expect(out.systems.at(-1)).toContain('exit code 1')
    expect(out.faces.at(-1)).toBe('sadness')
  })
  it('carries the expression yielded by the brain in the done payload', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'expression', name: 'happy' }, { type: 'done' }]),
      actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('hello')
    await new Promise(r => setTimeout(r, 10))
    expect(out.doneArgs.at(-1)).toEqual({ id: 1, error: undefined, expression: 'happy', readback: false })
  })
  it('defaults the done payload expression to neutral when the brain yields none', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'done' }]),
      actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('hello')
    await new Promise(r => setTimeout(r, 10))
    expect(out.doneArgs.at(-1)).toEqual({ id: 1, error: undefined, expression: 'neutral', readback: false })
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
  it('retries once with a fresh session when the CLI rejects a resumed session, posting the expired line once', async () => {
    const out = fakeOut()
    const contexts: { sessionId: string | null }[] = []
    let calls = 0
    const brain: Brain = {
      async *respond(_text, ctx) {
        calls++
        contexts.push({ sessionId: ctx.sessionId })
        if (calls === 1) { yield { type: 'done', error: 'No conversation found with session ID x' }; return }
        yield { type: 'text', delta: 'Hello' }
        yield { type: 'done', sessionId: 's-new' }
      },
      stop() {},
    }
    const c = new ChatController({ brain, actions: fakeActions(), pack, out, settings: { ...settings(), sessionId: 'stale-session' } })
    await c.prompt('hi')
    await new Promise(r => setTimeout(r, 20))
    expect(calls).toBe(2)
    expect(contexts).toEqual([{ sessionId: 'stale-session' }, { sessionId: null }])
    expect(out.systems.filter(s => s === 'session expired, starting fresh')).toHaveLength(1)
    expect(out.deltas).toEqual(['Hello'])
    expect(out.dones).toBe(1)
    expect(c.status().session).toBe('s-new')
  })
  it('awaitPermissionAnswer resolves on a matching permissionAnswer with the allow decision', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings() })
    const pending = c.awaitPermissionAnswer('p1')
    c.permissionAnswer('p1', true)
    expect(await pending).toEqual({ allow: true, reason: 'user allowed' })
    expect(out.faces).not.toContain('anger')
  })
  it('answering allow with remember resolves with remember: true, no denial line', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings() })
    const pending = c.awaitPermissionAnswer('p1r')
    c.permissionAnswer('p1r', true, true)
    expect(await pending).toEqual({ allow: true, reason: 'user allowed', remember: true })
    expect(out.systems).toEqual([])
  })
  it('a denied permission posts the permissionDenied line with anger and resolves allow: false', async () => {
    const out = fakeOut()
    const withLine = { ...pack, persona: { ...pack.persona, lines: { ...pack.persona.lines, permissionDenied: ['Denied, heretic.'] } } }
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack: withLine, out, settings: settings() })
    const pending = c.awaitPermissionAnswer('p2')
    c.permissionAnswer('p2', false)
    expect(await pending).toEqual({ allow: false, reason: 'user denied' })
    expect(out.systems.at(-1)).toBe('Denied, heretic.')
    expect(out.faces.at(-1)).toBe('anger')
  })
  it('permissionAnswer for an unknown or already-answered id is a no-op', () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings() })
    expect(() => c.permissionAnswer('nope', true)).not.toThrow()
    expect(out.systems).toEqual([])
  })
  it('expirePermission settles the pending request as denied, posts nothing, and a later permissionAnswer for it is a no-op', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings() })
    const pending = c.awaitPermissionAnswer('p3')
    c.expirePermission('p3')
    await expect(pending).resolves.toEqual({ allow: false, reason: 'timed out' })
    c.permissionAnswer('p3', true)
    await new Promise(r => setTimeout(r, 10))
    expect(out.systems).toEqual([])
  })
  it('expirePermission on an unknown id is a no-op', () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings() })
    expect(() => c.expirePermission('nope')).not.toThrow()
    expect(out.systems).toEqual([])
  })
  it('setExpression stamps the expression carried on the next done payload', async () => {
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'done' }]),
      actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('hello')
    c.setExpression('love')
    await new Promise(r => setTimeout(r, 10))
    expect(out.doneArgs.at(-1)).toEqual({ id: 1, error: undefined, expression: 'love', readback: false })
  })
  it('every slash command confirms with one system line', async () => {
    const out = fakeOut()
    const ctrl = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, fs: permissiveFs, settings: settings() })
    await ctrl.prompt('/goto 20'); expect(out.systems.at(-1)).toBe('moving to 20%')
    await ctrl.prompt('/run 80'); expect(out.systems.at(-1)).toBe('running to 80%')
    await ctrl.prompt('/goto 2:50'); expect(out.systems.at(-1)).toBe('moving to 50% on display 2')
    await ctrl.prompt('/goto 9:50'); expect(out.systems.at(-1)).toBe('no display 9 (1-2 attached)')
    await ctrl.prompt('/displays'); expect(out.systems.at(-1)).toBe('1: 1920x1032 primary (here)\n2: 2560x1392')
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

describe('ChatController /cd', () => {
  it('starts a new session when the workspace changes, so session allows are dropped', async () => {
    const out = fakeOut(); const changes: { workspace: string; sessionId: string | null }[] = []
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, fs: permissiveFs,
      settings: { ...settings(), sessionId: 'old' }, onSettingsChange: s => changes.push({ workspace: s.workspace, sessionId: s.sessionId }) })
    await c.prompt('/cd D:\\other')
    expect(changes.at(-1)).toEqual({ workspace: 'D:\\other', sessionId: null })
    expect(out.systems.at(-1)).toBe('workspace: D:\\other')
  })
  it('/cd alone shows the workspace, a relative path resolves against it, and a missing directory is refused', async () => {
    const out = fakeOut()
    const fs = { isDirectory: (p: string) => p === 'C:\\repo\\sub', list: () => [] }
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings(), fs })
    await c.prompt('/cd')
    expect(out.systems.at(-1)).toBe('workspace: C:\\repo')
    await c.prompt('/cd sub')
    expect(out.systems.at(-1)).toBe('workspace: C:\\repo\\sub')
    await c.prompt('/cd nope')
    expect(out.systems.at(-1)).toBe('no such directory: C:\\repo\\sub\\nope')
    expect(c.status().workspace).toBe('C:\\repo\\sub')
  })
  it('/ls lists directories first with a trailing slash', async () => {
    const out = fakeOut()
    const fs = { isDirectory: () => true, list: () => [{ name: 'b.txt', dir: false }, { name: 'src', dir: true }, { name: 'a.txt', dir: false }] }
    const c = new ChatController({ brain: scriptedBrain([]), actions: fakeActions(), pack, out, settings: settings(), fs })
    await c.prompt('/ls')
    expect(out.systems.at(-1)).toBe('C:\\repo\nsrc/\na.txt\nb.txt')
  })
})

describe('ChatController readback', () => {
  it('numbers replies and fires one readback with the joined reply text after a clean done', async () => {
    const out = fakeOut(); const rb = fakeReadback({ ok: true, text: 'So it is.' })
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' }, { type: 'done' }]),
      actions: fakeActions(), pack, out, settings: settings(), readback: rb })
    c.prompt('hi')
    await new Promise(r => setTimeout(r, 20))
    expect(out.doneArgs.at(-1)).toMatchObject({ id: 1, readback: true })
    expect(c.status().readback).toBe(true)
    expect(rb.calls).toEqual(['Hello'])
    expect(out.readbacks).toEqual([{ id: 1, text: 'So it is.' }])
  })
  it('gives the second reply id 2', async () => {
    const out = fakeOut(); const rb = fakeReadback({ ok: true, text: 'x' })
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'done' }]),
      actions: fakeActions(), pack, out, settings: settings(), readback: rb })
    c.prompt('one'); await new Promise(r => setTimeout(r, 20))
    c.prompt('two'); await new Promise(r => setTimeout(r, 20))
    expect(out.doneArgs.map(d => (d as { id: number }).id)).toEqual([1, 2])
    expect(out.readbacks).toEqual([{ id: 1, text: 'x' }, { id: 2, text: 'x' }])
  })
  it('skips the readback on an error turn, an empty reply, and when no readback is configured', async () => {
    const rb = fakeReadback({ ok: true, text: 'x' })
    for (const events of [
      [{ type: 'text', delta: 'a' }, { type: 'done', error: 'boom' }] as BrainEvent[],
      [{ type: 'text', delta: '   ' }, { type: 'done' }] as BrainEvent[],
    ]) {
      const out = fakeOut()
      const c = new ChatController({ brain: scriptedBrain(events), actions: fakeActions(), pack, out, settings: settings(), readback: rb })
      c.prompt('hi'); await new Promise(r => setTimeout(r, 20))
      expect(out.readbacks).toEqual([])
    }
    expect(rb.calls).toEqual([])
    const out = fakeOut()
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'done' }]), actions: fakeActions(), pack, out, settings: settings() })
    c.prompt('hi'); await new Promise(r => setTimeout(r, 20))
    expect(out.readbacks).toEqual([])
  })
  it('logs a failed readback and tells the renderer to settle the bubble', async () => {
    const out = fakeOut(); const lines: string[] = []
    const c = new ChatController({ brain: scriptedBrain([{ type: 'text', delta: 'a' }, { type: 'done' }]),
      actions: fakeActions(), pack, out, settings: settings(), readback: fakeReadback({ ok: false, reason: 'timeout after 20000 ms' }), log: (l) => lines.push(l) })
    c.prompt('hi'); await new Promise(r => setTimeout(r, 20))
    expect(out.readbacks).toEqual([{ id: 1, failed: true }])
    expect(lines).toEqual(['readback failed: timeout after 20000 ms'])
  })
})
