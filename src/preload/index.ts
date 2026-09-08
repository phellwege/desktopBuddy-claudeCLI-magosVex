import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH, type BuddyBridge, type ChatPromptPayload, type StageBytesPayload, type StagePathPayload } from '../shared/ipc'
import { makeOn } from './bridge'

const on = makeOn(ipcRenderer)

const bridge: BuddyBridge = {
  onPackLoaded: on(CH.packLoaded),
  onBuddyState: on(CH.buddyState),
  onOverlayStage: on(CH.overlayStage),
  onOverlayMutter: on(CH.overlayMutter),
  overlayReady: () => ipcRenderer.send(CH.overlayReady),
  hover: (over) => ipcRenderer.send(CH.overlayHover, { over }),
  click: () => ipcRenderer.send(CH.overlayClick),
  contextMenu: (x, y) => ipcRenderer.send(CH.overlayContextMenu, { x, y }),
  arrived: () => ipcRenderer.send(CH.overlayArrived),
  oneShotDone: () => ipcRenderer.send(CH.overlayOneShotDone),
  origin: (x, y, xFraction) => ipcRenderer.send(CH.overlayOrigin, { x, y, xFraction }),
  dragStart: () => ipcRenderer.send(CH.overlayDragStart),
  dragEnd: (x, y) => ipcRenderer.send(CH.overlayDragEnd, { x, y }),
  onOrigin: on(CH.hologramOrigin),
  onTheme: on(CH.theme),
  onChatDelta: on(CH.chatDelta),
  onChatActivity: on(CH.chatActivity),
  onChatDone: on(CH.chatDone),
  onChatReadback: on(CH.chatReadback),
  onChatPermission: on(CH.chatPermission),
  onChatStatus: on(CH.chatStatus),
  onChatSystem: on(CH.chatSystem),
  // No payload on this one, unlike the others above: wrap makeOn's callback shape by hand
  // rather than force a fake payload type through it.
  onChatClear: (cb) => {
    const wrapped = () => cb()
    ipcRenderer.on(CH.chatClear, wrapped)
    return () => ipcRenderer.removeListener(CH.chatClear, wrapped)
  },
  hologramReady: () => ipcRenderer.send(CH.hologramReady),
  hologramHover: (over) => ipcRenderer.send(CH.hologramHover, { over }),
  prompt: (text, imageIds) => ipcRenderer.send(CH.chatPrompt, { text, images: imageIds } satisfies ChatPromptPayload),
  stageImageBytes: (bytes, mediaType, name) => ipcRenderer.invoke(CH.imageStageBytes, { bytes, mediaType, name } satisfies StageBytesPayload),
  stageImagePath: (path) => ipcRenderer.invoke(CH.imageStagePath, { path } satisfies StagePathPayload),
  discardImage: (id) => ipcRenderer.send(CH.imageDiscard, { id }),
  // webUtils works in a sandboxed preload; the File must be the renderer's own object,
  // which contextBridge passes through for this call.
  pathForFile: (file) => webUtils.getPathForFile(file),
  permissionAnswer: (id, allow, remember) => ipcRenderer.send(CH.chatPermissionAnswer, { id, allow, remember }),
  closePanel: () => ipcRenderer.send(CH.chatClose),
  stop: () => ipcRenderer.send(CH.chatStop),
}

contextBridge.exposeInMainWorld('buddy', bridge)
