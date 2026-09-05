import { describe, it, expect } from 'vitest'
import { spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildReadbackArgs, parseReadbackOutput, truncateInput, Readback, READBACK_INSTRUCTION, READBACK_MAX_CHARS, type ReadbackDeps } from './readback'

const fakeCliScript = join(__dirname, '../../../test/fake-claude.cjs')

describe('buildReadbackArgs', () => {
  it('produces the pinned flag list with the persona and instruction as the system prompt', () => {
    const args = buildReadbackArgs('I am the persona.')
    expect(args).toEqual([
      '-p', '--output-format', 'json', '--model', 'haiku',
      '--setting-sources', 'project', '--no-session-persistence',
      '--system-prompt', `I am the persona.\n\n${READBACK_INSTRUCTION}`,
      '--tools', '', '--strict-mcp-config',
    ])
  })
})

describe('truncateInput', () => {
  it('leaves short input alone and cuts long input with a marker', () => {
    expect(truncateInput('short')).toBe('short')
    const long = 'x'.repeat(READBACK_MAX_CHARS + 50)
    const cut = truncateInput(long)
    expect(cut.length).toBe(READBACK_MAX_CHARS + ' [truncated]'.length)
    expect(cut.endsWith(' [truncated]')).toBe(true)
  })
})

describe('parseReadbackOutput', () => {
  it('returns the result text on a clean success', () => {
    expect(parseReadbackOutput('{"type":"result","subtype":"success","is_error":false,"result":"So it is."}'))
      .toEqual({ ok: true, text: 'So it is.' })
  })
  it('fails on is_error, a non-success subtype, empty text, and malformed JSON', () => {
    expect(parseReadbackOutput('{"type":"result","subtype":"success","is_error":true,"result":"x"}').ok).toBe(false)
    expect(parseReadbackOutput('{"type":"result","subtype":"error_during_execution","is_error":false,"result":"x"}').ok).toBe(false)
    expect(parseReadbackOutput('{"type":"result","subtype":"success","is_error":false,"result":"   "}').ok).toBe(false)
    expect(parseReadbackOutput('not json').ok).toBe(false)
  })
})

function deps(over: Partial<ReadbackDeps> & { scenarioEnv?: Record<string, string> } = {}): ReadbackDeps {
  const scratchDir = join(mkdtempSync(join(tmpdir(), 'readback-')), 'scratch')
  const spawnFn = ((_cmd: string, args: readonly string[], options: Record<string, unknown>) =>
    nodeSpawn(process.execPath, [fakeCliScript, ...args], { ...options, env: { ...(options.env as NodeJS.ProcessEnv), ...(over.scenarioEnv ?? {}) } })
  ) as unknown as ReadbackDeps['spawn']
  return { cliPath: 'claude.exe', persona: 'I am the persona.', scratchDir, spawn: spawnFn, ...over }
}

describe('Readback', () => {
  it('returns the readback text from the fake CLI and creates the scratch cwd', async () => {
    const d = deps()
    const r = await new Readback(d).run('Hello there, this is the plain reply.')
    expect(r).toEqual({ ok: true, text: 'Readback: Hello there, this is the plain reply.' })
    expect(existsSync(d.scratchDir)).toBe(true)
  })
  it('reports a failing result instead of throwing', async () => {
    const r = await new Readback(deps({ scenarioEnv: { FAKE_CLAUDE_READBACK: 'fail' } })).run('x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('is_error')
  })
  it('times out, kills the child, and reports the timeout', async () => {
    const r = await new Readback(deps({ scenarioEnv: { FAKE_CLAUDE_READBACK: 'hang' }, timeoutMs: 300 })).run('x')
    expect(r).toEqual({ ok: false, reason: 'timeout after 300 ms' })
  }, 10000)
  it('reports ENOENT when the CLI is missing', async () => {
    const r = await new Readback({ cliPath: 'C:/definitely/missing/claude.exe', persona: 'p', scratchDir: join(tmpdir(), 'readback-none') }).run('x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('ENOENT')
  })
  it('passes the truncated input on stdin', async () => {
    const r = await new Readback(deps()).run('y'.repeat(READBACK_MAX_CHARS + 10))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe('Readback: ' + 'y'.repeat(40))
  })
})
