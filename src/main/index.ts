import { app, dialog, screen } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expandEnv, loadConfig, saveConfig } from './config'
import { loadState, saveState, sessionTranscriptExists } from './state'
import { loadPack, pickLine } from './pack'
import type { Expression, Mood } from '../shared/types'
import { registerPackScheme, handlePackProtocol } from './protocol'
import { Buddy } from './buddy'
import { Actions, type ActionHost } from './actions'
import { createHologramWindow, createOverlayWindow, expandForFlight, loadPage, rebound, setHologramInteractive, setOverlayDragging } from './windows'
import { hologramBounds, originToWindow } from './geometry'
import { byOrd, desktopBounds, floorY, fromFraction, planDrop, planTravel, primaryOf, roster, routeDurationMs, walkBand, type DisplayInfo } from './displays'
import { wireIpc, type ImagePort } from './ipc'
import { SessionAllows } from './permissions'
import { CH, type ChatActivityPayload, type ChatDonePayload, type ChatPermissionPayload, type ChatReadbackPayload, type ChatStatusPayload, type OriginPayload, type OverlayMutterPayload, type StagePayload, type StageResult } from '../shared/ipc'
import { AttachmentStore, loadImagePath, nodeImageFs, normalizeImage, type NormalizeResult } from './images'
import { electronCodec } from './images-electron'
import { EchoBrain } from './brain/echo'
import { childEnv, ClaudeCliBrain } from './brain/claude-cli'
import { Readback } from './brain/readback'
import type { Brain } from './brain/types'
import { ChatController } from './chat'
import { Handoff } from './handoff'
import { startLocalServer, type PermissionRequest } from './server'
import { createTray } from './tray'
import { showContextMenu } from './menu'
import { appendLog } from './log'

// Test hook: an isolated profile (config, state, logs, renderer local storage) so specs
// never read or write the real one.
if (process.env.BUDDY_USER_DATA) app.setPath('userData', process.env.BUDDY_USER_DATA)

// Computed at module scope (not inside main()) so the top-level .catch() below can log a
// bootstrap failure to the same file even if it throws before this point is reached.
const logDir = join(app.getPath('userData'), 'logs')

