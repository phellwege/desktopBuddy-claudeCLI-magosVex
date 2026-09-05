import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState, sessionTranscriptExists } from './state'

const tmpDir = () => mkdtempSync(join(tmpdir(), 'state-'))
const tmpPath = () => join(tmpDir(), 'state.json')

describe('loadState', () => {
  it('returns null when the file is missing', () => {
    expect(loadState(tmpPath())).toBeNull()
  })
  it('returns null on invalid JSON', () => {
    const p = tmpPath()
    writeFileSync(p, '{ not json')
    expect(loadState(p)).toBeNull()
  })
  it('returns null when workspace has the wrong type', () => {
    const p = tmpPath()
    writeFileSync(p, JSON.stringify({ workspace: 5, sessionId: null }))
    expect(loadState(p)).toBeNull()
  })
  it('returns null when sessionId is neither null nor a string', () => {
    const p = tmpPath()
    writeFileSync(p, JSON.stringify({ workspace: 'C:\\repo', sessionId: 5 }))
    expect(loadState(p)).toBeNull()
  })
  it('loads a valid state with a null sessionId', () => {
    const p = tmpPath()
    writeFileSync(p, JSON.stringify({ sessionId: null, workspace: 'C:\\repo' }))
    expect(loadState(p)).toEqual({ sessionId: null, workspace: 'C:\\repo' })
  })
  it('loads a valid state with a string sessionId', () => {
    const p = tmpPath()
    writeFileSync(p, JSON.stringify({ sessionId: 'abc123', workspace: 'C:\\repo' }))
    expect(loadState(p)).toEqual({ sessionId: 'abc123', workspace: 'C:\\repo' })
  })
})

describe('saveState', () => {
  it('round-trips through loadState, creating the directory', () => {
    const dir = join(tmpDir(), 'nested')
    const p = join(dir, 'state.json')
    saveState(p, { sessionId: 's1', workspace: 'D:\\w' })
    expect(existsSync(p)).toBe(true)
    expect(loadState(p)).toEqual({ sessionId: 's1', workspace: 'D:\\w' })
  })
})

describe('sessionTranscriptExists', () => {
  it('encodes colons and backslashes to dashes and checks the transcript file', () => {
    const home = tmpDir()
    const dir = join(home, '.claude', 'projects', 'C--repo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sess1.jsonl'), '')
    expect(sessionTranscriptExists(home, 'C:\\repo', 'sess1')).toBe(true)
    expect(sessionTranscriptExists(home, 'C:\\repo', 'sess2')).toBe(false)
  })
  it('encodes forward slashes to dashes too', () => {
    const home = tmpDir()
    const dir = join(home, '.claude', 'projects', '-home-peter-repo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sess1.jsonl'), '')
    expect(sessionTranscriptExists(home, '/home/peter/repo', 'sess1')).toBe(true)
  })
  it('returns false when the workspace directory does not exist at all', () => {
    const home = tmpDir()
    expect(sessionTranscriptExists(home, 'C:\\nope', 'sess1')).toBe(false)
  })
})
