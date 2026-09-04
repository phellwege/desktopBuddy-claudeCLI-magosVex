import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { BuddyState } from '../shared/types'
import type { BuddyActions } from './actions'
import { startLocalServer, summarizeToolInput, type LocalServer, type ServerDeps } from './server'

function fakeState(): BuddyState {
  return { x: 0.5, facing: 'right', activity: 'idle', mood: 'calm', panelOpen: false, asleep: false }
}

function fakeActions(): BuddyActions {
  return {
    goTo: vi.fn(async () => {}),
    setMood: vi.fn(),
    emote: vi.fn(async () => {}),
    say: vi.fn(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    sleep: vi.fn(),
    wake: vi.fn(),
    getState: vi.fn(() => fakeState()),
  }
}

function fakeDeps(overrides?: Partial<ServerDeps>): ServerDeps & { actions: ReturnType<typeof fakeActions>; setExpression: ReturnType<typeof vi.fn> } {
  const actions = fakeActions()
  return {
    actions,
    setExpression: vi.fn(),
    onPermission: vi.fn(async () => ({ allow: true, reason: 'ok' })),
    permissionTimeoutMs: 60000,
    ...overrides,
  } as ServerDeps & { actions: ReturnType<typeof fakeActions>; setExpression: ReturnType<typeof vi.fn> }
}

async function connectedClient(server: LocalServer): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
  })
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

