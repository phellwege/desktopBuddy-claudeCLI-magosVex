#!/usr/bin/env node
'use strict'

// Fake Claude Code CLI for tests. It parses the flags ClaudeCliBrain.buildArgs produces,
// drains stdin (the prompt), and prints scripted stream-json lines picked by the
// FAKE_CLAUDE_SCENARIO env var, each 20 ms apart. Two scenarios go further and perform real
// JSON-RPC tools/call requests against the live buddy MCP server named in --mcp-config: "mcp"
// calls set_mood and set_expression, and "permission" calls permission_prompt (the CLI's own
// permission-prompt tool, named on argv by --permission-prompt-tool) with a fake Bash request.
// No quota is spent; nothing here talks to the real Claude API.

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Overridable so a test that means to kill the process mid-stream (stop()) has time to do so
// before the scripted lines finish on their own; every other test keeps the default 20 ms.
const GAP_MS = Number(process.env.FAKE_CLAUDE_GAP_MS) || 20

async function emit(lines) {
  for (const line of lines) {
    process.stdout.write(JSON.stringify(line) + '\n')
    await sleep(GAP_MS)
  }
}

async function runText() {
  await emit([
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'Hello' },
  ])
}

async function runTool() {
  await emit([
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'ok' },
  ])
}

async function runAuth() {
  await emit([
    { type: 'result', subtype: 'error', is_error: true, result: 'Not logged in. Please run /login' },
  ])
}

async function runCrash() {
  await emit([{ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }])
  process.stderr.write('fake crash\n')
  process.exitCode = 2
}

// Streams a partial reply, then dies without a result line: the turn ends with an error
// after text is already on screen.
async function runTextCrash() {
  await emit([
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
  ])
  process.stderr.write('fake crash after text\n')
  process.exitCode = 2
}

async function runMcp() {
  await emit([{ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }])
  const raw = argValue('--mcp-config')
  const config = raw ? JSON.parse(raw) : null
  const buddy = config && config.mcpServers && config.mcpServers.buddy
  if (buddy) {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const transport = new StreamableHTTPClientTransport(new URL(buddy.url), { requestInit: { headers: buddy.headers } })
    const client = new Client({ name: 'fake-claude', version: '1.0.0' })
    await client.connect(transport)
    await client.callTool({ name: 'set_mood', arguments: { mood: 'happy' } })
    await client.callTool({ name: 'set_expression', arguments: { expression: 'happy' } })
    await client.close()
  }
  await emit([{ type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'ok' }])
}

async function runPermission() {
  await emit([{ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }])
  // Regression guard: buildArgs must always name the permission-prompt tool, or a real CLI
  // would auto-deny every tool call before any prompt is even shown (spec 6.4).
  if (!process.argv.includes('--permission-prompt-tool')) {
    process.stderr.write('fake-claude: missing --permission-prompt-tool on argv\n')
    process.exitCode = 2
    return
  }
  // Same idea for --permission-mode (spec 6.4.1): buildArgs must always pass it through.
  if (!process.argv.includes('--permission-mode')) {
    process.stderr.write('fake-claude: missing --permission-mode on argv\n')
    process.exitCode = 2
    return
  }
  // FAKE_CLAUDE_PERMISSION_COUNT (default 1) drives how many sequential permission_prompt
  // calls this scenario makes, same fake Bash input each time but a distinct tool_use_id -
  // lets a test exercise the session allow-list (first call shows the card, later calls for
  // the same tool name are answered without one).
  const count = Number(process.env.FAKE_CLAUDE_PERMISSION_COUNT) || 1
  const raw = argValue('--mcp-config')
  const config = raw ? JSON.parse(raw) : null
  const buddy = config && config.mcpServers && config.mcpServers.buddy
  let client = null
  if (buddy) {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const transport = new StreamableHTTPClientTransport(new URL(buddy.url), { requestInit: { headers: buddy.headers } })
    client = new Client({ name: 'fake-claude', version: '1.0.0' })
    await client.connect(transport)
  }
  let lastDecision = 'deny'
  for (let i = 1; i <= count; i++) {
    const toolUseId = `pt${i}`
    let decision = 'deny'
    if (client) {
      const result = await client.callTool({
        name: 'permission_prompt',
        arguments: { tool_name: 'Bash', input: { command: 'echo hi' }, tool_use_id: toolUseId },
      })
      try {
        const text = result.content && result.content[0] && result.content[0].text
        const parsed = text ? JSON.parse(text) : null
        decision = parsed && parsed.behavior === 'allow' ? 'allow' : 'deny'
      } catch { /* keep the default deny */ }
    }
    lastDecision = decision
    await emit([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'echo hi' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `decision: ${decision}` }] } },
    ])
  }
  if (client) await client.close()
  await emit([
    { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: `decision: ${lastDecision}` },
  ])
}

async function runReadback() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const input = Buffer.concat(chunks).toString('utf8')
  if (!process.argv.includes('--system-prompt') || !process.argv.includes('--no-session-persistence')) {
    process.stderr.write('fake-claude: readback call is missing --system-prompt or --no-session-persistence\n')
    process.exit(2)
  }
  if (process.env.FAKE_CLAUDE_READBACK === 'fail') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'fake failure' }) + '\n')
    return
  }
  if (process.env.FAKE_CLAUDE_READBACK === 'hang') {
    await new Promise((r) => setTimeout(r, 60000))
    return
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Readback: ' + input.slice(0, 40) }) + '\n')
}

async function main() {
  // The readback call (src/main/brain/readback.ts) is the only caller that asks for plain
  // json output; it inherits FAKE_CLAUDE_SCENARIO from the app, so it is keyed on argv.
  if (argValue('--output-format') === 'json') return runReadback()
  await readStdin()
  switch (process.env.FAKE_CLAUDE_SCENARIO) {
    case 'tool': return runTool()
    case 'auth': return runAuth()
    case 'crash': return runCrash()
    case 'text-crash': return runTextCrash()
    case 'mcp': return runMcp()
    case 'permission': return runPermission()
    case 'text':
    default: return runText()
  }
}

main().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + '\n')
  process.exitCode = 1
})
