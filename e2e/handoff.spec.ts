import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanEnv } from './env'
import { loadPack } from '../src/main/pack'

// The hand-off launcher is replaced by a node process that lives 1500 ms (BUDDY_HANDOFF_CMD),
// so no console window opens and the stand-down and return are observable. The echo brain
// runs, so the second test proves /cli is refused where there is no CLI to hand to.
const loadedPack = loadPack(join(__dirname, '../packs/mechanicus'))
if (!loadedPack.ok) throw new Error(loadedPack.errors.join('\n'))
const CLI_MISSING_LINES = loadedPack.pack.persona.lines.cliMissing

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}

let app: ElectronApplication | undefined
let userDataDir: string | undefined

async function launch(extraEnv: Record<string, string>): Promise<Page> {
  userDataDir = mkdtempSync(join(tmpdir(), 'buddy-e2e-'))
  app = await electron.launch({ args: ['.'], env: cleanEnv({ BUDDY_TEST: '1', BUDDY_BRAIN: 'echo', BUDDY_USER_DATA: userDataDir, ...extraEnv }) })
  const overlay = await windowByUrl(app, 'overlay')
  await expect.poll(() => overlay.evaluate(() => (document.getElementById('buddy') as HTMLCanvasElement).width), { timeout: 15000 }).toBeGreaterThan(0)
  await app.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  const hologram = await windowByUrl(app, 'hologram')
  await hologram.waitForLoadState('networkidle')
  await hologram.locator('#input').waitFor()
  return hologram
}

test.afterEach(async () => {
  if (app) { const toClose = app; app = undefined; await toClose.close() }
  if (userDataDir) { rmSync(userDataDir, { recursive: true, force: true }); userDataDir = undefined }
})

test('/cli stands the panel down until the terminal process exits', async () => {
  const hologram = await launch({ BUDDY_HANDOFF_CMD: JSON.stringify([process.execPath, '-e', 'setTimeout(() => {}, 1500)']) })
  await hologram.locator('#input').fill('/cli')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.system').last()).toHaveText('He is in the terminal. Close it to continue here.')

  await hologram.locator('#input').fill('are you there')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.system').last()).toHaveText('He is in the terminal. Close it to continue here.')
  await expect(hologram.locator('.msg.buddy')).toHaveCount(0)

  await expect(hologram.locator('.msg.system').last()).toHaveText('Back from the terminal.', { timeout: 10000 })
  await hologram.locator('#input').fill('now?')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.buddy')).toHaveCount(1, { timeout: 15000 })
})

test('/cli with no CLI to hand to posts the cliMissing line', async () => {
  const hologram = await launch({})
  await hologram.locator('#input').fill('/cli')
  await hologram.locator('#input').press('Enter')
  const line = await hologram.locator('.msg.system').last().textContent()
  expect(CLI_MISSING_LINES).toContain(line?.trim())
})
