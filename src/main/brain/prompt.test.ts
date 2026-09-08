import { describe, it, expect } from 'vitest'
import { toolsNote } from './prompt'

describe('toolsNote', () => {
  it('names every tool and the love rule, and no persona', () => {
    const n = toolsNote()
    for (const t of ['go_to', 'set_mood', 'emote', 'sleep', 'wake', 'get_state', 'set_expression']) {
      expect(n).toContain(t)
    }
    expect(n).toContain('love')
    expect(n.toLowerCase()).not.toContain('omnissiah')
    expect(n).toContain('[Image #N: name]')
    expect(n).toContain('do not read them from disk')
  })
})
