import { contextBridge } from 'electron'
contextBridge.exposeInMainWorld('buddy', { version: 1 })
