import { contextBridge, ipcRenderer } from 'electron'
import { CH, type BuddyBridge } from '../shared/ipc'
import { makeOn } from './bridge'

const on = makeOn(ipcRenderer)

const bridge: BuddyBridge = {
  onPackLoaded: on(CH.packLoaded),
  onBuddyState: on(CH.buddyState),
  overlayReady: () => ipcRenderer.send(CH.overlayReady),
  hover: (over) => ipcRenderer.send(CH.overlayHover, { over }),
  click: () => ipcRenderer.send(CH.overlayClick),
  contextMenu: (x, y) => ipcRenderer.send(CH.overlayContextMenu, { x, y }),
  arrived: () => ipcRenderer.send(CH.overlayArrived),
  oneShotDone: () => ipcRenderer.send(CH.overlayOneShotDone),
  origin: (x, y, xFraction) => ipcRenderer.send(CH.overlayOrigin, { x, y, xFraction }),
  onOrigin: on(CH.hologramOrigin),
  onTheme: on(CH.theme),
  onChatDelta: on(CH.chatDelta),
  onChatActivity: on(CH.chatActivity),
  onChatDone: on(CH.chatDone),
  onChatReadback: on(CH.chatReadback),
  onChatPermission: on(CH.chatPermission),
  onChatStatus: on(CH.chatStatus),
  onChatSystem: on(CH.chatSystem),
  hologramReady: () => ipcRenderer.send(CH.hologramReady),
  hologramHover: (over) => ipcRenderer.send(CH.hologramHover, { over }),
  prompt: (text) => ipcRenderer.send(CH.chatPrompt, { text }),
  permissionAnswer: (id, allow, remember) => ipcRenderer.send(CH.chatPermissionAnswer, { id, allow, remember }),
  closePanel: () => ipcRenderer.send(CH.chatClose),
  stop: () => ipcRenderer.send(CH.chatStop),
}

contextBridge.exposeInMainWorld('buddy', bridge)
