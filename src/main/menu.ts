import { Menu, type BrowserWindow } from 'electron'
import type { Actions } from './actions'
import type { Buddy } from './buddy'

export function buildTemplate(d: { actions: Actions; buddy: Buddy; quit: () => void }): Electron.MenuItemConstructorOptions[] {
  const asleep = d.buddy.getState().asleep
  return [
    { label: 'Go left', click: () => void d.actions.goTo(0) },
    { label: 'Go center', click: () => void d.actions.goTo(0.5) },
    { label: 'Go right', click: () => void d.actions.goTo(1) },
    { type: 'separator' },
    { label: asleep ? 'Wake' : 'Sleep', click: () => (asleep ? d.actions.wake() : d.actions.sleep()) },
    { type: 'separator' },
    { label: 'Quit', click: d.quit },
  ]
}

export function showContextMenu(d: { actions: Actions; buddy: Buddy; overlay: BrowserWindow }, x: number, y: number): void {
  const menu = Menu.buildFromTemplate(buildTemplate({ ...d, quit: () => require('electron').app.quit() }))
  d.overlay.setFocusable(true)
  menu.popup({ window: d.overlay, x, y, callback: () => d.overlay.setFocusable(false) })
}
