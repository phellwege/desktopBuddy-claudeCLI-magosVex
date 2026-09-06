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

let app: ElectronApplication
let hologram: Page
let userDataDir: string

// One launch, one fresh profile, shared across both tests below: the dictation hint is a
// once-per-profile thing, and the second test relies on the placeholder the first launch's
// script already set (before either test body runs).
test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'buddy-e2e-'))
  app = await electron.launch({ args: ['.'], env: cleanEnv({ BUDDY_TEST: '1', BUDDY_BRAIN: 'echo', BUDDY_USER_DATA: userDataDir }) })
  hologram = await windowByUrl(app, 'hologram')
  await hologram.waitForLoadState('networkidle')
})

test.afterAll(async () => {
  await app.close()
  rmSync(userDataDir, { recursive: true, force: true })
})

test('the composer grows with a dictated take and snaps back after send', async () => {
  const input = hologram.locator('#input')
  const emptyHeight = (await input.boundingBox())!.height

  // Dictation arrives as one long line with no newlines.
  const longLine = 'word '.repeat(120)
  await input.fill(longLine)
  const grownHeight = (await input.boundingBox())!.height
  expect(grownHeight).toBeGreaterThanOrEqual(emptyHeight * 2)
  expect(grownHeight).toBeLessThanOrEqual(140)

  await input.press('Enter')
  // The echo brain answers the prompt; that is fine, this test only cares about the box.
  await expect.poll(async () => (await input.boundingBox())!.height, { timeout: 5000 }).toBeLessThanOrEqual(emptyHeight + 1)
  await expect.poll(async () => (await input.boundingBox())!.height, { timeout: 5000 }).toBeGreaterThanOrEqual(emptyHeight - 1)
})

test('a fresh profile hints at dictation once', async () => {
  await expect(hologram.locator('#input')).toHaveAttribute('placeholder', /to dictate/)

  await hologram.reload()
  await hologram.locator('#input').waitFor()
  await expect(hologram.locator('#input')).toHaveAttribute('placeholder', 'Speak, operator. /help for rites.')
})
