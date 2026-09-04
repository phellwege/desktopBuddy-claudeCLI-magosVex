import { app, dialog, screen } from 'electron'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { loadConfig } from './config'
import { loadPack, pickLine } from './pack'
import { registerPackScheme, handlePackProtocol } from './protocol'
import { Buddy } from './buddy'
import { Actions, type ActionHost } from './actions'
import { createHologramWindow, createOverlayWindow, loadPage, rebound } from './windows'
import { hologramBounds } from './geometry'
import { wireIpc } from './ipc'
import { CH, type ChatActivityPayload, type ChatDonePayload, type ChatStatusPayload } from '../shared/ipc'
import { EchoBrain } from './brain/echo'
import { ChatController } from './chat'
import { saveConfig } from './config'
import { createTray } from './tray'
import { showContextMenu } from './menu'
import { appendLog } from './log'

async function main(): Promise<void> {
  await registerPackScheme()
  await app.whenReady()

  const configPath = join(app.getPath('userData'), 'config.json')
  const config = loadConfig(configPath)
  const logDir = join(app.getPath('userData'), 'logs')
  mkdirSync(logDir, { recursive: true })
  // Never exit from these: a crash handler's job is to record and keep the buddy running.
  process.on('uncaughtException', (err) => {
    appendLog(logDir, 'main', `uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  })
  process.on('unhandledRejection', (reason) => {
    appendLog(logDir, 'main', `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
  })
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
  if (process.env.BUDDY_TEST === '1') (globalThis as { __buddy?: Buddy }).__buddy = buddy

  const overlay = createOverlayWindow(charH)
  const hologram = createHologramWindow(() => { if (buddy.getState().panelOpen) actions.closePanel() })

  for (const [name, win] of [['overlay', overlay], ['hologram', hologram]] as const) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) appendLog(logDir, name, `${source}:${line} ${message}`)
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      appendLog(logDir, name, `gone: ${details.reason}`)
      loadPage(win, name)
    })
  }

  const placeHologram = () => hologram.setBounds(hologramBounds(screen.getPrimaryDisplay().workArea, buddy.getState().x, charW, charH))
  const out = {
    delta: (text: string) => hologram.webContents.send(CH.chatDelta, { text }),
    activity: (a: ChatActivityPayload) => hologram.webContents.send(CH.chatActivity, a),
    done: (d: ChatDonePayload) => hologram.webContents.send(CH.chatDone, d),
    system: (text: string) => hologram.webContents.send(CH.chatSystem, { text }),
    status: (s: ChatStatusPayload) => hologram.webContents.send(CH.chatStatus, s),
  }
  let greeted = false
  const host: ActionHost = {
    showPanel: () => {
      placeHologram(); hologram.show(); hologram.focus()
      if (!greeted) { greeted = true; out.system(pickLine(pack, 'greeting') ?? '') }
    },
    hidePanel: () => hologram.hide(),
    pushSystem: (text) => hologram.webContents.send(CH.chatSystem, { text }),
  }
  const actions = new Actions(buddy, host)

  const chat = new ChatController({
    brain: new EchoBrain(pack, actions), actions, pack, out,
    settings: { workspace: config.workspace, model: config.model, sessionId: null },
    onSettingsChange: (s) => { config.workspace = s.workspace; config.model = s.model; saveConfig(configPath, config) },
  })
  wireIpc({
    buddy, actions, overlay, hologram,
    packPayload: { atlasUrl: 'pack://app/' + pack.atlas.image, atlasJsonUrl: 'pack://app/atlas.json',
      animations: pack.animations, scale, name: pack.name },
    theme: { ...pack.theme, name: pack.name },
    chat, status: () => chat.status(),
    showContextMenu: (x, y) => showContextMenu({ actions, buddy, overlay }, x, y),
  })

  const tray = createTray({ packDir: pack.dir, name: pack.name, actions, buddy, overlay, hologram, placeHologram })
  void tray
  app.on('before-quit', () => { overlay.destroy(); hologram.destroy() })

  buddy.onChange((v) => {
    overlay.webContents.send(CH.buddyState, v)
    if (v.state.panelOpen && hologram.isVisible()) placeHologram()
  })
  setInterval(() => buddy.tick(Date.now()), 250)
  buddy.tick(Date.now())

  screen.on('display-metrics-changed', () => { rebound(overlay, charH); if (hologram.isVisible()) placeHologram() })
  app.on('window-all-closed', () => app.quit())
}

void main()
