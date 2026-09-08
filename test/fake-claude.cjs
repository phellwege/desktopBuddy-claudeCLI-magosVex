#!/usr/bin/env node
'use strict'

// Fake Claude Code CLI for tests. It parses the flags ClaudeCliBrain.buildArgs produces,
// reads the prompt as the first stdin line (later lines are steers), and prints scripted
// stream-json lines picked by the FAKE_CLAUDE_SCENARIO env var, each 20 ms apart. Two scenarios
// go further and perform real JSON-RPC tools/call requests against the live buddy MCP server
// named in --mcp-config: "mcp" calls set_mood and set_expression, and "permission" calls
// permission_prompt (the CLI's own permission-prompt tool, named on argv by
// --permission-prompt-tool) with a fake Bash request. No quota is spent; nothing here talks to
// the real Claude API.

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

// stdin is line-delimited. The brain writes stream-json user lines, {"type":"user",
// "message":{"role":"user","content":...}}, and keeps the pipe open so it can steer a
// running turn with further lines (docs/superpowers/specs/2026-09-07-mid-turn-steering-design.md).
// content is a string, or an array of Messages API blocks when images ride along
// (docs/superpowers/specs/2026-09-07-image-attachments-design.md): text blocks are joined
// with a space, captions included; image blocks are counted and their media types kept.
// The first line is the prompt and starts the scenario; later lines land in `steers`
// (their text) and `steerMessages` (the whole reading); EOF flips `stdinEnded`. A first
// line that is not JSON is taken as a plain-text prompt, which is what an older caller (or
// a test fake) writes.
const steers = []
const steerMessages = []
let promptMessage = null
let stdinEnded = false
let onStdinEnd = () => {}

function userMessage(line) {
  try {
    const msg = JSON.parse(line)
    const content = msg && msg.message && msg.message.content
    if (typeof content === 'string') return { text: content, images: 0, media: [] }
    if (Array.isArray(content)) {
      const texts = []
      const media = []
      for (const block of content) {
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        if (block.type === 'image' && block.source && typeof block.source.media_type === 'string') media.push(block.source.media_type)
      }
      return { text: texts.join(' '), images: media.length, media }
    }
    return { text: line, images: 0, media: [] }
  } catch {
    return { text: line, images: 0, media: [] }
  }
}

function readPrompt() {
  return new Promise((resolve) => {
    let buf = ''
    let first = null
    const take = (line) => {
      const m = userMessage(line)
      if (first === null) { first = m; promptMessage = m; resolve(m.text) } else { steers.push(m.text); steerMessages.push(m) }
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) take(line)
      }
    })
    process.stdin.on('end', () => {
      const rest = buf.trim()
      buf = ''
      if (rest) take(rest)
      // EOF with nothing taken (empty or whitespace-only stdin): run the scenario with an
      // empty prompt, as the old EOF-only reader did, rather than leaving main() awaiting
      // a promise that never settles and the process exiting with no output.
      if (first === null) { first = { text: '', images: 0, media: [] }; promptMessage = first; resolve('') }
      stdinEnded = true
      onStdinEnd()
    })
  })
}

function waitStdinEnd() {
  return stdinEnded ? Promise.resolve() : new Promise((resolve) => { onStdinEnd = resolve })
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

// One turn, then, once the brain has closed stdin (it does so at the first result), a second
// turn whose text echoes everything that came down the pipe: the prompt and every steer.
async function runSteerDrain(prompt) {
  await emit([
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'Hello' },
  ])
  await waitStdinEnd()
  await emit([
    { type: 'system', subtype: 'init', session_id: 's2', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ` prompt=${prompt} steers=${steers.join('|')}` } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's2', result: 'ok' },
  ])
}

// A result, then the process lingers the way the real CLI does while background work runs,
// and exits on its own after FAKE_CLAUDE_LINGER_MS (default 1500).
async function runLinger() {
  await emit([
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'Hello' },
  ])
  await sleep(Number(process.env.FAKE_CLAUDE_LINGER_MS) || 1500)
}

// Reports what the prompt carried (image count, media types, joined text), then, once
// stdin has closed and only if steers arrived, a second turn reporting what they carried.
// Lets the brain tests pin the wire shape without reading the child's stdin directly.
async function runImages() {
  const p = promptMessage || { text: '', images: 0, media: [] }
  await emit([
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `images=${p.images} media=${p.media.join(',')} text=${p.text}` } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'ok' },
  ])
  await waitStdinEnd()
  if (steerMessages.length === 0) return
  const steerImages = steerMessages.reduce((n, m) => n + m.images, 0)
  await emit([
    { type: 'system', subtype: 'init', session_id: 's2', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ` steerImages=${steerImages} steerText=${steerMessages.map((m) => m.text).join('|')}` } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 's2', result: 'ok' },
  ])
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
  const prompt = await readPrompt()
  try {
    switch (process.env.FAKE_CLAUDE_SCENARIO) {
      case 'tool': await runTool(); break
      case 'auth': await runAuth(); break
      case 'crash': await runCrash(); break
      case 'text-crash': await runTextCrash(); break
      case 'mcp': await runMcp(); break
      case 'permission': await runPermission(); break
      case 'steer-drain': await runSteerDrain(prompt); break
      case 'linger': await runLinger(); break
      case 'images': await runImages(); break
      case 'text':
      default: await runText()
    }
  } finally {
    // An open stdin would keep the event loop, and so this process, alive after the
    // scenario has said everything it has to say.
    process.stdin.destroy()
  }
}

main().catch((err) => {
  process.stderr.write(String((err && err.stack) || err) + '\n')
  process.exitCode = 1
})
