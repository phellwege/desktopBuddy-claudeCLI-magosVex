import { app, Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Actions } from './actions'
import type { Buddy } from './buddy'

export function createTray(d: { packDir: string; name: string; actions: Actions; buddy: Buddy; overlay: BrowserWindow; hologram: BrowserWindow }): Tray {
  const iconPath = join(d.packDir, 'tray.png')
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  const tray = new Tray(icon)
  tray.setToolTip(d.name)
  const rebuild = () => {
    const asleep = d.buddy.getState().asleep
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show', click: () => d.overlay.showInactive() },
      { label: 'Hide', click: () => { d.hologram.hide(); d.overlay.hide() } },
      { label: asleep ? 'Wake' : 'Sleep', click: () => (asleep ? d.actions.wake() : d.actions.sleep()) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]))
  }
  rebuild()
  d.buddy.onChange(rebuild)
  return tray
}
