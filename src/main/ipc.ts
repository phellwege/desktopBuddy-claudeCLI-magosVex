import { ipcMain, type BrowserWindow } from 'electron'
import { CH, type ChatStatusPayload, type OriginPayload, type PackLoadedPayload, type ThemePayload } from '../shared/ipc'
import type { ImageAttachment } from '../shared/images'
import type { Buddy } from './buddy'
import type { Actions } from './actions'
import { setHologramInteractive, setOverlayInteractive } from './windows'
import { originToWindow, shouldReplaceHologramX } from './geometry'

export interface ChatPort { prompt(text: string, images?: readonly ImageAttachment[]): void; permissionAnswer(id: string, allow: boolean, remember?: boolean): void; stop(): void }
export interface IpcDeps {
  buddy: Buddy; actions: Actions; overlay: BrowserWindow; hologram: BrowserWindow
  packPayload: PackLoadedPayload; theme: ThemePayload; chat: ChatPort
  /** Last screen-coordinate origin the overlay reported, shared with main/index.ts so it
   * can re-send the origin (translated into the new window's coordinates) whenever the
   * hologram window is repositioned or shown. */
  origin: { current: OriginPayload | null }
  /** Re-places the hologram window, optionally at a given x fraction instead of
   * Buddy.getState().x (used mid-walk, since that only updates on arrival). */
  placeHologram(xFraction?: number): void
  /** The x fraction the hologram was last placed at, kept in sync by placeHologram. */
  lastPlacedX: { current: number }
  status(): ChatStatusPayload; showContextMenu(x: number, y: number): void
  /** Sends the overlay its window origin and resting display, which it needs before it can
   * place a character whose position is in absolute virtual coordinates. */
  sendStage(): void
  /** The pointer has picked him up: widen the overlay to the whole desktop, keep it solid,
   * and step the panel aside until he lands. */
  beginDrag(): void
  /** Released at this floor-center point, in virtual pixels. */
  endDrag(drop: { x: number; y: number }): void
}

// Windows can be gone by the time a late IPC message wants them (app quitting, e2e teardown):
// sending to a destroyed webContents throws, which only ever showed up as log noise.
function send(win: BrowserWindow, channel: string, payload: unknown): void {
  if (!win.isDestroyed()) win.webContents.send(channel, payload)
}

export function wireIpc(d: IpcDeps): void {
  ipcMain.on(CH.overlayReady, () => {
    send(d.overlay, CH.packLoaded, d.packPayload)
    // Stage before state: the state message carries virtual-pixel targets that only mean
    // something once the renderer knows where its window sits.
    d.sendStage()
    send(d.overlay, CH.buddyState, d.buddy.view())
  })
  // Hover drives click-through, but a drag must keep the window solid wherever the pointer
  // goes, so the renderer's hover reports are ignored for the duration of one.
  ipcMain.on(CH.overlayHover, (_e, p: { over: boolean }) => {
    if (d.buddy.getState().dragging) return
    setOverlayInteractive(d.overlay, p.over)
  })
  ipcMain.on(CH.overlayDragStart, () => d.beginDrag())
  ipcMain.on(CH.overlayDragEnd, (_e, p: { x: number; y: number }) => d.endDrag(p))
  ipcMain.on(CH.overlayClick, () => {
    d.buddy.interact()
    if (d.buddy.getState().panelOpen) d.actions.closePanel(); else d.actions.openPanel()
  })
  ipcMain.on(CH.overlayContextMenu, (_e, p: { x: number; y: number }) => d.showContextMenu(p.x, p.y))
  ipcMain.on(CH.overlayArrived, () => d.buddy.arrived())
  ipcMain.on(CH.overlayOneShotDone, () => d.buddy.oneShotDone())
  ipcMain.on(CH.overlayOrigin, (_e, p: OriginPayload) => {
    d.origin.current = p
    if (d.hologram.isVisible()) {
      // Mid-walk, Buddy.x only updates on arrival, so the cone would otherwise be cast
      // from wherever the character last stood still. Re-place under the live x fraction
      // the overlay reports instead, before translating the origin into the (possibly
      // just-moved) hologram window's coordinates.
      if (shouldReplaceHologramX(d.lastPlacedX.current, p.xFraction)) d.placeHologram(p.xFraction)
      send(d.hologram, CH.hologramOrigin, originToWindow(p, d.hologram.getBounds()))
    }
  })
  ipcMain.on(CH.hologramHover, (_e, p: { over: boolean }) => setHologramInteractive(d.hologram, p.over))
  ipcMain.on(CH.hologramReady, () => {
    send(d.hologram, CH.packLoaded, d.packPayload)
    send(d.hologram, CH.theme, d.theme)
    send(d.hologram, CH.chatStatus, d.status())
  })
  ipcMain.on(CH.chatPrompt, (_e, p: { text: string }) => d.chat.prompt(p.text))
  ipcMain.on(CH.chatPermissionAnswer, (_e, p: { id: string; allow: boolean; remember?: boolean }) => d.chat.permissionAnswer(p.id, p.allow, p.remember))
  ipcMain.on(CH.chatClose, () => d.actions.closePanel())
  ipcMain.on(CH.chatStop, () => d.chat.stop())
}
