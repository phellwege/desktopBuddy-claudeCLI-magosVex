import { describe, it, expect, vi } from 'vitest'
import { buildTrayTemplate, type TrayTemplateDeps } from './tray'

function findItem(template: ReturnType<typeof buildTrayTemplate>, label: string) {
  const item = template.find((i) => i.label === label)
  if (!item) throw new Error(`no item labeled ${label}`)
  return item
}

function fakeDeps(overrides: Partial<TrayTemplateDeps> = {}): TrayTemplateDeps {
  return {
    actions: { getState: () => ({ panelOpen: false }) as never, wake: vi.fn(), sleep: vi.fn() },
    buddy: { getState: () => ({ asleep: false }) as never },
    overlay: { showInactive: vi.fn(), hide: vi.fn() },
    hologram: { show: vi.fn(), hide: vi.fn(), focus: vi.fn() },
    placeHologram: vi.fn(),
    quit: vi.fn(),
    ...overrides,
  }
}

describe('buildTrayTemplate', () => {
  it('Show only restores the overlay when the panel is closed', () => {
    const d = fakeDeps({ actions: { getState: () => ({ panelOpen: false }) as never, wake: vi.fn(), sleep: vi.fn() } })
    findItem(buildTrayTemplate(d), 'Show').click?.(undefined as never, undefined as never, undefined as never)
    expect(d.overlay.showInactive).toHaveBeenCalledOnce()
    expect(d.placeHologram).not.toHaveBeenCalled()
    expect(d.hologram.show).not.toHaveBeenCalled()
    expect(d.hologram.focus).not.toHaveBeenCalled()
  })

  it('Show restores and re-places the hologram when the panel was open', () => {
    const d = fakeDeps({ actions: { getState: () => ({ panelOpen: true }) as never, wake: vi.fn(), sleep: vi.fn() } })
    findItem(buildTrayTemplate(d), 'Show').click?.(undefined as never, undefined as never, undefined as never)
    expect(d.overlay.showInactive).toHaveBeenCalledOnce()
    expect(d.placeHologram).toHaveBeenCalledOnce()
    expect(d.hologram.show).toHaveBeenCalledOnce()
    expect(d.hologram.focus).toHaveBeenCalledOnce()
  })

  it('Hide hides both windows', () => {
    const d = fakeDeps()
    findItem(buildTrayTemplate(d), 'Hide').click?.(undefined as never, undefined as never, undefined as never)
    expect(d.hologram.hide).toHaveBeenCalledOnce()
    expect(d.overlay.hide).toHaveBeenCalledOnce()
  })

  it('labels the sleep item by asleep state and dispatches to the matching action', () => {
    const asleepDeps = fakeDeps({ buddy: { getState: () => ({ asleep: true }) as never } })
    const wakeItem = findItem(buildTrayTemplate(asleepDeps), 'Wake')
    wakeItem.click?.(undefined as never, undefined as never, undefined as never)
    expect(asleepDeps.actions.wake).toHaveBeenCalledOnce()

    const awakeDeps = fakeDeps({ buddy: { getState: () => ({ asleep: false }) as never } })
    const sleepItem = findItem(buildTrayTemplate(awakeDeps), 'Sleep')
    sleepItem.click?.(undefined as never, undefined as never, undefined as never)
    expect(awakeDeps.actions.sleep).toHaveBeenCalledOnce()
  })

  it('Quit calls the injected quit callback', () => {
    const d = fakeDeps()
    findItem(buildTrayTemplate(d), 'Quit').click?.(undefined as never, undefined as never, undefined as never)
    expect(d.quit).toHaveBeenCalledOnce()
  })
})
