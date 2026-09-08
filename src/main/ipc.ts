import { ipcMain, type BrowserWindow } from 'electron'
import { CH, type ChatPromptPayload, type ChatStatusPayload, type HologramModePayload, type OriginPayload, type PackLoadedPayload, type PtyStartPayload, type PtyStartResult, type StageBytesPayload, type StagePathPayload, type StageResult, type ThemePayload } from '../shared/ipc'
import type { ImageAttachment } from '../shared/images'
import type { Buddy } from './buddy'
import type { Actions } from './actions'
import { setHologramInteractive, setOverlayInteractive } from './windows'
import { originToWindow, shouldReplaceHologramX } from './geometry'

export interface ChatPort { prompt(text: string, images?: readonly ImageAttachment[]): void; permissionAnswer(id: string, allow: boolean, remember?: boolean): void; stop(): void }
// Main's side of the panel's attachment chips (spec 7): stage returns what the chip shows
// or the refusal reason; take hands the attachments to the chat controller in chip order.
export interface ImagePort {
  stageBytes(p: StageBytesPayload): StageResult
  stagePath(p: StagePathPayload): StageResult
  discard(id: string): void
  take(ids: readonly string[]): ImageAttachment[]
  clear(): void
}
// Main's side of the CLI tab's terminal (spec T-5).
export interface PtyPort {
  start(cols: number, rows: number): PtyStartResult
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}
export interface IpcDeps {
  buddy: Buddy; actions: Actions; overlay: BrowserWindow; hologram: BrowserWindow
  packPayload: PackLoadedPayload; theme: ThemePayload; chat: ChatPort; images: ImagePort; pty: PtyPort
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
  /** The panel switched tabs: place the window for that tab's panel size. */
  setMode(cli: boolean): void
  /** Copy on select in the terminal. */
  writeClipboard(text: string): void
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
    // The renderer's chip list is always empty when this fires (a fresh load or a reload),
    // so anything still staged in main from before is an orphan.
    d.images.clear()
    send(d.hologram, CH.packLoaded, d.packPayload)
    send(d.hologram, CH.theme, d.theme)
    send(d.hologram, CH.chatStatus, d.status())
  })
  ipcMain.on(CH.chatPrompt, (_e, p: ChatPromptPayload) => d.chat.prompt(p.text, d.images.take(p.images ?? [])))
  // invoke, not send: the renderer awaits the chip it should show, or the reason.
  ipcMain.handle(CH.imageStageBytes, (_e, p: StageBytesPayload) => d.images.stageBytes(p))
  ipcMain.handle(CH.imageStagePath, (_e, p: StagePathPayload) => d.images.stagePath(p))
  ipcMain.on(CH.imageDiscard, (_e, p: { id: string }) => d.images.discard(p.id))
  ipcMain.on(CH.chatPermissionAnswer, (_e, p: { id: string; allow: boolean; remember?: boolean }) => d.chat.permissionAnswer(p.id, p.allow, p.remember))
  ipcMain.on(CH.chatClose, () => d.actions.closePanel())
  ipcMain.on(CH.chatStop, () => d.chat.stop())
  ipcMain.handle(CH.ptyStart, (_e, p: PtyStartPayload) => d.pty.start(p.cols, p.rows))
  ipcMain.on(CH.ptyInput, (_e, p: { data: string }) => d.pty.write(p.data))
  ipcMain.on(CH.ptyResize, (_e, p: PtyStartPayload) => d.pty.resize(p.cols, p.rows))
  ipcMain.on(CH.ptyKill, () => d.pty.kill())
  ipcMain.on(CH.hologramMode, (_e, p: HologramModePayload) => d.setMode(p.cli))
  ipcMain.on(CH.clipboardWrite, (_e, p: { text: string }) => d.writeClipboard(p.text))
}
