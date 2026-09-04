import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLog, formatLogLine } from './log'

describe('formatLogLine', () => {
  it('prefixes an ISO timestamp and scope before the message', () => {
    const line = formatLogLine('main', 'uncaughtException: boom')
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z main uncaughtException: boom\n$/)
  })
  it('keeps scope and message distinct for a different scope', () => {
    const line = formatLogLine('hologram', 'gone: crashed')
    expect(line.endsWith(' hologram gone: crashed\n')).toBe(true)
  })
})

describe('appendLog', () => {
  const tmpFiles: string[] = []
  afterEach(() => { for (const f of tmpFiles.splice(0)) rmSync(f, { force: true }) })

  it('swallows a write failure instead of throwing, when the log dir cannot exist', () => {
    // A plain file in place of the log directory: appendFileSync's join(logDir, 'renderer.log')
    // resolves to <file>/renderer.log, which fails ENOTDIR since a path segment is a file.
    const fakeDir = join(mkdtempSync(join(tmpdir(), 'log-')), 'not-a-dir')
    writeFileSync(fakeDir, 'not a directory')
    tmpFiles.push(fakeDir)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => appendLog(fakeDir, 'main', 'uncaughtException: boom')).not.toThrow()
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })
})
