import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanEnv } from './env'

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}

let app: ElectronApplication | undefined
let userDataDir: string | undefined

test.afterEach(async () => {
  if (app) {
    const toClose = app
    app = undefined
    await toClose.close()
  }
  if (userDataDir) { rmSync(userDataDir, { recursive: true, force: true }); userDataDir = undefined }
})

test('an idle thought bubble appears near him and hides itself again', async () => {
  // BUDDY_MUTTER_MS is a test-only override (a config override is not available to this
  // harness): it collapses the default 2-minute interval down to something a spec can wait
  // out. The echo brain keeps this independent of the real CLI.
  userDataDir = mkdtempSync(join(tmpdir(), 'buddy-e2e-'))
  app = await electron.launch({ args: ['.'], env: cleanEnv({ BUDDY_TEST: '1', BUDDY_BRAIN: 'echo', BUDDY_MUTTER_MS: '1500', BUDDY_USER_DATA: userDataDir }) })
  const overlay = await windowByUrl(app, 'overlay')
  await expect.poll(
    () => overlay.evaluate(() => (document.getElementById('buddy') as HTMLCanvasElement).width),
    { timeout: 15000 },
  ).toBeGreaterThan(0)

  const bubble = overlay.locator('#mutter')
  await expect(bubble).toBeVisible({ timeout: 10000 })
  await expect.poll(() => bubble.textContent().then(t => (t ?? '').trim().length)).toBeGreaterThan(0)

  // The two lead-in dots show and hide with the bubble, and sit inside the window.
  const big = overlay.locator('#mutter-dot-big')
  const small = overlay.locator('#mutter-dot-small')
  await expect(big).toBeVisible()
  await expect(small).toBeVisible()
  const boxes = await Promise.all([big.boundingBox(), small.boundingBox(), overlay.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))])
  for (const b of [boxes[0], boxes[1]]) {
    expect(b).not.toBeNull()
    expect(b!.x).toBeGreaterThanOrEqual(0)
    expect(b!.y).toBeGreaterThanOrEqual(0)
    expect(b!.x + b!.width).toBeLessThanOrEqual(boxes[2].w)
    expect(b!.y + b!.height).toBeLessThanOrEqual(boxes[2].h)
  }

  // the same test hook shortens ttlMs to 1000 (production keeps 7000), so give the fade-out
  // and hide a generous margin past that.
  await expect(bubble).toBeHidden({ timeout: 12000 })
  await expect(big).toBeHidden()
})
