import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { cleanEnv } from './env'

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}

let app: ElectronApplication | undefined

test.afterEach(async () => {
  if (app) {
    const toClose = app
    app = undefined
    await toClose.close()
  }
})

test('an idle thought bubble appears near him and hides itself again', async () => {
  // BUDDY_MUTTER_MS is a test-only override (a config override is not available to this
  // harness): it collapses the default 2-minute interval down to something a spec can wait
  // out. The echo brain keeps this independent of the real CLI.
  app = await electron.launch({ args: ['.'], env: cleanEnv({ BUDDY_TEST: '1', BUDDY_BRAIN: 'echo', BUDDY_MUTTER_MS: '1500' }) })
  const overlay = await windowByUrl(app, 'overlay')
  await expect.poll(
    () => overlay.evaluate(() => (document.getElementById('buddy') as HTMLCanvasElement).width),
    { timeout: 15000 },
  ).toBeGreaterThan(0)

  const bubble = overlay.locator('#mutter')
  await expect(bubble).toBeVisible({ timeout: 10000 })
  await expect.poll(() => bubble.textContent().then(t => (t ?? '').trim().length)).toBeGreaterThan(0)

  // the same test hook shortens ttlMs to 1000 (production keeps 7000), so give the fade-out
  // and hide a generous margin past that.
  await expect(bubble).toBeHidden({ timeout: 12000 })
})