describe('startLocalServer', () => {
  let server: LocalServer | undefined

  afterEach(async () => {
    if (server) { await server.close(); server = undefined }
  })

  it('binds to 127.0.0.1 on an ephemeral port', async () => {
    server = await startLocalServer(fakeDeps())
    expect(server.port).toBeGreaterThan(0)
    expect(server.token.length).toBeGreaterThan(0)
  })

  it('rejects a request without the bearer token with 401', async () => {
    server = await startLocalServer(fakeDeps())
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a permission request without the bearer token with 401', async () => {
    server = await startLocalServer(fakeDeps())
    const res = await fetch(`http://127.0.0.1:${server.port}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  it('lists the seven buddy tools', async () => {
    server = await startLocalServer(fakeDeps())
    const { client, close } = await connectedClient(server)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['emote', 'get_state', 'go_to', 'set_expression', 'set_mood', 'sleep', 'wake'].sort(),
    )
    await close()
  })

  it('go_to calls actions.goTo with a 0..1 fraction and the run flag', async () => {
    const deps = fakeDeps()
    server = await startLocalServer(deps)
    const { client, close } = await connectedClient(server)
    await client.callTool({ name: 'go_to', arguments: { x: 20 } })
    expect(deps.actions.goTo).toHaveBeenCalledExactlyOnceWith(0.2, { run: false })
    await close()
  })

  it('set_expression calls setExpression for a valid expression', async () => {
    const deps = fakeDeps()
    server = await startLocalServer(deps)
    const { client, close } = await connectedClient(server)
    await client.callTool({ name: 'set_expression', arguments: { expression: 'love' } })
    expect(deps.setExpression).toHaveBeenCalledExactlyOnceWith('love')
    await close()
  })

  it('set_expression returns an error result for an invalid expression', async () => {
    const deps = fakeDeps()
    server = await startLocalServer(deps)
    const { client, close } = await connectedClient(server)
    const result = await client.callTool({ name: 'set_expression', arguments: { expression: 'nope' } })
    expect(result.isError).toBe(true)
    expect(deps.setExpression).not.toHaveBeenCalled()
    await close()
  })

  it('emote awaits actions.emote', async () => {
    const deps = fakeDeps()
    server = await startLocalServer(deps)
    const { client, close } = await connectedClient(server)
    await client.callTool({ name: 'emote', arguments: { kind: 'hop' } })
    expect(deps.actions.emote).toHaveBeenCalledExactlyOnceWith('hop')
    await close()
  })

  it('sleep closes the panel before sleeping', async () => {
    const deps = fakeDeps()
    server = await startLocalServer(deps)
    const { client, close } = await connectedClient(server)
    await client.callTool({ name: 'sleep', arguments: {} })
    const closePanel = deps.actions.closePanel as ReturnType<typeof vi.fn>
    const sleep = deps.actions.sleep as ReturnType<typeof vi.fn>
    expect(closePanel).toHaveBeenCalledOnce()
    expect(sleep).toHaveBeenCalledOnce()
    expect(closePanel.mock.invocationCallOrder[0]).toBeLessThan(sleep.mock.invocationCallOrder[0]!)
    await close()
  })

  it('get_state returns the JSON-stringified state', async () => {
    const deps = fakeDeps()
    server = await startLocalServer(deps)
    const { client, close } = await connectedClient(server)
    const result = await client.callTool({ name: 'get_state', arguments: {} })
    const content = result.content as { type: string; text: string }[]
    expect(JSON.parse(content[0]!.text)).toEqual(fakeState())
    await close()
  })

  it('mcpConfig returns the mcpServers JSON pointing at this server', async () => {
    server = await startLocalServer(fakeDeps())
    const parsed = JSON.parse(server.mcpConfig())
    expect(parsed.mcpServers.buddy).toEqual({
      type: 'http',
      url: `http://127.0.0.1:${server.port}/mcp`,
      headers: { Authorization: `Bearer ${server.token}` },
    })
  })

  it('hookSettings returns a PermissionRequest hook command with port and token', async () => {
    server = await startLocalServer(fakeDeps({ permissionTimeoutMs: 60000 }))
    const parsed = JSON.parse(server.hookSettings('C:\\hook.cjs'))
    const hook = parsed.hooks.PermissionRequest[0].hooks[0]
    expect(hook.command).toBe(`node "C:\\hook.cjs" --port ${server.port} --token ${server.token}`)
    expect(hook.timeout).toBe(70)
  })

  describe('POST /permission', () => {
    it('resolves allow when onPermission resolves allow', async () => {
      const deps = fakeDeps({ onPermission: vi.fn(async () => ({ allow: true, reason: 'user allowed' })) })
      server = await startLocalServer(deps)
      const res = await fetch(`http://127.0.0.1:${server.port}/permission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_use_id: 'abc' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { decision: string; reason: string }
      expect(body.decision).toBe('allow')
      expect(body.reason).toBe('user allowed')
      const req = (deps.onPermission as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { id: string; toolName: string; summary: string }
      expect(req.id).toBe('abc')
      expect(req.toolName).toBe('Bash')
      expect(req.summary).toBe('running: ls -la')
    })

    it('denies after the server timeout when onPermission never resolves', async () => {
      const deps = fakeDeps({ onPermission: () => new Promise(() => {}), permissionTimeoutMs: 200 })
      server = await startLocalServer(deps)
      const res = await fetch(`http://127.0.0.1:${server.port}/permission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: 'xyz' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { decision: string; reason: string }
      expect(body.decision).toBe('deny')
    })
  })
})

describe('summarizeToolInput', () => {
  it('summarizes known tools untruncated', () => {
    expect(summarizeToolInput('Read', { file_path: 'src/a.ts' })).toBe('reading src/a.ts')
    expect(summarizeToolInput('Grep', { pattern: 'TODO' })).toBe('searching for TODO')
    expect(summarizeToolInput('Glob', { pattern: '**/*.ts' })).toBe('finding **/*.ts')
    expect(summarizeToolInput('Bash', { command: 'x'.repeat(200) })).toBe(`running: ${'x'.repeat(200)}`)
    expect(summarizeToolInput('Edit', { file_path: 'x.ts' })).toBe('editing x.ts')
    expect(summarizeToolInput('Write', { file_path: 'x.ts' })).toBe('writing x.ts')
    expect(summarizeToolInput('Other', {})).toBe('Other')
  })
})
