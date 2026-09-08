import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanEnv } from './env'
import { loadPack } from '../src/main/pack'

// The tab's program is a node one-liner that prints a prompt and echoes each line back
// (BUDDY_PTY_CMD), running in a real ConPTY owned by the app, so the whole pipeline is
// exercised except the CLI itself. The echo brain runs, so the second test proves the tab
// shows the cliMissing line where there is nothing to run.
const ECHO_PROGRAM = "process.stdout.write('READY> '); process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { for (const l of String(d).split(/\\r?\\n/)) if (l.trim()) process.stdout.write('echo:' + l.trim() + '\\r\\n') })"
const loadedPack = loadPack(join(__dirname, '../packs/mechanicus'))
if (!loadedPack.ok) throw new Error(loadedPack.errors.join('\n'))
const CLI_MISSING_LINES = loadedPack.pack.persona.lines.cliMissing

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}
// The hologram is the only focusable window (the overlay is created focusable: false).
const hologramBoundsOf = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find(x => x.isFocusable())!
  return w.getBounds()
})

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

// The panel's box includes its 1 px borders, so its CSS width shows as up to 2 px more.
const panelWidth = async (hologram: Page) => Math.round((await hologram.locator('#panel').boundingBox())!.width)
const near = (target: number) => (w: number) => w >= target && w <= target + 2

test('the CLI tab widens the panel, runs the program, echoes typed input, and keeps its buffer across tabs', async () => {
  const hologram = await launch({ BUDDY_PTY_CMD: JSON.stringify([process.execPath, '-e', ECHO_PROGRAM]) })
  expect(near(480)(await panelWidth(hologram))).toBe(true)
  expect((await hologramBoundsOf(app!)).width).toBe(720)

  await hologram.locator('#tabs .tab[data-tab="cli"]').click()
  await expect.poll(async () => near(700)(await panelWidth(hologram))).toBe(true)
  await expect.poll(() => hologramBoundsOf(app!).then(b => b.width)).toBe(940)
  await expect(hologram.locator('#cli')).toContainText('READY>', { timeout: 15000 })

  await hologram.locator('#cli').click()
  await hologram.keyboard.type('hi')
  await hologram.keyboard.press('Enter')
  await expect(hologram.locator('#cli')).toContainText('echo:hi', { timeout: 15000 })

  await hologram.locator('#tabs .tab[data-tab="chat"]').click()
  await expect.poll(async () => near(480)(await panelWidth(hologram))).toBe(true)
  await expect.poll(() => hologramBoundsOf(app!).then(b => b.width)).toBe(720)
  await expect(hologram.locator('#cli')).toBeHidden()
  await expect(hologram.locator('#input')).toBeVisible()

  await hologram.locator('#tabs .tab[data-tab="cli"]').click()
  await expect(hologram.locator('#cli')).toContainText('echo:hi')
})

test('with nothing to run, the CLI tab shows the cliMissing line', async () => {
  const hologram = await launch({})
  await hologram.locator('#tabs .tab[data-tab="cli"]').click()
  // xterm renders rows as separate elements and wraps at the column count, so compare a
  // whitespace-normalized head of each line rather than the whole line.
  await expect.poll(async () => {
    const text = ((await hologram.locator('#cli').textContent()) ?? '').replace(/\s+/g, ' ')
    return CLI_MISSING_LINES.some(l => text.includes(l.slice(0, 24)))
  }, { timeout: 15000 }).toBe(true)
})