async function main(): Promise<void> {
  await registerPackScheme()
  await app.whenReady()

  const configPath = join(app.getPath('userData'), 'config.json')
  const config = loadConfig(configPath)
  mkdirSync(logDir, { recursive: true })
  // Session persistence (separate file from config.json on purpose: state.json is
  // machine-written bookkeeping, not a setting the user edits). Resume the remembered session
  // only if it still belongs to the current workspace and its transcript is actually still on
  // disk - otherwise a relaunch just starts fresh, same as before this existed.
  const statePath = join(app.getPath('userData'), 'state.json')
  const savedState = loadState(statePath)
  let resumeSessionId: string | null = null
  if (savedState && savedState.sessionId && savedState.workspace === config.workspace
    && sessionTranscriptExists(homedir(), config.workspace, savedState.sessionId)) {
    resumeSessionId = savedState.sessionId
    appendLog(logDir, 'main', `resuming session ${resumeSessionId}`)
  }
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
  // The display roster, re-derived whenever the arrangement changes. He starts on the
  // primary and only leaves it on a command; wandering never crosses displays.
  let displays = roster(screen.getAllDisplays().map(d => ({ id: d.id, workArea: d.workArea, primary: d.id === screen.getPrimaryDisplay().id })))
  let current: DisplayInfo = primaryOf(displays)
  const RUN_THRESHOLD = 0.25

  // Test hook: overrides the mutter interval in milliseconds directly, like BUDDY_READBACK
  // overrides readback - a config override is not available to the e2e harness. The same
  // hook shortens the bubble's time-to-live too, or an e2e spec waiting on a real 7s ttl
  // between mutters (the interval is set well under that for the test) would never see it
  // actually hide before the next one replaces it.
  const mutterTestMode = process.env.BUDDY_MUTTER_MS !== undefined
  const mutterIntervalMs = mutterTestMode ? Number(process.env.BUDDY_MUTTER_MS) : config.mutterIntervalMin * 60000
  const mutterTtlMs = mutterTestMode ? 1000 : 7000

  const buddy = new Buddy({
    wanderIntervalMs: [config.wanderIntervalSec[0] * 1000, config.wanderIntervalSec[1] * 1000],
    sleepAfterMs: config.sleepAfterMin * 60000,
    mutterIntervalMs,
    initialMood: pack.persona.defaultMood,
    initialDisplay: current.ord,
  })
  if (process.env.BUDDY_TEST === '1') (globalThis as { __buddy?: Buddy }).__buddy = buddy

  const overlay = createOverlayWindow(current.wa, charH)
  appendLog(logDir, 'main', `pack ${packDir}: ${Object.keys(pack.atlas.frames).length} frames, scale ${scale}, character ${Math.round(charW)}x${Math.round(charH)}, overlay ${JSON.stringify(overlay.getBounds())}`)
  // True from the first leg of a journey until the last one lands. Load-bearing for the
  // blur handler below: the panel is hidden for the trip, and hiding a focused window
  // blurs it, which would otherwise close the very panel we mean to restore on the far
  // display (and discard a turn that is still streaming into it).
  let journeying = false
  const hologram = createHologramWindow(() => {
    if (!journeying && buddy.getState().panelOpen) actions.closePanel()
  })

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
    hologram.setBounds(hologramBounds(current.wa, x, charW, charH))
    if (originRef.current) hologram.webContents.send(CH.hologramOrigin, originToWindow(originRef.current, hologram.getBounds()))
  }
  // Tells the overlay where its window sits and which display's floor he rests on. Sent on
  // startup, at both ends of a flight, and whenever the display arrangement changes.
  const sendStage = (): void => {
    if (overlay.isDestroyed()) return
    const b = overlay.getBounds()
    overlay.webContents.send(CH.overlayStage, { origin: { x: b.x, y: b.y }, wa: current.wa, charW } satisfies StagePayload)
  }
  // A turn can end after the window is gone (quit mid-reply); sending to a destroyed
  // webContents throws, which surfaced as an unhandled rejection in the log.
  const toHologram = (channel: string, payload?: unknown): void => {
    if (!hologram.isDestroyed()) hologram.webContents.send(channel, payload)
  }
  // Same guard for the overlay: a mutter can fire after it is gone (quit while idle).
  const toOverlay = (channel: string, payload?: unknown): void => {
    if (!overlay.isDestroyed()) overlay.webContents.send(channel, payload)
  }
  // Attachments staged in the panel and not yet sent (spec 5). Cleared with the panel.
  const store = new AttachmentStore()
  const out = {
    delta: (text: string) => toHologram(CH.chatDelta, { text }),
    activity: (a: ChatActivityPayload) => toHologram(CH.chatActivity, a),
    done: (d: ChatDonePayload) => toHologram(CH.chatDone, d),
    system: (text: string, expression: Expression = 'neutral') => toHologram(CH.chatSystem, { text, expression }),
    status: (s: ChatStatusPayload) => toHologram(CH.chatStatus, s),
    readback: (p: ChatReadbackPayload) => toHologram(CH.chatReadback, p),
    clear: () => { store.clear(); toHologram(CH.chatClear) },
  }
  let greeted = false
  const host: ActionHost = {
    showPanel: () => {
      // Every open starts click-through: if the panel last closed with the pointer still
      // over it, ignoreMouseEvents would otherwise still be false on this hidden window,
      // swallowing clicks across the whole hologram until a mousemove reset it.
      setHologramInteractive(hologram, false)
      placeHologram(); hologram.show(); hologram.focus()
      if (!greeted) {
        greeted = true
        out.system(pickLine(pack, 'greeting') ?? '')
        if (resumeSessionId) out.system(`resumed session ${resumeSessionId.slice(0, 8)}`)
      }
    },
    hidePanel: () => { setHologramInteractive(hologram, false); hologram.hide() },
    pushSystem: (text) => out.system(text),
    log: (line) => appendLog(logDir, 'main', line),
    bandWidth: () => { const b = walkBand(current.wa, charW); return Math.max(1, b.max - b.min) },
    displays: () => displays.map(d => ({
      ord: d.ord, width: d.wa.width, height: d.wa.height, primary: d.primary, current: d.ord === current.ord,
    })),
    planTravel: (display, xFraction, run) => {
      const to = byOrd(displays, display) ?? current
      const legs = planTravel({
        from: current, to, charW, runThreshold: RUN_THRESHOLD, run,
        startVX: fromFraction(buddy.getState().x, current.wa, charW),
        landFraction: xFraction,
      })
      const start = { x: fromFraction(buddy.getState().x, current.wa, charW), y: floorY(current.wa) }
      return { legs, estimatedMs: routeDurationMs(legs, start) }
    },
    // Grow the overlay to span source and target before the first leg moves, and step the
    // panel aside for the trip. The panel is hidden rather than closed: the brain calls
    // go_to mid-reply, and closing would discard a turn that is still streaming.
    beginFlight: (legs) => {
      const targetOrd = legs[legs.length - 1]?.display ?? current.ord
      const to = byOrd(displays, targetOrd) ?? current
      journeying = true
      expandForFlight(overlay, current.wa, to.wa)
      sendStage()
      if (buddy.getState().panelOpen) hologram.hide()
      appendLog(logDir, 'main', `travel: display ${current.ord} -> ${targetOrd}, ${legs.length} legs`)
    },
  }
  const actions = new Actions(buddy, host)

  const cliPath = expandEnv(process.env.BUDDY_CLI_PATH ?? config.cliPath)
  // Test hook: a JSON array of argv placed before the CLI flags, so a script interpreter can
  // stand in for claude.exe (BUDDY_CLI_PATH=node.exe BUDDY_CLI_ARGS='["test/fake-claude.cjs"]').
  const argsPrefix = parseArgsPrefix(process.env.BUDDY_CLI_ARGS)
  const cliMissing = !existsSync(cliPath)
  const useEcho = process.env.BUDDY_BRAIN === 'echo' || cliMissing

  // The terminal hand-off (/cli, and the menu item). Under the echo brain there is no CLI
  // to hand to, so /cli posts the cliMissing line; the e2e suite substitutes a short-lived
  // process through BUDDY_HANDOFF_CMD and never opens a console.
  const handoffCmd = parseArgsPrefix(process.env.BUDDY_HANDOFF_CMD)
  const handoff = handoffCmd.length > 0 ? new Handoff({ cliPath, command: handoffCmd }) : (!useEcho ? new Handoff({ cliPath }) : undefined)

  // BUDDY_READBACK=0 is a test override, like BUDDY_BRAIN=echo.
  const readbackEnabled = config.readback && process.env.BUDDY_READBACK !== '0' && !useEcho
  const readback = readbackEnabled ? new Readback({
    cliPath, persona: pack.persona.prompt, scratchDir: join(app.getPath('userData'), 'readback'), argsPrefix,
  }) : undefined
  appendLog(logDir, 'main', `readback ${readbackEnabled ? 'on' : 'off'}`)

  // Both callbacks below are handed to startLocalServer before the ChatController that owns
  // their real logic exists yet (the brain needs the server, and the controller needs the
  // brain): they close over this ref instead, filled in once the controller is built.
  let chatRef: ChatController | undefined
  // "Allow this session" (spec 6.4.1): tool names answered allowed-and-remembered here are
  // granted on every later request without a card. Cleared on /new and /cd, and (implicitly)
  // on app exit since the whole process instance goes away.
  const sessionAllows = new SessionAllows()
  const showPermission = async (req: PermissionRequest): Promise<{ allow: boolean; reason: string }> => {
    // Expired while waiting its turn: the server already answered deny on the wire.
    if (expiredPermissions.delete(req.id)) return { allow: false, reason: 'timed out' }
    if (sessionAllows.allows(req.toolName)) return { allow: true, reason: 'allowed for this session' }
    actions.openPanel()
    const line = pickLine(pack, 'permissionAsk') ?? `Allow ${req.toolName}?`
    out.system(line, 'begging')
    const payload: ChatPermissionPayload = { id: req.id, toolName: req.toolName, summary: req.summary, line }
    toHologram(CH.chatPermission, payload)
    const decision = await chatRef!.awaitPermissionAnswer(req.id)
    if (decision.allow && decision.remember) sessionAllows.remember(req.toolName)
    return decision
  }
  // Cards show one at a time. The renderer has a single card slot, so a second request that
  // arrives while one is up (parallel tool calls) waits for the first answer or its expiry
  // instead of overwriting the card; the server's own timeout still bounds each request.
  const expiredPermissions = new Set<string>()
  let permissionQueue: Promise<unknown> = Promise.resolve()
  const onPermission = (req: PermissionRequest): Promise<{ allow: boolean; reason: string }> => {
    const result = permissionQueue.then(() => showPermission(req))
    permissionQueue = result.catch(() => undefined)
    return result
  }
  // The server's own permission timeout already answered "deny" on the wire by the time this
  // fires; the pending resolver in ChatController and the card still showing in the renderer
  // are both now stale and would otherwise linger forever (permissionAnswer() is the only
  // other thing that clears either, and nobody is going to click a card the user never saw
  // answer in time).
  const onPermissionTimeout = (id: string): void => {
    expiredPermissions.add(id)
    chatRef?.expirePermission(id)
    toHologram(CH.chatPermission, { id, dismiss: true } satisfies ChatPermissionPayload)
    out.system(pickLine(pack, 'permissionDenied') ?? 'Denied: timed out waiting for a decision.')
  }
  // The first tool activity of a turn forces mood to "thinking"; on the way out the brain
  // asks to restore it, but only if nothing else (a set_mood tool call) changed it meanwhile.
  let moodBeforeThinking: Mood | null = null
  const onMood = (m: Mood | 'restore'): void => {
    if (m === 'restore') {
      if (moodBeforeThinking !== null && actions.getState().mood === 'thinking') actions.setMood(moodBeforeThinking)
      moodBeforeThinking = null
      return
    }
    moodBeforeThinking = actions.getState().mood
    actions.setMood(m)
  }

  const server = await startLocalServer({
    actions,
    setExpression: (name) => chatRef?.setExpression(name),
    onPermission,
    onPermissionTimeout,
    permissionTimeoutMs: config.permissionTimeoutSec * 1000,
  })
  // Quitting mid-turn must not orphan a running claude.exe: chatRef is still undefined only
  // during the brief startup window before the ChatController below is constructed, hence
  // the guard (by the time a real quit happens, it is always set).
  app.on('before-quit', () => { chatRef?.stop(); handoff?.stop(); readback?.stopAll(); void server.close() })

  const brain: Brain = useEcho ? new EchoBrain(pack, actions) : new ClaudeCliBrain({
    cliPath, argsPrefix, workspace: config.workspace, extraDirs: config.extraDirs, model: config.model,
    allowedTools: config.allowedTools, permissionMode: config.permissionMode, server,
    lines: { authError: pack.persona.lines.authError, cliMissing: pack.persona.lines.cliMissing, error: pack.persona.lines.error },
    onMood,
  })

  const chat = new ChatController({
    brain, actions, pack, out,
    settings: { workspace: config.workspace, model: config.model, sessionId: resumeSessionId },
    onSettingsChange: (s) => {
      config.workspace = s.workspace; config.model = s.model; saveConfig(configPath, config)
      saveState(statePath, { sessionId: s.sessionId, workspace: s.workspace })
      // A null session id means a fresh CLI session is starting (/new, /cd, or /clear before
      // any turn has run yet): the allow-list belongs to the session that is ending, not the
      // one about to start.
      if (s.sessionId === null) sessionAllows.clear()
    },
    readback, handoff, log: (line) => appendLog(logDir, 'main', line),
  })
  chatRef = chat

  // The panel's chips: normalize with the real codec, stage, and answer with the chip or the
  // reason. A pasted path resolves against the workspace the chat controller holds now.
  const stageResult = (r: NormalizeResult): StageResult => {
    if (!r.ok) return { error: r.reason }
    const staged = store.stage(r.attachment)
    return staged.ok ? r.staged : { error: staged.reason }
  }
  const images: ImagePort = {
    stageBytes: (p) => stageResult(normalizeImage({
      bytes: Buffer.from(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength), mediaType: p.mediaType, name: p.name,
    }, electronCodec)),
    stagePath: (p) => stageResult(loadImagePath(p.path, chat.status().workspace, nodeImageFs, electronCodec)),
    discard: (id) => store.discard(id),
    take: (ids) => store.take(ids),
    clear: () => store.clear(),
  }

  // Runs `<cli> auth status` once, five seconds to answer, and never blocks startup on it:
  // its only effect is one line appended to the status row once (or never) it resolves.
  function checkCliAuth(path: string): void {
    try {
      const child = spawn(path, ['auth', 'status'], { stdio: ['ignore', 'pipe', 'ignore'], env: childEnv(process.env) })
      let buf = ''
      const timer = setTimeout(() => child.kill(), 5000)
      child.stdout?.on('data', (c: Buffer) => { buf += c.toString('utf8') })
      child.on('close', () => {
        clearTimeout(timer)
        let statusLine: string | undefined
        try {
          const parsed = JSON.parse(buf) as { loggedIn?: unknown }
          statusLine = typeof parsed.loggedIn === 'boolean' ? (parsed.loggedIn ? 'cli: logged in' : 'cli: not logged in') : rawCliStatusLine(buf)
        } catch { statusLine = rawCliStatusLine(buf) }
        if (statusLine) out.status({ ...chat.status(), error: statusLine })
      })
      child.on('error', () => clearTimeout(timer))
    } catch { /* best effort only */ }
  }
  if (process.env.BUDDY_BRAIN === 'echo') out.system('echo brain (BUDDY_BRAIN=echo)')
  else if (cliMissing) out.system(`echo brain (cli not found at ${cliPath})`)
  else checkCliAuth(cliPath)

  // Picking him up is the same shape as a commanded flight: the window has to cover
  // everywhere he might be carried before he moves, and the panel steps aside rather than
  // closing. The difference is that there is no route, so nothing lands until he is dropped.
  const beginDrag = (): void => {
    journeying = true
    overlay.setBounds(desktopBounds(displays))
    setOverlayDragging(overlay, true)
    sendStage()
    if (buddy.getState().panelOpen) hologram.hide()
    buddy.beginDrag()
    appendLog(logDir, 'main', `drag: picked up on display ${current.ord}`)
  }
  const endDrag = (drop: { x: number; y: number }): void => {
    if (!buddy.getState().dragging) return
    setOverlayDragging(overlay, false)
    const landing = planDrop(displays, drop, charW)
    appendLog(logDir, 'main', `drag: dropped at ${Math.round(drop.x)},${Math.round(drop.y)} -> display ${landing.display}`)
    // Straight down onto that display's floor. The journey-end path then collapses the
    // window back to a strip and brings the panel back, exactly as a commanded trip does.
    buddy.endDrag(landing)
  }

  wireIpc({
    buddy, actions, overlay, hologram,
    beginDrag, endDrag,
    packPayload: { atlasUrl: 'pack://app/' + pack.atlas.image, atlasJsonUrl: 'pack://app/atlas.json',
      animations: pack.animations, scale, name: pack.name, faces: pack.faces },
    theme: { ...pack.theme, name: pack.name },
    origin: originRef,
    placeHologram, lastPlacedX,
    sendStage,
    chat, status: () => chat.status(),
    images,
    showContextMenu: (x, y) => showContextMenu({ actions, buddy, overlay, openCli: () => { actions.openPanel(); chat.openCli() } }, x, y),
  })

  const tray = createTray({ packDir: pack.dir, name: pack.name, actions, buddy, overlay, hologram, placeHologram })
  void tray
  app.on('before-quit', () => { overlay.destroy(); hologram.destroy() })

  buddy.onChange((v) => {
    if (overlay.isDestroyed()) return
    // A body being carried by the pointer is mid-journey too: it has no leg yet (the drop
    // plans one), and treating that as "landed" collapsed the window back to the strip the
    // instant a drag began, which is why he vanished above it.
    const inJourney = v.state.leg !== undefined || v.state.dragging
    if (journeying && !inJourney) {
      // Landed: settle onto the new display and shrink the window back to a strip. Both
      // happen before the state message so the renderer never sees a stale window origin.
      journeying = false
      current = byOrd(displays, v.state.display) ?? current
      rebound(overlay, current.wa, charH)
      sendStage()
      if (v.state.panelOpen) {
        // Same reset as a fresh open: a window that was hidden with the pointer over it
        // would otherwise come back still fully interactive and swallow clicks.
        setHologramInteractive(hologram, false)
        placeHologram()
        hologram.show()
      }
    } else if (inJourney) {
      journeying = true
    }
    overlay.webContents.send(CH.buddyState, v)
    if (v.state.panelOpen && hologram.isVisible()) placeHologram()
  })
  buddy.onMutter(() => {
    const line = pickLine(pack, 'idleMutter')
    if (line) {
      toOverlay(CH.overlayMutter, { text: line, ttlMs: mutterTtlMs } satisfies OverlayMutterPayload)
      appendLog(logDir, 'main', `mutter: ${line.slice(0, 40)}`)
    }
  })
  setInterval(() => buddy.tick(Date.now()), 250)
  buddy.tick(Date.now())

  // Any change to the arrangement re-derives the roster, since ordinals are positional. If
  // the display he was standing on is gone (unplugged mid-flight or not), fall back to the
  // primary rather than leaving the overlay bound to a rectangle that no longer exists.
  const onDisplaysChanged = (): void => {
    displays = roster(screen.getAllDisplays().map(d => ({ id: d.id, workArea: d.workArea, primary: d.id === screen.getPrimaryDisplay().id })))
    const stillThere = displays.find(d => d.id === current.id)
    if (!stillThere) appendLog(logDir, 'main', `display ${current.id} is gone, falling back to the primary`)
    current = stillThere ?? primaryOf(displays)
    journeying = false
    rebound(overlay, current.wa, charH)
    sendStage()
    if (hologram.isVisible()) placeHologram()
  }
  // Listed one by one: Electron types screen.on per event name, so a union does not fit.
  screen.on('display-metrics-changed', onDisplaysChanged)
  screen.on('display-added', onDisplaysChanged)
  screen.on('display-removed', onDisplaysChanged)
  app.on('window-all-closed', () => app.quit())
}

// `claude auth status` is only guaranteed to print JSON on success; a CLI version mismatch,
// an unexpected prompt, or any other unforeseen output would otherwise vanish silently. Show
// something rather than nothing: the first line, trimmed, capped well under the status row's
// width.
function rawCliStatusLine(buf: string): string | undefined {
  const firstLine = buf.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) return undefined
  return firstLine.length > 120 ? firstLine.slice(0, 120) : firstLine
}

function parseArgsPrefix(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((a): a is string => typeof a === 'string') ? parsed : []
  } catch { return [] }
}

// A throw here (including one after the pack has already loaded and windows may already
// exist) must not leave a windowless, invisible background process: log it, tell the
// user, and actually exit rather than silently sitting in the tray-less void.
main().catch((err) => {
  appendLog(logDir, 'main', `bootstrap failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  dialog.showErrorBox('Startup failed', String(err))
  app.exit(1)
})
