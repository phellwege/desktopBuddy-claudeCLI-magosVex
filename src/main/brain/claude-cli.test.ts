import { describe, it, expect } from 'vitest'
import { spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'
import { toolsNote } from './prompt'
import { buildArgs, childEnv, ClaudeCliBrain, type ClaudeCliDeps } from './claude-cli'
import type { LocalServer } from '../server'
import type { BuddyActions } from '../actions'
import type { Mood } from '../../shared/types'
import type { BrainEvent } from './types'

const fakeCliScript = join(__dirname, '../../../test/fake-claude.cjs')

function fakeServer(): LocalServer {
  return {
    port: 4321,
    token: 'tok',
    mcpConfig: () => '{"mcpServers":{"buddy":{"type":"http","url":"http://127.0.0.1:4321/mcp"}}}',
    close: async () => {},
  }
}

function baseDeps(overrides: Partial<ClaudeCliDeps> = {}): ClaudeCliDeps {
  return {
    cliPath: 'claude',
    workspace: 'C:\\repo',
    extraDirs: [],
    model: null,
    allowedTools: ['Read', 'Glob'],
    server: fakeServer(),
    lines: {},
    onMood: () => {},
    ...overrides,
  }
}

describe('buildArgs', () => {
  it('produces the exact flag list for a first turn', () => {
    const deps = baseDeps()
    expect(buildArgs(deps, null, 'new-id')).toEqual([
      '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--setting-sources', 'project',
      '--session-id', 'new-id',
      '--append-system-prompt', toolsNote(),
      '--mcp-config', deps.server.mcpConfig(),
      '--strict-mcp-config',
      '--allowedTools', 'Read Glob',
      '--permission-mode', 'manual',
      '--permission-prompt-tool', 'mcp__buddy__permission_prompt',
    ])
  })

  it('produces the exact flag list for a resumed turn, with model and extraDirs appended', () => {
    const deps = baseDeps({ model: 'sonnet', extraDirs: ['C:\\other', 'C:\\more'] })
    expect(buildArgs(deps, 'sess-1', 'new-id')).toEqual([
      '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--setting-sources', 'project',
      '--resume', 'sess-1',
      '--append-system-prompt', toolsNote(),
      '--mcp-config', deps.server.mcpConfig(),
      '--strict-mcp-config',
      '--allowedTools', 'Read Glob',
      '--permission-mode', 'manual',
      '--permission-prompt-tool', 'mcp__buddy__permission_prompt',
      '--model', 'sonnet',
      '--add-dir', 'C:\\other',
      '--add-dir', 'C:\\more',
    ])
  })
})

describe('childEnv', () => {
  it('drops CLAUDECODE and ANTHROPIC_API_KEY but keeps everything else', () => {
    const env = childEnv({ CLAUDECODE: '1', ANTHROPIC_API_KEY: 'sk-x', PATH: 'x', HOME: 'y' })
    expect(env).toEqual({ PATH: 'x', HOME: 'y' })
  })
})

// Runs the fake CLI as `node test/fake-claude.cjs <the real flags>` via process.execPath,
// with FAKE_CLAUDE_SCENARIO set for the chosen scenario, no matter what cliPath the deps say.
function fakeSpawn(scenario: string): ClaudeCliDeps['spawn'] {
  return ((_command: string, args: readonly string[], options: Record<string, unknown>) =>
    nodeSpawn(process.execPath, [fakeCliScript, ...args], {
      ...options,
      env: { ...(options.env as NodeJS.ProcessEnv), FAKE_CLAUDE_SCENARIO: scenario },
    })) as unknown as ClaudeCliDeps['spawn']
}

async function collect(events: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('ClaudeCliBrain', () => {
  it('streams a text turn: init handled internally, deltas, done with session id', async () => {
    const moods: (Mood | 'restore')[] = []
    const brain = new ClaudeCliBrain(baseDeps({ spawn: fakeSpawn('text'), onMood: (m) => moods.push(m) }))
    const events = await collect(brain.respond('hi', { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null }))
    expect(events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('')).toBe('Hello')
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 's1', error: undefined })
    expect(moods).toEqual(['restore'])
  }, 10000)

  it('uses ctx.workspace and ctx.model, since /cd and /model change them for the next turn', async () => {
    const calls: Array<{ args: string[]; cwd?: string }> = []
    const spawnFn = ((_command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ args: [...args], cwd: options.cwd as string | undefined })
      return nodeSpawn(process.execPath, [fakeCliScript, ...args], {
        ...options,
        env: { ...(options.env as NodeJS.ProcessEnv), FAKE_CLAUDE_SCENARIO: 'text' },
      })
    }) as unknown as ClaudeCliDeps['spawn']
    const brain = new ClaudeCliBrain(baseDeps({ spawn: spawnFn, workspace: 'C:\\stale', model: 'stale-model' }))
    await collect(brain.respond('hi', { state: {} as never, workspace: 'D:\\fresh', model: 'sonnet', sessionId: null }))
    expect(calls[0]?.cwd).toBe('D:\\fresh')
    expect(calls[0]?.args).toContain('sonnet')
    expect(calls[0]?.args).not.toContain('stale-model')
  }, 10000)

  it('yields activity then done for a tool turn, and sets mood thinking on the first activity', async () => {
    const moods: (Mood | 'restore')[] = []
    const brain = new ClaudeCliBrain(baseDeps({ spawn: fakeSpawn('tool'), onMood: (m) => moods.push(m) }))
    const events = await collect(brain.respond('hi', { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null }))
    const activities = events.filter(e => e.type === 'activity') as Array<{ id: string; done?: boolean }>
    expect(activities).toHaveLength(2)
    expect(activities[0]).toMatchObject({ id: 't1' })
    expect(activities[0]?.done).toBeFalsy()
    expect(activities[1]).toMatchObject({ id: 't1', done: true })
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 's1', error: undefined })
    expect(moods).toEqual(['thinking', 'restore'])
  }, 10000)

  it('prefixes an auth error done with the authError status line', async () => {
    const brain = new ClaudeCliBrain(baseDeps({ spawn: fakeSpawn('auth'), lines: { authError: ['Present your credentials.'] } }))
    const events = await collect(brain.respond('hi', { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null }))
    expect(events).toContainEqual({ type: 'status', text: 'Present your credentials.' , expression: 'sadness' })
    const done = events.at(-1) as { type: string; error?: string }
    expect(done.type).toBe('done')
    expect(done.error).toBe('Not logged in. Please run /login')
  }, 10000)

  it('reports the exit code and stderr tail when the process exits without a result', async () => {
    const brain = new ClaudeCliBrain(baseDeps({ spawn: fakeSpawn('crash') }))
    const events = await collect(brain.respond('hi', { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null }))
    const done = events.at(-1) as { type: string; error?: string }
    expect(done.type).toBe('done')
    expect(done.error).toContain('exit code 2')
    expect(done.error).toContain('fake crash')
  }, 10000)

  it('stop() mid-turn ends the iteration with a done mentioning stopped', async () => {
    // A generous gap between scripted lines so stop() has time to kill the process before it
    // finishes on its own (the default 20 ms gap is otherwise not reliably slower than
    // spawning taskkill and waiting for Windows to act on it).
    const spawnFn = ((_command: string, args: readonly string[], options: Record<string, unknown>) =>
      nodeSpawn(process.execPath, [fakeCliScript, ...args], {
        ...options,
        env: { ...(options.env as NodeJS.ProcessEnv), FAKE_CLAUDE_SCENARIO: 'text', FAKE_CLAUDE_GAP_MS: '300' },
      })) as unknown as ClaudeCliDeps['spawn']
    const brain = new ClaudeCliBrain(baseDeps({ spawn: spawnFn }))
    const iter = brain.respond('hi', { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null })[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.done).toBe(false)
    brain.stop()
    let last: BrainEvent | undefined
    for (;;) {
      const r = await iter.next()
      if (r.done) break
      last = r.value
    }
    expect(last?.type).toBe('done')
    expect((last as { error?: string }).error).toContain('stopped')
    // The id learned from init survives the stop so the next turn resumes this session.
    expect((last as { sessionId?: string }).sessionId).toBe('s1')
  }, 10000)

  it('reports cliMissing on ENOENT and never spawns a real child', async () => {
    const events = await collect(new ClaudeCliBrain(baseDeps({
      cliPath: 'C:\\definitely\\not\\a\\real\\claude.exe',
      lines: { cliMissing: ['The cogitator is absent.'] },
    })).respond('hi', { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null }))
    expect(events).toContainEqual({ type: 'status', text: 'The cogitator is absent.' , expression: 'sadness' })
    const done = events.at(-1) as { type: string; error?: string }
    expect(done.type).toBe('done')
    expect(done.error).toBeTruthy()
  })

  it('does not crash when child.stdin emits an error (e.g. EPIPE after the child already exited)', async () => {
    const { EventEmitter } = await import('node:events')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let created: any
    const spawnFn = (() => {
      const child = new EventEmitter()
      const stdin = Object.assign(new EventEmitter(), { write: () => true, end: () => {} })
      Object.assign(child, { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin })
      created = child
      return child
    }) as unknown as ClaudeCliDeps['spawn']
    const brain = new ClaudeCliBrain(baseDeps({ spawn: spawnFn }))
    const iterPromise = collect(brain.respond('hi', { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null }))
    await new Promise((r) => setTimeout(r, 0))
    // Without an 'error' listener on child.stdin, Node treats this as an uncaught exception
    // and the process (and this test) would crash instead of the turn simply finishing.
    created.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))
    created.emit('close', 0)
    const events = await iterPromise
    expect(events.at(-1)?.type).toBe('done')
  }, 10000)

  it('stop() on win32 spawns taskkill with stdio ignored and an error listener that swallows a failed spawn', async () => {
    if (process.platform !== 'win32') return
    const brain = new ClaudeCliBrain(baseDeps({ spawn: fakeSpawn('text') }))
    const iter = brain.respond('hi', { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null })[Symbol.asyncIterator]()
    await iter.next()
    // Real taskkill will fail against this fake pid, but stop() must not throw and the
    // spawned killer's own 'error' listener must swallow any spawn failure silently.
    expect(() => brain.stop()).not.toThrow()
  }, 10000)

  it('mcp scenario: the fake CLI drives set_mood and set_expression through the real local server', async () => {
    const { startLocalServer } = await import('../server')
    const moodCalls: string[] = []
    const expressionCalls: string[] = []
    const actions: BuddyActions = {
      goTo: async () => {}, setMood: (m) => moodCalls.push(m), emote: async () => {}, say: () => {},
      openPanel: () => {}, closePanel: () => {}, sleep: () => {}, wake: () => {},
      getState: () => ({ x: 0.5, facing: 'right', activity: 'idle', mood: 'calm', panelOpen: false, asleep: false }),
    }
    const server = await startLocalServer({
      actions,
      setExpression: (e) => expressionCalls.push(e),
      onPermission: async () => ({ allow: true, reason: 'ok' }),
      onPermissionTimeout: () => {},
      permissionTimeoutMs: 5000,
    })
    try {
      const brain = new ClaudeCliBrain(baseDeps({ server, spawn: fakeSpawn('mcp') }))
      const events = await collect(brain.respond('hi', { state: {} as never, workspace: 'C:\\repo', model: null, sessionId: null }))
      expect(events.at(-1)).toEqual({ type: 'done', sessionId: 's1', error: undefined })
      expect(moodCalls).toEqual(['happy'])
      expect(expressionCalls).toEqual(['happy'])
    } finally {
      await server.close()
    }
  }, 10000)
})
