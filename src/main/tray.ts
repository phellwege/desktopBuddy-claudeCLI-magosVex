import { app, Menu, Tray, nativeImage, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Actions } from './actions'
import type { Buddy } from './buddy'

export interface TrayTemplateDeps {
  actions: Pick<Actions, 'getState' | 'wake' | 'sleep'>
  buddy: Pick<Buddy, 'getState'>
  overlay: Pick<BrowserWindow, 'showInactive' | 'hide'>
  hologram: Pick<BrowserWindow, 'show' | 'hide' | 'focus'>
  placeHologram: () => void
  quit: () => void
}

export function buildTrayTemplate(d: TrayTemplateDeps): MenuItemConstructorOptions[] {
  const asleep = d.buddy.getState().asleep
  return [
    { label: 'Show', click: () => {
      d.overlay.showInactive()
      if (d.actions.getState().panelOpen) { d.placeHologram(); d.hologram.show(); d.hologram.focus() }
    } },
    { label: 'Hide', click: () => { d.hologram.hide(); d.overlay.hide() } },
    { label: asleep ? 'Wake' : 'Sleep', click: () => (asleep ? d.actions.wake() : d.actions.sleep()) },
    { type: 'separator' },
    { label: 'Quit', click: d.quit },
  ]
}

export function createTray(d: { packDir: string; name: string; actions: Actions; buddy: Buddy; overlay: BrowserWindow; hologram: BrowserWindow; placeHologram: () => void }): Tray {
  const iconPath = join(d.packDir, 'tray.png')
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  const tray = new Tray(icon)
  tray.setToolTip(d.name)
  const rebuild = () => {
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate({
      actions: d.actions, buddy: d.buddy, overlay: d.overlay, hologram: d.hologram,
      placeHologram: d.placeHologram, quit: () => app.quit(),
    })))
  }
  rebuild()
  d.buddy.onChange(rebuild)
  return tray
}
