import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'

// ClaudeCliBrain spawns config.cliPath directly (no shell), and on Windows that can only be
// a real executable: the app under test runs node.exe with the fake CLI script placed in
// front of the CLI flags through the BUDDY_CLI_ARGS test hook.
const fakeCliScript = join(__dirname, '../test/fake-claude.cjs')

async function windowByUrl(app: ElectronApplication, part: string): Promise<Page> {
  await expect.poll(() => app.windows().filter(w => w.url().includes(part)).length, { timeout: 15000 }).toBe(1)
  const page = app.windows().find(w => w.url().includes(part))!
  await page.waitForLoadState('domcontentloaded')
  return page
}

let app: ElectronApplication | undefined

async function launch(scenario: string): Promise<{ app: ElectronApplication; hologram: Page }> {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      BUDDY_TEST: '1',
      BUDDY_CLI_PATH: process.execPath,
      BUDDY_CLI_ARGS: JSON.stringify([fakeCliScript]),
      FAKE_CLAUDE_SCENARIO: scenario,
    },
  })
  const hologram = await windowByUrl(app, 'hologram')
  // The atlas image (used for faces) loads asynchronously over the pack:// protocol after
  // the window's script starts; wait for that fetch to settle before driving any input, or a
  // message created before it resolves would permanently render without a face slot (faces
  // are only ever attached to a bubble at creation time, never added retroactively). This is
  // a state check (has network gone quiet), not a wait for a future event, so it is correct
  // whether or not the fetch already finished by the time we get here.
  await hologram.waitForLoadState('networkidle')
  await app.evaluate(({ ipcMain }) => { ipcMain.emit('overlay:click') })
  return { app, hologram }
}

test.afterEach(async () => {
  if (app) {
    const toClose = app
    app = undefined
    await toClose.close()
  }
})

test('a streamed reply carries an expression face', async () => {
  const { hologram } = await launch('text')

  await hologram.locator('#input').fill('hello')
  await hologram.locator('#input').press('Enter')

  const lastReply = hologram.locator('.msg.buddy').last()
  await expect.poll(() => lastReply.textContent(), { timeout: 15000 }).toContain('Hello')
  await expect(lastReply.locator('.face')).toHaveCount(1)
})

test('a tool call shows a running activity row that completes', async () => {
  const { hologram } = await launch('tool')

  await hologram.locator('#input').fill('read a file for me')
  await hologram.locator('#input').press('Enter')

  const activity = hologram.locator('.activity').last()
  await expect(activity).toContainText('reading src/a.ts', { timeout: 15000 })
  await expect(activity).toHaveClass(/done/, { timeout: 15000 })
})

test('a permission request opens the card, and Deny reaches the CLI turn', async () => {
  const { hologram } = await launch('permission')

  await hologram.locator('#input').fill('run something risky')
  await hologram.locator('#input').press('Enter')

  const card = hologram.locator('#permission')
  await expect(card).toBeVisible({ timeout: 15000 })
  await expect(hologram.locator('#perm-detail')).toContainText('Bash')

  await hologram.locator('#perm-deny').click()
  await expect(card).toBeHidden()
  // Denying posts a system line from the pack's permissionDenied lines ("Denied. ...");
  // match case-insensitively so this does not depend on the pack's exact capitalization.
  await expect.poll(() => hologram.locator('#log').textContent(), { timeout: 15000 }).toMatch(/denied/i)
})

test('a buddy MCP tool call from the CLI reaches the real body state', async () => {
  const { app: electronApp, hologram } = await launch('mcp')

  await hologram.locator('#input').fill('do something nice')
  await hologram.locator('#input').press('Enter')

  await expect.poll(
    () => electronApp.evaluate(() => (globalThis as { __buddy?: { getState(): { mood: string } } }).__buddy!.getState().mood),
    { timeout: 15000 },
  ).toBe('happy')
})
