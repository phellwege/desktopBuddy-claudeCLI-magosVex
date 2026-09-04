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
  onTheme: on(CH.theme),
  onChatDelta: on(CH.chatDelta),
  onChatActivity: on(CH.chatActivity),
  onChatDone: on(CH.chatDone),
  onChatPermission: on(CH.chatPermission),
  onChatStatus: on(CH.chatStatus),
  onChatSystem: on(CH.chatSystem),
  hologramReady: () => ipcRenderer.send(CH.hologramReady),
  prompt: (text) => ipcRenderer.send(CH.chatPrompt, { text }),
  permissionAnswer: (id, allow) => ipcRenderer.send(CH.chatPermissionAnswer, { id, allow }),
  closePanel: () => ipcRenderer.send(CH.chatClose),
  stop: () => ipcRenderer.send(CH.chatStop),
}

contextBridge.exposeInMainWorld('buddy', bridge)
