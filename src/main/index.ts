import { app, dialog, screen } from 'electron'
import { isAbsolute, join } from 'node:path'
import { loadConfig } from './config'
import { loadPack } from './pack'
import { registerPackScheme, handlePackProtocol } from './protocol'
import { Buddy } from './buddy'
import { Actions, type ActionHost } from './actions'
import { createHologramWindow, createOverlayWindow, rebound } from './windows'
import { hologramBounds } from './geometry'
import { wireIpc } from './ipc'
import { CH, type ChatStatusPayload } from '../shared/ipc'

async function main(): Promise<void> {
  await registerPackScheme()
  await app.whenReady()

  const config = loadConfig(join(app.getPath('userData'), 'config.json'))
  const packDir = isAbsolute(config.pack) ? config.pack : join(app.getAppPath(), config.pack)
  const loaded = loadPack(packDir)
  if (!loaded.ok) {
    dialog.showErrorBox('Persona pack failed to load', loaded.errors.join('\n'))
    app.quit(); return
  }
  const pack = loaded.pack
  await handlePackProtocol(pack.dir)

  const scale = pack.scale * config.scale
  const charW = pack.atlas.maxFrameSize[0] * scale
  const charH = pack.atlas.maxFrameSize[1] * scale
  const buddy = new Buddy({
    wanderIntervalMs: [config.wanderIntervalSec[0] * 1000, config.wanderIntervalSec[1] * 1000],
    sleepAfterMs: config.sleepAfterMin * 60000,
    initialMood: pack.persona.defaultMood,
  })

  const overlay = createOverlayWindow()
  const hologram = createHologramWindow(() => { if (buddy.getState().panelOpen) actions.closePanel() })

  const placeHologram = () => hologram.setBounds(hologramBounds(screen.getPrimaryDisplay().workArea, buddy.getState().x, charW, charH))
  const host: ActionHost = {
    showPanel: () => { placeHologram(); hologram.show(); hologram.focus() },
    hidePanel: () => hologram.hide(),
    pushSystem: (text) => hologram.webContents.send(CH.chatSystem, { text }),
  }
  const actions = new Actions(buddy, host)

  const status = (): ChatStatusPayload => ({ model: config.model, workspace: config.workspace, session: 'new' })
  wireIpc({
    buddy, actions, overlay, hologram,
    packPayload: { atlasUrl: 'pack://app/' + pack.atlas.image, atlasJsonUrl: 'pack://app/atlas.json',
      animations: pack.animations, scale, name: pack.name },
    theme: { ...pack.theme, name: pack.name },
    chat: { prompt: () => {}, permissionAnswer: () => {}, stop: () => {} },   // replaced in Task 10
    status,
    showContextMenu: () => {},                                                  // replaced in Task 11
  })

  buddy.onChange((v) => {
    overlay.webContents.send(CH.buddyState, v)
    if (v.state.panelOpen && hologram.isVisible()) placeHologram()
  })
  setInterval(() => buddy.tick(Date.now()), 250)
  buddy.tick(Date.now())

  screen.on('display-metrics-changed', () => { rebound(overlay); if (hologram.isVisible()) placeHologram() })
  app.on('window-all-closed', () => app.quit())
}

void main()
