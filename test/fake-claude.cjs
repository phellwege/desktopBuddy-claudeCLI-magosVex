#!/usr/bin/env node
'use strict'

// Fake Claude Code CLI for tests. It parses the flags ClaudeCliBrain.buildArgs produces,
// drains stdin (the prompt), and prints scripted stream-json lines picked by the
// FAKE_CLAUDE_SCENARIO env var, each 20 ms apart. Two scenarios go further: "mcp" performs
// real JSON-RPC tools/call requests against the live buddy MCP server named in --mcp-config,
// and "permission" spawns the real permission-hook script named in --settings with a fake
// Bash request on stdin. No quota is spent; nothing here talks to the real Claude API.

const { spawn } = require('node:child_process')

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

function parseHookCommand(raw) {
  const settings = JSON.parse(raw)
  const hooks = settings && settings.hooks && settings.hooks.PermissionRequest
  const command = hooks && hooks[0] && hooks[0].hooks && hooks[0].hooks[0] && hooks[0].hooks[0].command
  if (!command) return null
  const m = /^node "(.+)" --port (\S+) --token (\S+)$/.exec(command)
  return m ? { hookPath: m[1], port: m[2], token: m[3] } : null
}

function runHook(hook, body) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook.hookPath, '--port', hook.port, '--token', hook.token])
    let out = ''
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.on('error', reject)
    child.on('close', () => resolve(out))
    child.stdin.write(body)
    child.stdin.end()
  })
}

async function runPermission() {
  await emit([{ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }])
  const raw = argValue('--settings')
  const hook = raw ? parseHookCommand(raw) : null
  let decision = 'deny'
  if (hook) {
    const body = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'pt1' })
    try {
      const hookOut = await runHook(hook, body)
      decision = JSON.parse(hookOut).hookSpecificOutput.decision
    } catch { /* keep the default deny */ }
  }
  await emit([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'pt1', name: 'Bash', input: { command: 'echo hi' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'pt1', content: `decision: ${decision}` }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: `decision: ${decision}` },
  ])
}

async function main() {
  await readStdin()
  switch (process.env.FAKE_CLAUDE_SCENARIO) {
    case 'tool': return runTool()
    case 'auth': return runAuth()
    case 'crash': return runCrash()
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
