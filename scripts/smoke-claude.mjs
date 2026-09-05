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
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    // Deliberately kept as 'manual' regardless of config.permissionMode: this script's whole
    // point is to exercise the permission-prompt tool (the Bash request above), and acceptEdits
    // would not change that (it only auto-approves file edits, not shell commands), so there is
    // no reason to ever pass acceptEdits here.
    '--permission-mode', 'manual',
    '--permission-prompt-tool', 'mcp__buddy__permission_prompt',
  ]
}

// Mirrors src/main/brain/readback.ts's READBACK_INSTRUCTION and buildReadbackArgs, flag for
// flag. Kept in sync by hand, same reasoning as buildSmokeArgs above: this plain script has
// no built main process to import the real functions from, and both are covered by
// readback.test.ts's own unit assertions.
const SMOKE_READBACK_INSTRUCTION =
  'You are the voice layer of a desktop assistant. The user\'s message below is a reply the ' +
  'assistant just gave, written in plain language. Restate its substance in your own character ' +
  'in at most three short sentences. Add no facts and answer nothing new. Keep file names, ' +
  'commands, and numbers exactly as written. Use no code blocks, lists, or headings. If the reply ' +
  'is only code, say what the code does. Output the restatement and nothing else.'
function buildSmokeReadbackArgs(persona) {
  return [
    '-p', '--output-format', 'json', '--model', 'haiku',
    '--setting-sources', 'project', '--no-session-persistence',
    '--system-prompt', `${persona}\n\n${SMOKE_READBACK_INSTRUCTION}`,
    '--tools', '', '--strict-mcp-config',
  ]
}

// Spawns the readback call the same way src/main/brain/readback.ts's Readback.run does: a
// second, tool-less CLI call restating the main turn's reply, on its own process, with the
// reply text on stdin and a scratch cwd. Never touches the main turn's session or workspace.
async function runReadbackSmoke(replyText) {
  const persona = 'You are a terse narrator.'
  const args = buildSmokeReadbackArgs(persona)
  const scratchDir = join(tmpdir(), 'buddy-smoke-readback')
  try { mkdirSync(scratchDir, { recursive: true }) } catch { /* spawn below reports a missing cwd */ }
  console.log(`smoke-claude: spawning readback ${cliPath} ${args.join(' ')}`)
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cliPath, args, { cwd: scratchDir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      console.log(`smoke-claude: readback: failed to spawn: ${e.message}`)
      resolve()
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (e) => {
      console.log(`smoke-claude: readback: ${e.code ?? 'spawn error'}: ${e.message}`)
      resolve()
    })
    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ')
        console.log(`smoke-claude: readback: exit code ${code ?? 'null'}${tail ? ': ' + tail : ''}`)
        resolve()
        return
      }
      let parsed
      try { parsed = JSON.parse(stdout.trim()) } catch {
        console.log('smoke-claude: readback: malformed JSON')
        resolve()
        return
      }
      if (parsed.is_error === true) {
        console.log(`smoke-claude: readback: is_error: ${String(parsed.result).slice(0, 120)}`)
      } else if (parsed.subtype !== 'success') {
        console.log(`smoke-claude: readback: subtype ${parsed.subtype ?? 'missing'}`)
      } else {
        const readbackText = typeof parsed.result === 'string' ? parsed.result.trim() : ''
        console.log(readbackText ? `smoke-claude: readback: ${readbackText}` : 'smoke-claude: readback: empty result')
      }
      resolve()
    })
    child.stdin.write(replyText)
    child.stdin.end()
  })
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
  if (ok) await runReadbackSmoke(text)
})
