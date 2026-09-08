import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanEnv } from './env'

// Same shape as brain.spec.ts: node.exe runs the fake CLI in front of the real flags. The
// fake's images scenario reports what the prompt carried, so the wire shape is asserted
// end to end without a real model. An isolated profile keeps this run off the live one.
const fakeCliScript = join(__dirname, '../test/fake-claude.cjs')
const fixture = join(__dirname, '../test/fixtures/images/probe.png')
const fixtureBase64 = readFileSync(fixture).toString('base64')

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}

let app: ElectronApplication | undefined
let userDataDir: string

async function launch(): Promise<Page> {
  userDataDir = mkdtempSync(join(tmpdir(), 'buddy-e2e-images-'))
  app = await electron.launch({
    args: ['.'],
    env: cleanEnv({
      BUDDY_TEST: '1',
      BUDDY_USER_DATA: userDataDir,
      BUDDY_CLI_PATH: process.execPath,
      BUDDY_CLI_ARGS: JSON.stringify([fakeCliScript]),
      FAKE_CLAUDE_SCENARIO: 'images',
    }),
  })
  const hologram = await windowByUrl(app, 'hologram')
  await hologram.waitForLoadState('networkidle')
  await app.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  await hologram.locator('#input').waitFor()
  return hologram
}

test.afterEach(async () => {
  if (app) { const toClose = app; app = undefined; await toClose.close() }
  rmSync(userDataDir, { recursive: true, force: true })
})

// A synthetic paste: a ClipboardEvent whose DataTransfer holds a File built from the
// fixture. Such a File has no OS path, so it takes the bytes route, as a snip does.
async function pasteFile(hologram: Page): Promise<void> {
  await hologram.locator('#input').focus()
  await hologram.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const file = new File([bytes], 'probe.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    document.getElementById('input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, fixtureBase64)
}

test('a pasted bitmap becomes a chip, rides with the text, and shows in the bubble', async () => {
  const hologram = await launch()
  await pasteFile(hologram)
  await expect(hologram.locator('#attachments .chip')).toHaveCount(1)
  await expect(hologram.locator('#attachments .chip .label')).toHaveText('#1')

  await hologram.locator('#input').fill('what is this')
  await hologram.locator('#input').press('Enter')

  await expect(hologram.locator('.msg.user .thumbs img')).toHaveCount(1)
  await expect(hologram.locator('#attachments')).toBeHidden()
  const reply = hologram.locator('.msg.buddy').last()
  await expect.poll(() => reply.textContent(), { timeout: 15000 }).toContain('images=1 media=image/png text=[Image #1: probe.png] what is this')
})

test('a pasted path stages the file by path', async () => {
  const hologram = await launch()
  await hologram.locator('#input').focus()
  await hologram.evaluate((path) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', `look at ${path} please`)
    document.getElementById('input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, fixture)
  await expect(hologram.locator('#attachments .chip')).toHaveCount(1)
  await expect(hologram.locator('#attachments .chip')).toHaveAttribute('title', 'probe.png')
})

test('a dropped file stages, Backspace on an empty box removes the last chip', async () => {
  const hologram = await launch()
  await hologram.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
    document.getElementById('panel')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, fixtureBase64)
  await expect(hologram.locator('#attachments .chip')).toHaveCount(1)
  await hologram.locator('#input').focus()
  await hologram.locator('#input').press('Backspace')
  await expect(hologram.locator('#attachments .chip')).toHaveCount(0)
  await expect(hologram.locator('#attachments')).toBeHidden()
})

test('a refused file posts a reason and stages nothing', async () => {
  const hologram = await launch()
  await hologram.locator('#input').focus()
  await hologram.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'junk.png', { type: 'image/png' }))
    document.getElementById('input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await expect(hologram.locator('.msg.system').last()).toContainText('image: cannot decode')
  await expect(hologram.locator('#attachments .chip')).toHaveCount(0)
})
