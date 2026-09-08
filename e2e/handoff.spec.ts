import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanEnv } from './env'
import { loadPack } from '../src/main/pack'

// The hand-off launcher is replaced by a short node process (BUDDY_HANDOFF_CMD), so no
// console window opens and the launch itself is observable through a marker file it writes.
// The echo brain runs, so the second test proves /cli is refused where there is no CLI to
// hand to.
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

test('/cli launches the hook program in the workspace and the panel carries on', async () => {
  const marker = join(tmpdir(), `buddy-e2e-cli-${process.pid}-${Date.now()}.txt`)
  const hologram = await launch({ BUDDY_HANDOFF_CMD: JSON.stringify([process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.cwd())', marker]) })
  await hologram.locator('#input').fill('/cli')
  await hologram.locator('#input').press('Enter')
  await expect(hologram.locator('.msg.system').last()).toHaveText('Opened Claude Code in a terminal.')
  await expect.poll(() => existsSync(marker), { timeout: 10000 }).toBe(true)
  expect(readFileSync(marker, 'utf8').toLowerCase()).toBe(resolve('C:\\repo').toLowerCase())
  rmSync(marker, { force: true })

  await hologram.locator('#input').fill('still here?')
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
