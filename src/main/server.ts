// Local MCP tool server. Bound to 127.0.0.1, port chosen at launch, with a bearer token
// generated at launch and required on every request. The brain spawns a fresh CLI process per
// turn, so each turn is a new MCP session: one McpServer and one Streamable HTTP transport per
// session, created on initialize and dropped when the client closes it or the next turn's
// client replaces it. Permission prompts are just another tool on this server
// (permission_prompt, named by --permission-prompt-tool on the CLI's argv); there is no
// separate HTTP route or hook script for them.
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { EXPRESSIONS, type EmoteKind, type Expression, type Mood } from '../shared/types'
import type { BuddyActions } from './actions'

export interface ServerDeps {
  actions: BuddyActions
  setExpression(name: Expression): void
  // main shows the permission card; resolves on the user's answer or the server's own timeout
  onPermission(req: PermissionRequest): Promise<{ allow: boolean; reason: string }>
  // Called (instead of onPermission's own resolution) when the server's timeout answers the
  // hook on its own: main uses this to drop the now-stale pending entry, tell the renderer to
  // dismiss the card, and post a status line, none of which onPermission's return value alone
  // can trigger once nobody is going to await it further.
  onPermissionTimeout(id: string): void
  permissionTimeoutMs: number
}

export interface PermissionRequest { id: string; toolName: string; input: unknown; summary: string }

export interface LocalServer {
  port: number
  token: string
  mcpConfig(): string
  close(): Promise<void>
}

// Mirrors the Mood and EmoteKind unions in ../shared/types; kept here because those types
// carry no runtime array of their own (unlike Expression, which exports EXPRESSIONS).
const MOODS = ['calm', 'happy', 'thinking', 'confused', 'alarmed'] as const satisfies readonly Mood[]
const EMOTE_KINDS = ['happy', 'thinking', 'confused', 'alarmed', 'look', 'hop'] as const satisfies readonly EmoteKind[]

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}
function asString(v: unknown): string { return typeof v === 'string' ? v : '' }

// Same rules as brain/stream.ts's activityLabel, but the command or path is never truncated:
// a permission card should show the whole thing so the user can judge it.
export function summarizeToolInput(toolName: string, input: unknown): string {
  const rec = asRecord(input)
  switch (toolName) {
    case 'Read': return `reading ${asString(rec.file_path)}`
    case 'Grep': return `searching for ${asString(rec.pattern)}`
    case 'Glob': return `finding ${asString(rec.pattern)}`
    case 'Bash': return `running: ${asString(rec.command)}`
    case 'Edit': return `editing ${asString(rec.file_path)}`
    case 'Write': return `writing ${asString(rec.file_path)}`
    default: return toolName
  }
}

function textResult(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] }
}

