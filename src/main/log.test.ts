import { describe, it, expect } from 'vitest'
import { formatLogLine } from './log'

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
