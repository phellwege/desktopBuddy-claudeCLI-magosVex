#!/usr/bin/env node
// One-off smoke test against the REAL Claude Code CLI. This is the only thing in this repo
// that ever spawns the real CLI: unit tests and the e2e suite both drive test/fake-claude.cjs
// (node.exe plus the fake script through the BUDDY_CLI_ARGS hook) so an automated run never touches
// the network or spends quota. Run this by hand with `npm run smoke:claude` to confirm the
// installed CLI still answers, including the permission-prompt tool flow; it is never invoked
// by any other script or test.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

function expandEnv(s) {
  return s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] ?? m)
}

// Mirrors config.ts's DEFAULT_CONFIG.cliPath (this script has no Electron app to load the
// real user config from, so BUDDY_CLI_PATH is how you point it at a different install).
const DEFAULT_CLI_PATH = '%USERPROFILE%\\.local\\bin\\claude.exe'
const cliPath = expandEnv(process.env.BUDDY_CLI_PATH || DEFAULT_CLI_PATH)
// Bash is deliberately left out of allowedTools below, so asking for a shell command forces
// the CLI through the permission-prompt tool exercised here.
const prompt = 'Run the shell command `echo hi` using your Bash tool and tell me what it printed.'

// A throwaway MCP server standing in for main's real buddy server (src/main/server.ts): the
// same Streamable HTTP shape, but with only permission_prompt, which always denies. Good
// enough to prove --permission-prompt-tool actually reaches this process and that the CLI
// honors the deny shape; it never touches the real body or the real buddy server.
async function startThrowawayMcpServer() {
  const token = randomBytes(24).toString('hex')
  const mcp = new McpServer({ name: 'smoke-buddy', version: '1.0.0' })
  mcp.registerTool('permission_prompt', {
    description: 'Auto-denying permission prompt for the smoke test.',
    inputSchema: {
      tool_name: z.string(),
      input: z.record(z.string(), z.unknown()).optional(),
      tool_use_id: z.string().optional(),
    },
  }, async ({ tool_name }) => {
    console.log(`smoke-claude: permission_prompt called for ${tool_name}, auto-denying`)
    return { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'auto-denied by smoke-claude.mjs' }) }] }
  })

  let transport
  const httpServer = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/mcp') { res.writeHead(404); res.end(); return }
    if (req.headers['mcp-session-id']) {
      if (!transport) { res.writeHead(404); res.end(); return }
      await transport.handleRequest(req, res)
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.writeHead(400); res.end(); return }
    if (!isInitializeRequest(body)) { res.writeHead(400); res.end(); return }
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  })
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => resolve())
  })
  const address = httpServer.address()
  const port = address && typeof address === 'object' ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () => new Promise((resolve) => httpServer.close(() => resolve())),
  }
}

// Mirrors src/main/brain/claude-cli.ts buildArgs, flag for flag. Kept in sync by hand: this
// plain script has no built main process to import the real function from, and buildArgs
// itself is covered by claude-cli.test.ts's own argv assertions.
function buildSmokeArgs({ sessionId, mcpConfig }) {
  return [
    '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--setting-sources', 'project',
    '--session-id', sessionId,
    '--append-system-prompt', '(smoke test, no persona)',
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--allowedTools', 'Read Glob Grep mcp__buddy__*',
    '--permission-mode', 'manual',
    '--permission-prompt-tool', 'mcp__buddy__permission_prompt',
  ]
}

const mcpServer = await startThrowawayMcpServer()
const mcpConfig = JSON.stringify({
  mcpServers: { buddy: { type: 'http', url: mcpServer.url, headers: { Authorization: `Bearer ${mcpServer.token}` } } },
})
const args = buildSmokeArgs({ sessionId: randomUUID(), mcpConfig })

console.log(`smoke-claude: spawning ${cliPath} ${args.join(' ')}`)
console.log(`smoke-claude: prompt: ${prompt}`)

const child = spawn(cliPath, args, { cwd: process.cwd(), env: process.env })

let stdoutRemainder = ''
let result = null
const stderrLines = []

child.stdout.on('data', (chunk) => {
  stdoutRemainder += chunk.toString('utf8')
  const lines = stdoutRemainder.split('\n')
  stdoutRemainder = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed && parsed.type === 'system' && parsed.subtype === 'init') {
      console.log(`smoke-claude: init mcp_servers: ${JSON.stringify(parsed.mcp_servers)}`)
    }
    if (parsed && parsed.type === 'result') result = parsed
  }
})
child.stderr.on('data', (chunk) => {
  for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) stderrLines.push(line.trim())
})

child.on('error', (err) => {
  console.error(`smoke-claude: failed to spawn ${cliPath}: ${err.message}`)
  process.exitCode = 1
})

child.stdin.write(prompt)
child.stdin.end()

child.on('close', async (code) => {
  await mcpServer.close()
  if (process.exitCode) return
  if (!result) {
    console.error(`smoke-claude: no result line arrived (exit code ${code})`)
    if (stderrLines.length) console.error(stderrLines.slice(-5).join('\n'))
    process.exitCode = 1
    return
  }
  const ok = result.is_error !== true && result.subtype === 'success'
  const text = typeof result.result === 'string' ? result.result : '(no text)'
  console.log(`smoke-claude: result arrived, ok=${ok}`)
  console.log(`smoke-claude: text: ${text}`)
  process.exitCode = ok ? 0 : 1
})
