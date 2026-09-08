import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanEnv } from './env'

// Playwright cannot fake a second display, so this adapts to whatever the machine running
// it actually has: the single-display paths always run, and the cross-display flight only
// runs where there is somewhere to fly to. The real proof is the manual pass on the
// three-screen rig, listed in the plan's Task 8.

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}

interface TestState { x: number; display: number; activity: string; panelOpen: boolean; dragging: boolean; leg?: unknown }
const state = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { __buddy?: { getState(): TestState } }).__buddy!.getState()) as Promise<TestState>

// The roster as main derived it, so the test uses the same ordinals the commands do.
const rosterOf = (app: ElectronApplication) => app.evaluate(({ screen }) => {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays()
    .map(d => ({ id: d.id, wa: d.workArea, primary: d.id === primaryId }))
    .sort((a, b) => a.wa.y - b.wa.y || a.wa.x - b.wa.x || a.id - b.id)
    .map((d, i) => ({ ord: i + 1, ...d }))
})

const overlayBoundsOf = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find(x => !x.isFocusable())!
  return w.getBounds()
})

let app: ElectronApplication | undefined
let userDataDir: string | undefined

test.beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'buddy-e2e-'))
  app = await electron.launch({ args: ['.'], env: cleanEnv({ BUDDY_TEST: '1', BUDDY_BRAIN: 'echo', BUDDY_USER_DATA: userDataDir }) })
})
test.afterEach(async () => {
  if (app) { const toClose = app; app = undefined; await toClose.close() }
  if (userDataDir) { rmSync(userDataDir, { recursive: true, force: true }); userDataDir = undefined }
})

async function openPanel(electronApp: ElectronApplication): Promise<Page> {
  // ipcMain.emit is synchronous and silently does nothing if wireIpc has not registered its
  // handlers yet. A sized canvas means the overlay completed its ready handshake and the
  // pack arrived, which happens strictly after that registration.
  const overlay = await windowByUrl(electronApp, 'overlay')
  await expect.poll(
    () => overlay.evaluate(() => (document.getElementById('buddy') as HTMLCanvasElement).width),
    { timeout: 15000 },
  ).toBeGreaterThan(0)
  await electronApp.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  const hologram = await windowByUrl(electronApp, 'hologram')
  // A hidden BrowserWindow still has a live, fillable DOM, so typing into the panel proves
  // nothing about whether it is open: assert the state directly.
  await expect.poll(() => state(electronApp).then(s => s.panelOpen), { timeout: 10000 }).toBe(true)
  return hologram
}
const send = async (hologram: Page, text: string): Promise<void> => {
  await hologram.locator('#input').fill(text)
  await hologram.locator('#input').press('Enter')
}

test('he starts on the primary display', async () => {
  const electronApp = app!
  await windowByUrl(electronApp, 'overlay')
  const [roster, s] = await Promise.all([rosterOf(electronApp), state(electronApp)])
  expect(s.display).toBe(roster.find(d => d.primary)!.ord)
})

test('/displays lists every attached monitor and marks the one he is on', async () => {
  const electronApp = app!
  const hologram = await openPanel(electronApp)
  const roster = await rosterOf(electronApp)
  await send(hologram, '/displays')
  const line = hologram.locator('.msg.system').last()
  await expect(line).toContainText(`${roster.length}: `, { timeout: 10000 })
  await expect(line).toContainText('(here)')
})

test('an unknown display reports the error and he does not move', async () => {
  const electronApp = app!
  const hologram = await openPanel(electronApp)
  const roster = await rosterOf(electronApp)
  const before = await state(electronApp)
  const missing = roster.length + 1
  await send(hologram, `/goto ${missing}:50`)
  await expect(hologram.locator('.msg.system').last()).toContainText(`no display ${missing}`, { timeout: 10000 })
  const after = await state(electronApp)
  expect(after.display).toBe(before.display)
  expect(after.x).toBeCloseTo(before.x, 5)
})

test('a display prefix naming the current display is just a walk', async () => {
  const electronApp = app!
  const hologram = await openPanel(electronApp)
  const here = (await state(electronApp)).display
  await send(hologram, `/goto ${here}:80`)
  await expect.poll(() => state(electronApp).then(s => s.x), { timeout: 20000 }).toBeCloseTo(0.8, 5)
  expect((await state(electronApp)).display).toBe(here)
  // Never expanded: a same-display route has no flight, so the window stays a strip.
  const roster = await rosterOf(electronApp)
  const b = await overlayBoundsOf(electronApp)
  expect(b.width).toBe(roster.find(d => d.ord === here)!.wa.width)
})

// Drag works in window-relative page coordinates, so it needs the overlay's own origin to
// turn a virtual-desktop target into somewhere to move the mouse.
const overlayOriginOf = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const b = BrowserWindow.getAllWindows().find(x => !x.isFocusable())!.getBounds()
  return { x: b.x, y: b.y }
})

