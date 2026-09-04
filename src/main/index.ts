import { app, dialog, screen } from 'electron'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { loadConfig } from './config'
import { loadPack, pickLine } from './pack'
import type { Expression } from '../shared/types'
import { registerPackScheme, handlePackProtocol } from './protocol'
import { Buddy } from './buddy'
import { Actions, type ActionHost } from './actions'
import { createHologramWindow, createOverlayWindow, loadPage, rebound, setHologramInteractive } from './windows'
import { hologramBounds, originToWindow } from './geometry'
import { wireIpc } from './ipc'
import { CH, type ChatActivityPayload, type ChatDonePayload, type ChatStatusPayload, type OriginPayload } from '../shared/ipc'
import { EchoBrain } from './brain/echo'
import { ChatController } from './chat'
import { saveConfig } from './config'
import { createTray } from './tray'
import { showContextMenu } from './menu'
import { appendLog } from './log'

// Computed at module scope (not inside main()) so the top-level .catch() below can log a
// bootstrap failure to the same file even if it throws before this point is reached.
const logDir = join(app.getPath('userData'), 'logs')

async function main(): Promise<void> {
  await registerPackScheme()
  await app.whenReady()

  const configPath = join(app.getPath('userData'), 'config.json')
  const config = loadConfig(configPath)
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
  appendLog(logDir, 'main', `pack ${packDir}: ${Object.keys(pack.atlas.frames).length} frames, scale ${scale}, character ${Math.round(charW)}x${Math.round(charH)}, overlay ${JSON.stringify(overlay.getBounds())}`)
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

  const originRef: { current: OriginPayload | null } = { current: null }
  // The x fraction the hologram was last placed at. During a commanded walk, Buddy.x only
  // updates on arrival, so the overlay's per-frame origin report carries the character's
  // live x (xFraction) instead - the ipc origin handler compares against this to decide
  // whether to re-place the hologram mid-walk rather than waiting for arrival.
  const lastPlacedX: { current: number } = { current: buddy.getState().x }
  const placeHologram = (xFraction?: number) => {
    const x = xFraction ?? buddy.getState().x
    lastPlacedX.current = x
    hologram.setBounds(hologramBounds(screen.getPrimaryDisplay().workArea, x, charW, charH))
    if (originRef.current) hologram.webContents.send(CH.hologramOrigin, originToWindow(originRef.current, hologram.getBounds()))
  }
  // A turn can end after the window is gone (quit mid-reply); sending to a destroyed
  // webContents throws, which surfaced as an unhandled rejection in the log.
  const toHologram = (channel: string, payload: unknown): void => {
    if (!hologram.isDestroyed()) hologram.webContents.send(channel, payload)
  }
  const out = {
    delta: (text: string) => toHologram(CH.chatDelta, { text }),
    activity: (a: ChatActivityPayload) => toHologram(CH.chatActivity, a),
    done: (d: ChatDonePayload) => toHologram(CH.chatDone, d),
    system: (text: string, expression: Expression = 'neutral') => toHologram(CH.chatSystem, { text, expression }),
    status: (s: ChatStatusPayload) => toHologram(CH.chatStatus, s),
  }
  let greeted = false
  const host: ActionHost = {
    showPanel: () => {
      // Every open starts click-through: if the panel last closed with the pointer still
      // over it, ignoreMouseEvents would otherwise still be false on this hidden window,
      // swallowing clicks across the whole hologram until a mousemove reset it.
      setHologramInteractive(hologram, false)
      placeHologram(); hologram.show(); hologram.focus()
      if (!greeted) { greeted = true; out.system(pickLine(pack, 'greeting') ?? '') }
    },
    hidePanel: () => { setHologramInteractive(hologram, false); hologram.hide() },
    pushSystem: (text) => out.system(text),
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
      animations: pack.animations, scale, name: pack.name, faces: pack.faces },
    theme: { ...pack.theme, name: pack.name },
    origin: originRef,
    placeHologram, lastPlacedX,
    chat, status: () => chat.status(),
    showContextMenu: (x, y) => showContextMenu({ actions, buddy, overlay }, x, y),
  })

  const tray = createTray({ packDir: pack.dir, name: pack.name, actions, buddy, overlay, hologram, placeHologram })
  void tray
  app.on('before-quit', () => { overlay.destroy(); hologram.destroy() })

  buddy.onChange((v) => {
    if (overlay.isDestroyed()) return
    overlay.webContents.send(CH.buddyState, v)
    if (v.state.panelOpen && hologram.isVisible()) placeHologram()
  })
  setInterval(() => buddy.tick(Date.now()), 250)
  buddy.tick(Date.now())

  screen.on('display-metrics-changed', () => { rebound(overlay, charH); if (hologram.isVisible()) placeHologram() })
  app.on('window-all-closed', () => app.quit())
}

// A throw here (including one after the pack has already loaded and windows may already
// exist) must not leave a windowless, invisible background process: log it, tell the
// user, and actually exit rather than silently sitting in the tray-less void.
main().catch((err) => {
  appendLog(logDir, 'main', `bootstrap failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  dialog.showErrorBox('Startup failed', String(err))
  app.exit(1)
})
