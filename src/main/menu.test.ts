import { describe, it, expect, vi } from 'vitest'
import { buildTemplate } from './menu'

describe('buildTemplate', () => {
  it('carries an Open in Claude Code item that calls openCli', () => {
    const openCli = vi.fn()
    const template = buildTemplate({
      actions: { goTo: vi.fn(), wake: vi.fn(), sleep: vi.fn() } as never,
      buddy: { getState: () => ({ asleep: false }) } as never,
      quit: vi.fn(), openCli,
    })
    const item = template.find(i => i.label === 'Open in Claude Code')
    expect(item).toBeDefined()
    item?.click?.(undefined as never, undefined as never, undefined as never)
    expect(openCli).toHaveBeenCalledOnce()
  })
})
