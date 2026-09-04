import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { PANEL_SIZE, overlayBounds } from './geometry'

export function rendererUrl(page: 'overlay' | 'hologram'): { url?: string; file?: string } {
  const dev = process.env.ELECTRON_RENDERER_URL
  return dev ? { url: `${dev}/${page}/index.html` } : { file: join(__dirname, `../renderer/${page}/index.html`) }
}
export function loadPage(win: BrowserWindow, page: 'overlay' | 'hologram'): void {
  const target = rendererUrl(page)
  if (target.url) void win.loadURL(target.url)
  else if (target.file) void win.loadFile(target.file)
}

const preload = join(__dirname, '../preload/index.js')
const webPreferences = { preload, contextIsolation: true, nodeIntegration: false, sandbox: true }

export function createOverlayWindow(charH: number): BrowserWindow {
  const b = overlayBounds(screen.getPrimaryDisplay().workArea, charH)
  const win = new BrowserWindow({
    ...b, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, focusable: false,
    resizable: false, movable: false, hasShadow: false, show: false, webPreferences,
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.once('ready-to-show', () => win.showInactive())
  loadPage(win, 'overlay')
  return win
}

// Sanitized markdown renders links as plain text (see the hologram markdown renderer),
// but this is a second line of defense: nothing loaded into the panel, typed or
// streamed, should be able to steer the window to another page or pop a new one.
export function blockNavigation(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (event) => { event.preventDefault() })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

export function createHologramWindow(onBlur: () => void): BrowserWindow {
  const win = new BrowserWindow({
    ...PANEL_SIZE, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, show: false, hasShadow: false, webPreferences,
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.on('blur', onBlur)
  blockNavigation(win)
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'q') {
      event.preventDefault()
      app.quit()
    }
  })
  loadPage(win, 'hologram')
  return win
}

// Watchdog map: while a window is interactive, poll the cursor against its bounds.
// Electron's mouseleave does not reliably reach a window that is (or recently was)
// forwarding ignored mouse events, so a fast pointer exit can leave the overlay
// stuck fully interactive with no event to tell it the cursor is gone. Polling the
// cursor position is a small, simple backstop for that gap.
const watchdogs = new WeakMap<BrowserWindow, ReturnType<typeof setInterval>>()

export function setOverlayInteractive(win: BrowserWindow, interactive: boolean): void {
  const existing = watchdogs.get(win)
  if (existing) { clearInterval(existing); watchdogs.delete(win) }
  if (interactive) {
    win.setIgnoreMouseEvents(false)
    const timer = setInterval(() => {
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
      if (!inside) setOverlayInteractive(win, false)
    }, 100)
    watchdogs.set(win, timer)
  } else {
    win.setIgnoreMouseEvents(true, { forward: true })
  }
}

export function rebound(overlay: BrowserWindow, charH: number): void {
  overlay.setBounds(overlayBounds(screen.getPrimaryDisplay().workArea, charH))
}

// The hologram window has no cursor watchdog: unlike the overlay (which must stay
// interactive while the pointer sits over an irregular sprite hit-region), the hologram
// closes on blur, so a stuck-interactive window just means the next click outside it
// closes the panel rather than falling through to the desktop.
export function setHologramInteractive(win: BrowserWindow, interactive: boolean): void {
  if (interactive) win.setIgnoreMouseEvents(false)
  else win.setIgnoreMouseEvents(true, { forward: true })
}