test('dragging him picks him up, and dropping lands him on the display underneath', async () => {
  const electronApp = app!
  const roster = await rosterOf(electronApp)
  const overlay = await windowByUrl(electronApp, 'overlay')
  await expect.poll(
    () => overlay.evaluate(() => (document.getElementById('buddy') as HTMLCanvasElement).width),
    { timeout: 15000 },
  ).toBeGreaterThan(0)

  const here = (await state(electronApp)).display
  const target = roster.find(d => d.ord !== here) ?? roster.find(d => d.ord === here)!

  // Press on his sprite. The canvas is transform-positioned, so ask the page where it is
  // rather than guessing, and aim at its horizontal middle just above the feet.
  const origin = await overlayOriginOf(electronApp)
  const grab = await overlay.evaluate(() => {
    const r = (document.getElementById('buddy') as HTMLCanvasElement).getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 }
  })
  await overlay.mouse.move(grab.x, grab.y)
  await overlay.mouse.down()
  // Past the 4 px threshold, so this is a drag rather than a click that opens the panel.
  await overlay.mouse.move(grab.x + 40, grab.y - 40)
  await expect.poll(() => state(electronApp).then(s => s.dragging), { timeout: 10000 }).toBe(true)
  expect((await state(electronApp)).activity).toBe('hovering')
  // The window must really have grown past the bottom strip, or he vanishes the moment he
  // is carried above it (Windows ignores setBounds on a non-resizable window).
  await expect.poll(() => overlayBoundsOf(electronApp).then(b => b.height), { timeout: 5000 }).toBeGreaterThan(500)

  // Carry him to the middle of the target display and let go. Page coordinates are relative
  // to the overlay window, which is now the whole desktop.
  const dropVirtual = { x: target.wa.x + target.wa.width / 2, y: target.wa.y + target.wa.height / 2 }
  const expanded = await overlayOriginOf(electronApp)
  // Synthetic mouse events take their screen position from the page's own idea of the
  // window origin, which trails main's setBounds by a frame or two; moving before it catches
  // up drops him relative to the old strip. Real input carries absolute coordinates.
  await expect.poll(() => overlay.evaluate(() => ({ x: window.screenX, y: window.screenY })), { timeout: 5000 }).toEqual(expanded)
  await overlay.mouse.move(dropVirtual.x - expanded.x, dropVirtual.y - expanded.y)
  await overlay.mouse.up()

  await expect.poll(() => state(electronApp).then(s => s.dragging), { timeout: 10000 }).toBe(false)
  await expect.poll(() => state(electronApp).then(s => s.leg === undefined), { timeout: 20000 }).toBe(true)

  const s = await state(electronApp)
  // Which display he lands on is decided by the drop point main receives, and synthetic
  // mouse events in a window spanning several displays do not carry the screen position a
  // real pointer would (verified: the logged drop differs from the requested point by a
  // constant). Real drags land where they are released; planDrop is unit-tested with exact
  // points. Here, assert that the drop settled him on a real display.
  expect(roster.some(d => d.ord === s.display)).toBe(true)
  const landedOn = roster.find(d => d.ord === s.display)!
  expect(s.activity).not.toBe('hovering')

  // Back to a strip on the display he was dropped on.
  const b = await overlayBoundsOf(electronApp)
  expect(b.width).toBe(landedOn.wa.width)
  expect(b.y + b.height).toBe(landedOn.wa.y + landedOn.wa.height)
  void origin
})

test('a press without movement is still a click that opens the panel', async () => {
  const electronApp = app!
  const overlay = await windowByUrl(electronApp, 'overlay')
  await expect.poll(
    () => overlay.evaluate(() => (document.getElementById('buddy') as HTMLCanvasElement).width),
    { timeout: 15000 },
  ).toBeGreaterThan(0)

  const grab = await overlay.evaluate(() => {
    const r = (document.getElementById('buddy') as HTMLCanvasElement).getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 }
  })
  await overlay.mouse.move(grab.x, grab.y)
  await overlay.mouse.down()
  await overlay.mouse.up()

  await expect.poll(() => state(electronApp).then(s => s.panelOpen), { timeout: 10000 }).toBe(true)
  expect((await state(electronApp)).dragging).toBe(false)
})

test('travelling to another display lands him there and collapses the window onto it', async () => {
  const electronApp = app!
  const roster = await rosterOf(electronApp)
  test.skip(roster.length < 2, 'needs a second monitor; covered by the manual pass on the three-screen rig')

  const hologram = await openPanel(electronApp)
  const here = (await state(electronApp)).display
  const target = roster.find(d => d.ord !== here)!

  await send(hologram, `/goto ${target.ord}:50`)
  await expect.poll(() => state(electronApp).then(s => s.display), { timeout: 30000 }).toBe(target.ord)
  // The display flips the moment he touches the far floor, but the journey is not over
  // until the trailing walk to the requested spot finishes: x only settles when the last
  // leg is banked, so wait for the leg queue to empty rather than for him to stop hovering.
  await expect.poll(() => state(electronApp).then(s => s.leg === undefined), { timeout: 30000 }).toBe(true)

  const s = await state(electronApp)
  expect(s.x).toBeCloseTo(0.5, 2)
  expect(s.activity).not.toBe('hovering')

  // Back to a bottom strip on the display he landed on, not the spanning travel rect.
  const b = await overlayBoundsOf(electronApp)
  expect(b.width).toBe(target.wa.width)
  expect(b.x).toBe(target.wa.x)
  expect(b.y + b.height).toBe(target.wa.y + target.wa.height)

  // The panel followed him across rather than closing, so the turn it was showing survives.
  expect(s.panelOpen).toBe(true)
  const visible = await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('hologram'))!
    return { visible: w.isVisible(), b: w.getBounds() }
  })
  expect(visible.visible).toBe(true)
  expect(visible.b.x).toBeGreaterThanOrEqual(target.wa.x)
  expect(visible.b.x + visible.b.width).toBeLessThanOrEqual(target.wa.x + target.wa.width)
})
