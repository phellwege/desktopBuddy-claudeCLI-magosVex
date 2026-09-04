import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { setHologramInteractive, blockNavigation } from './windows'

function fakeWindow(): { setIgnoreMouseEvents: ReturnType<typeof vi.fn> } {
  return { setIgnoreMouseEvents: vi.fn() }
}

type NavigationEvent = { preventDefault: () => void }
type OpenHandler = () => { action: 'deny' }

function fakeHologramWindow(): {
  webContents: { on: ReturnType<typeof vi.fn>; setWindowOpenHandler: ReturnType<typeof vi.fn> }
  handlers: Map<string, (event: NavigationEvent) => void>
  getOpenHandler: () => OpenHandler | undefined
} {
  const handlers = new Map<string, (event: NavigationEvent) => void>()
  let openHandler: OpenHandler | undefined
  return {
    webContents: {
      on: vi.fn((event: string, handler: (event: NavigationEvent) => void) => { handlers.set(event, handler) }),
      setWindowOpenHandler: vi.fn((handler: OpenHandler) => { openHandler = handler }),
    },
    handlers,
    getOpenHandler: () => openHandler,
  }
}

describe('setHologramInteractive', () => {
  it('interactive: false ignores mouse events with forwarding, so every open starts click-through', () => {
    const w = fakeWindow()
    setHologramInteractive(w as unknown as BrowserWindow, false)
    expect(w.setIgnoreMouseEvents).toHaveBeenCalledExactlyOnceWith(true, { forward: true })
  })
  it('interactive: true stops ignoring mouse events', () => {
    const w = fakeWindow()
    setHologramInteractive(w as unknown as BrowserWindow, true)
    expect(w.setIgnoreMouseEvents).toHaveBeenCalledExactlyOnceWith(false)
  })
  it('toggling back to false after true restores click-through (hide/show does not stick interactive)', () => {
    const w = fakeWindow()
    setHologramInteractive(w as unknown as BrowserWindow, true)
    setHologramInteractive(w as unknown as BrowserWindow, false)
    expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
  })
})

describe('blockNavigation', () => {
  it('hologram window blocks navigation and new windows', () => {
    const w = fakeHologramWindow()
    blockNavigation(w as unknown as BrowserWindow)
    const preventDefault = vi.fn()
    w.handlers.get('will-navigate')?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(w.getOpenHandler()?.()).toEqual({ action: 'deny' })
  })
})
