import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OVERLAY_HEIGHT } from '../src/main/geometry'

// Mirrors overlayBounds()'s own max(OVERLAY_HEIGHT, charH + 24) so this assertion tracks
// the pack's real atlas instead of hard-coding a height that only held for the old,
// always-260 window (which clipped this very pack's 326px-tall 2x frames).
const atlas = JSON.parse(readFileSync(join(__dirname, '../packs/mechanicus/atlas.json'), 'utf8')) as
  { maxFrameSize: [number, number]; frames: Record<string, { origin?: [number, number] }> }
const expectedOverlayHeight = Math.max(OVERLAY_HEIGHT, atlas.maxFrameSize[1] + 24)

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}

let app: ElectronApplication | undefined

test.beforeEach(async () => {
  // Pin the echo brain explicitly: this test's own "hello" reply assumes the echo brain's
  // behavior, and without this override the app falls back to it only when it cannot find a
  // real CLI at config.cliPath - on a machine where the real Claude Code CLI is installed at
  // the default path, this test would otherwise spawn it for real, spending quota.
  app = await electron.launch({ args: ['.'], env: { ...process.env, BUDDY_TEST: '1', BUDDY_BRAIN: 'echo' } })
})

test.afterEach(async () => {
  if (app) {
    const toClose = app
    app = undefined
    await toClose.close()
  }
})

test('overlay sits on the work area bottom, panel opens, /goto moves him, Escape closes', async () => {
  const electronApp = app!
  const overlay = await windowByUrl(electronApp, 'overlay')
  await expect(overlay.locator('#buddy')).toBeAttached()

  const geo = await electronApp.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find(x => !x.isFocusable())!
    return { b: w.getBounds(), wa: screen.getPrimaryDisplay().workArea }
  })
  expect(geo.b.width).toBe(geo.wa.width)
  expect(geo.b.height).toBe(expectedOverlayHeight)
  expect(geo.b.y + geo.b.height).toBe(geo.wa.y + geo.wa.height)

  expect(atlas.frames.idle_0?.origin).toBeDefined()

  await electronApp.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  const hologram = await windowByUrl(electronApp, 'hologram')
  await expect.poll(() => electronApp.evaluate(() => (globalThis as { __buddy?: { getState(): { panelOpen: boolean } } }).__buddy!.getState().panelOpen)).toBe(true)

  const hologramWinBounds = await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('hologram'))!
    return w.getBounds()
  })
  expect(hologramWinBounds.height).toBeGreaterThan(360)
  expect(hologramWinBounds.width).toBe(480 + 240)

  await hologram.locator('#input').fill('/goto 80')
  await hologram.locator('#input').press('Enter')
  await expect.poll(() => electronApp.evaluate(() => (globalThis as { __buddy?: { getState(): { x: number } } }).__buddy!.getState().x), { timeout: 15000 }).toBeCloseTo(0.8, 5)

  await hologram.locator('#input').fill('hello')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.buddy')).toContainText('hello', { timeout: 15000 })

  await hologram.locator('#input').press('Escape')
  await expect.poll(() => electronApp.evaluate(() => (globalThis as { __buddy?: { getState(): { panelOpen: boolean } } }).__buddy!.getState().panelOpen)).toBe(false)

  // Fix 1 regression: the hologram must not stay stuck fully-interactive from before it
  // hid (which would swallow clicks across the whole window until a stray mousemove reset
  // it) - a second click-to-open right after Escape must still succeed cleanly.
  await electronApp.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  await expect.poll(() => electronApp.evaluate(() => (globalThis as { __buddy?: { getState(): { panelOpen: boolean } } }).__buddy!.getState().panelOpen)).toBe(true)
  const reopenedVisible = await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('hologram'))!
    return w.isVisible()
  })
  expect(reopenedVisible).toBe(true)
})