function buildMcpServer(deps: ServerDeps): McpServer {
  const mcp = new McpServer({ name: 'buddy', version: '1.0.0' })

  mcp.registerTool('go_to', {
    description: 'Move the body to a percentage across the screen.',
    inputSchema: { x: z.number().min(0).max(100), run: z.boolean().optional() },
  }, async ({ x, run }) => {
    await deps.actions.goTo(x / 100, { run: run ?? false })
    return textResult(`arrived at ${x}%`)
  })

  mcp.registerTool('set_mood', {
    description: 'Change the body language (calm, happy, thinking, confused, alarmed).',
    inputSchema: { mood: z.enum(MOODS) },
  }, ({ mood }) => {
    deps.actions.setMood(mood)
    return textResult(`mood: ${mood}`)
  })

  mcp.registerTool('emote', {
    description: 'Play a one-off reaction.',
    inputSchema: { kind: z.enum(EMOTE_KINDS) },
  }, async ({ kind }) => {
    await deps.actions.emote(kind)
    return textResult(`emoted: ${kind}`)
  })

  mcp.registerTool('sleep', { description: 'Go to sleep, closing the panel first.' }, () => {
    deps.actions.closePanel()
    deps.actions.sleep()
    return textResult('asleep')
  })

  mcp.registerTool('wake', { description: 'Wake up.' }, () => {
    deps.actions.wake()
    return textResult('awake')
  })

  mcp.registerTool('get_state', { description: 'Read the current state.' }, () => {
    return textResult(JSON.stringify(deps.actions.getState()))
  })

  mcp.registerTool('set_expression', {
    description: 'Pick the face shown next to this reply. love only for a genuinely brilliant idea, almost never.',
    inputSchema: { expression: z.enum(EXPRESSIONS) },
  }, ({ expression }) => {
    deps.setExpression(expression)
    return textResult(`expression: ${expression}`)
  })

  // The CLI's own permission prompt, named on its argv by --permission-prompt-tool. Called
  // with { tool_name, input, tool_use_id } for any tool not already covered by --allowedTools;
  // the reply is a single text block carrying the CLI's expected decision JSON, not a normal
  // status string like the other tools above.
  mcp.registerTool('permission_prompt', {
    description: "The CLI's permission prompt for a tool call that needs the user's say-so.",
    inputSchema: {
      tool_name: z.string(),
      input: z.record(z.string(), z.unknown()).optional(),
      tool_use_id: z.string().optional(),
    },
  }, async ({ tool_name, input, tool_use_id }) => {
    const request: PermissionRequest = {
      id: tool_use_id ?? randomUUID(),
      toolName: tool_name,
      input,
      summary: summarizeToolInput(tool_name, input),
    }

    let timedOut = false
    let timer: ReturnType<typeof setTimeout>
    const timeoutSeconds = deps.permissionTimeoutMs / 1000
    const timeout = new Promise<{ allow: boolean; reason: string }>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve({ allow: false, reason: `no answer within ${timeoutSeconds} s` }) }, deps.permissionTimeoutMs)
    })
    const decision = await Promise.race([deps.onPermission(request), timeout])
    clearTimeout(timer!)
    if (timedOut) deps.onPermissionTimeout(request.id)

    const payload = decision.allow
      ? { behavior: 'allow', updatedInput: input ?? {} }
      : { behavior: 'deny', message: decision.reason }
    return textResult(JSON.stringify(payload))
  })

  return mcp
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function startLocalServer(deps: ServerDeps): Promise<LocalServer> {
  const token = randomBytes(24).toString('hex')
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: McpServer }>()

  async function dropSession(id: string): Promise<void> {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    await s.transport.close().catch(() => undefined)
    await s.mcp.close().catch(() => undefined)
  }

  function jsonError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers['mcp-session-id']
    const sid = Array.isArray(header) ? header[0] : header
    if (sid) {
      const s = sessions.get(sid)
      if (!s) { jsonError(res, 404, 'Session not found'); return }
      await s.transport.handleRequest(req, res)
      return
    }
    if (req.method !== 'POST') { jsonError(res, 400, 'Mcp-Session-Id header required'); return }
    let body: unknown
    try { body = JSON.parse(await readBody(req)) } catch { jsonError(res, 400, 'Invalid JSON'); return }
    if (!isInitializeRequest(body)) { jsonError(res, 400, 'Not an initialize request'); return }
    // One CLI process talks to this server at a time. A process that was killed, or exited
    // without a DELETE, leaves its session behind; the next turn's initialize replaces it.
    for (const id of [...sessions.keys()]) await dropSession(id)
    const mcp = buildMcpServer(deps)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, { transport, mcp }) },
      onsessionclosed: (id) => { sessions.delete(id) },
    })
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId) }
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  const httpServer = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      console.error('server: unhandled error handling request', err)
      // A throw partway through route() (e.g. onPermission throwing instead of rejecting)
      // must not leave the client's request hanging forever with no response at all.
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal error' }))
      } else if (!res.writableEnded) {
        res.end()
      }
    })
  })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/mcp') { await handleMcp(req, res); return }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => resolve())
  })
  const address = httpServer.address()
  const port = address && typeof address === 'object' ? address.port : 0

  return {
    port,
    token,
    mcpConfig(): string {
      return JSON.stringify({
        mcpServers: { buddy: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } },
      })
    },
    async close(): Promise<void> {
      for (const id of [...sessions.keys()]) await dropSession(id)
      httpServer.closeAllConnections()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}
