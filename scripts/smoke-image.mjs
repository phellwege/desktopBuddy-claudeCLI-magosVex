#!/usr/bin/env node
// One-off smoke test against the REAL Claude Code CLI: does stream-json stdin accept an
// image content block, as the prompt and as a later user line? Spends two haiku turns on
// the subscription; never run by any test. `npm run smoke:image`. Measured 2026-09-07 on
// 2.1.261: both answered with the squares' colours and the text MAGOS 42.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function expandEnv(s) {
  return s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] ?? m)
}
const cliPath = expandEnv(process.env.BUDDY_CLI_PATH || '%USERPROFILE%\\.local\\bin\\claude.exe')
const here = dirname(fileURLToPath(import.meta.url))
const png = readFileSync(join(here, '../test/fixtures/images/probe.png')).toString('base64')
const question = 'Answer in one line: what colours are the three squares from left to right, and what text is written under them? If you see no image, say NO IMAGE.'
const imageLine = JSON.stringify({ type: 'user', message: { role: 'user', content: [
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
  { type: 'text', text: '[Image #1: probe.png]' },
  { type: 'text', text: question },
] } }) + '\n'

function run(mode) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
      '--model', 'haiku', '--setting-sources', 'project', '--session-id', randomUUID(), '--tools', '', '--strict-mcp-config']
    const env = { ...process.env }
    delete env.CLAUDECODE; delete env.ANTHROPIC_API_KEY
    const child = spawn(cliPath, args, { cwd: here, env })
    child.stdin.on('error', () => {})
    if (mode === 'prompt') { child.stdin.write(imageLine); child.stdin.end() }
    else {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Reply with exactly the word READY and nothing else.' } }) + '\n')
      setTimeout(() => { child.stdin.write(imageLine); child.stdin.end() }, 300)
    }
    let rest = ''
    const results = []
    child.stdout.on('data', (c) => {
      rest += c.toString('utf8')
      const lines = rest.split('\n'); rest = lines.pop() ?? ''
      for (const l of lines) { if (!l.trim()) continue; try { const p = JSON.parse(l); if (p.type === 'result') results.push(p) } catch { /* not json */ } }
    })
    child.on('error', (e) => { console.log(`smoke-image: ${mode}: failed to spawn ${cliPath}: ${e.message}`); resolve(false) })
    child.on('close', (code) => {
      console.log(`smoke-image: ${mode}: exit ${code}, ${results.length} result line(s)`)
      results.forEach((r, i) => console.log(`smoke-image: ${mode}: result ${i + 1}: is_error=${r.is_error} text=${String(r.result)}`))
      resolve(results.length > 0 && results.every((r) => r.is_error !== true))
    })
  })
}

const okPrompt = await run('prompt')
const okSteer = await run('steer')
process.exitCode = okPrompt && okSteer ? 0 : 1
