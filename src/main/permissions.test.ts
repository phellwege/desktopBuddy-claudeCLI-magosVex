import { describe, it, expect } from 'vitest'
import { SessionAllows } from './permissions'

describe('SessionAllows', () => {
  it('does not allow a tool that was never remembered', () => {
    const s = new SessionAllows()
    expect(s.allows('Bash')).toBe(false)
  })
  it('allows a tool once it has been remembered, and only that tool', () => {
    const s = new SessionAllows()
    s.remember('Bash')
    expect(s.allows('Bash')).toBe(true)
    expect(s.allows('WebFetch')).toBe(false)
  })
  it('clear() forgets everything remembered', () => {
    const s = new SessionAllows()
    s.remember('Bash')
    s.remember('WebFetch')
    s.clear()
    expect(s.allows('Bash')).toBe(false)
    expect(s.allows('WebFetch')).toBe(false)
  })
})
