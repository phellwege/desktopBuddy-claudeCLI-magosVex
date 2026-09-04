import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPack, pickLine } from './pack'

const FIXTURE = join(__dirname, '../../test/fixtures/pack-min')

function copyFixture(edit: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'))
  cpSync(FIXTURE, dir, { recursive: true })
  edit(dir)
  return dir
}

describe('loadPack', () => {
  it('loads the fixture and reads the persona prompt', () => {
    const r = loadPack(FIXTURE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pack.name).toBe('Fixture')
    expect(r.pack.persona.prompt.trim()).toBe('You are a fixture.')
    expect(r.pack.persona.lines.greeting).toEqual(['hi'])
    expect(r.pack.persona.lines.error).toEqual([])
  })
  it('resolves fallbacks', () => {
    const r = loadPack(FIXTURE)
    if (!r.ok) throw new Error(r.errors.join())
    const a = r.pack.animations
    expect(a.run.right).toEqual(['w0'])
    expect(a.run.fps).toBe(12)
    expect(a.run.loop).toBe(true)
    expect(a.sleep.right).toEqual(['s0'])          // sleep -> sit
    expect(a.emote_happy.right).toEqual(['a0', 'a1']) // -> idle
    expect(a.emote_happy.loop).toBe(false)
    expect(a.emote_thinking.loop).toBe(true)
    expect(a.idle.fps).toBe(6)
    expect(a.sit.fps).toBe(2)
  })
  it('mirrors a right-only walk', () => {
    const r = loadPack(FIXTURE)
    if (!r.ok) throw new Error(r.errors.join())
    expect(r.pack.animations.walk.left).toEqual(['w0'])
    expect(r.pack.animations.walk.mirrorLeft).toBe(true)
    expect(r.pack.animations.idle.mirrorLeft).toBe(false)
  })
  it('fails when idle is missing', () => {
    const dir = copyFixture(d => writeFileSync(join(d, 'animations.json'), JSON.stringify({ walk: { right: ['w0'] } })))
    const r = loadPack(dir)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join('\n')).toContain('missing required "idle"')
  })
  it('fails on an unknown frame name', () => {
    const dir = copyFixture(d => writeFileSync(join(d, 'animations.json'), JSON.stringify({ idle: { frames: ['nope'] }, walk: { right: ['w0'] } })))
    const r = loadPack(dir)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join('\n')).toContain('unknown frame "nope"')
  })
  it('fails on a missing manifest', () => {
    const r = loadPack(join(tmpdir(), 'does-not-exist-' + Date.now()))
    expect(r.ok).toBe(false)
  })
  it('loads a frame origin when present and leaves it undefined otherwise', () => {
    const dir = copyFixture(d => {
      const atlas = JSON.parse(readFileSync(join(FIXTURE, 'atlas.json'), 'utf8'))
      atlas.frames.a0.origin = [3, 4]
      writeFileSync(join(d, 'atlas.json'), JSON.stringify(atlas))
    })
    const r = loadPack(dir)
    if (!r.ok) throw new Error(r.errors.join())
    expect(r.pack.atlas.frames.a0!.origin).toEqual([3, 4])
    expect(r.pack.atlas.frames.a1!.origin).toBeUndefined()
  })
})

describe('pickLine', () => {
  it('returns null for an empty list and a member otherwise', () => {
    const r = loadPack(FIXTURE)
    if (!r.ok) throw new Error(r.errors.join())
    expect(pickLine(r.pack, 'error')).toBeNull()
    expect(pickLine(r.pack, 'greeting', () => 0)).toBe('hi')
  })
})
