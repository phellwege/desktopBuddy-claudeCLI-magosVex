import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}

let app: ElectronApplication | undefined

test.beforeEach(async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, BUDDY_TEST: '1' } })
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
  expect(geo.b.height).toBe(260)
  expect(geo.b.y + geo.b.height).toBe(geo.wa.y + geo.wa.height)

  await electronApp.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  const hologram = await windowByUrl(electronApp, 'hologram')
  await expect.poll(() => electronApp.evaluate(() => (globalThis as { __buddy?: { getState(): { panelOpen: boolean } } }).__buddy!.getState().panelOpen)).toBe(true)

  await hologram.locator('#input').fill('/goto 80')
  await hologram.locator('#input').press('Enter')
  await expect.poll(() => electronApp.evaluate(() => (globalThis as { __buddy?: { getState(): { x: number } } }).__buddy!.getState().x), { timeout: 15000 }).toBeCloseTo(0.8, 5)

  await hologram.locator('#input').fill('hello')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.buddy')).toContainText('hello', { timeout: 15000 })

  await hologram.locator('#input').press('Escape')
  await expect.poll(() => electronApp.evaluate(() => (globalThis as { __buddy?: { getState(): { panelOpen: boolean } } }).__buddy!.getState().panelOpen)).toBe(false)
})
