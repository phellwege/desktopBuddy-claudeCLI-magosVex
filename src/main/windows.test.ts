import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { setHologramInteractive } from './windows'

function fakeWindow(): { setIgnoreMouseEvents: ReturnType<typeof vi.fn> } {
  return { setIgnoreMouseEvents: vi.fn() }
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
