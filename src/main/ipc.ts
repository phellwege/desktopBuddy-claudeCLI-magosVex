import { ipcMain, type BrowserWindow } from 'electron'
import { CH, type ChatStatusPayload, type PackLoadedPayload, type ThemePayload } from '../shared/ipc'
import type { Buddy } from './buddy'
import type { Actions } from './actions'
import { setOverlayInteractive } from './windows'

export interface ChatPort { prompt(text: string): void; permissionAnswer(id: string, allow: boolean): void; stop(): void }
export interface IpcDeps {
  buddy: Buddy; actions: Actions; overlay: BrowserWindow; hologram: BrowserWindow
  packPayload: PackLoadedPayload; theme: ThemePayload; chat: ChatPort
  status(): ChatStatusPayload; showContextMenu(x: number, y: number): void
}

export function wireIpc(d: IpcDeps): void {
  ipcMain.on(CH.overlayReady, () => {
    d.overlay.webContents.send(CH.packLoaded, d.packPayload)
    d.overlay.webContents.send(CH.buddyState, d.buddy.view())
  })
  ipcMain.on(CH.overlayHover, (_e, p: { over: boolean }) => setOverlayInteractive(d.overlay, p.over))
  ipcMain.on(CH.overlayClick, () => {
    d.buddy.interact()
    if (d.buddy.getState().panelOpen) d.actions.closePanel(); else d.actions.openPanel()
  })
  ipcMain.on(CH.overlayContextMenu, (_e, p: { x: number; y: number }) => d.showContextMenu(p.x, p.y))
  ipcMain.on(CH.overlayArrived, () => d.buddy.arrived())
  ipcMain.on(CH.overlayOneShotDone, () => d.buddy.oneShotDone())
  ipcMain.on(CH.hologramReady, () => {
    d.hologram.webContents.send(CH.theme, d.theme)
    d.hologram.webContents.send(CH.chatStatus, d.status())
  })
  ipcMain.on(CH.chatPrompt, (_e, p: { text: string }) => d.chat.prompt(p.text))
  ipcMain.on(CH.chatPermissionAnswer, (_e, p: { id: string; allow: boolean }) => d.chat.permissionAnswer(p.id, p.allow))
  ipcMain.on(CH.chatClose, () => d.actions.closePanel())
  ipcMain.on(CH.chatStop, () => d.chat.stop())
}
