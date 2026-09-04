#!/usr/bin/env node
// One-off smoke test against the REAL Claude Code CLI. This is the only thing in this repo
// that ever spawns the real CLI: unit tests and the e2e suite both drive test/fake-claude.cjs
// (through the test/fake-claude.exe launcher on Windows) so an automated run never touches
// the network or spends quota. Run this by hand with `npm run smoke:claude` to confirm the
// installed CLI still answers; it is never invoked by any other script or test.
import { spawn } from 'node:child_process'

function expandEnv(s) {
  return s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] ?? m)
}

// Mirrors config.ts's DEFAULT_CONFIG.cliPath (this script has no Electron app to load the
// real user config from, so BUDDY_CLI_PATH is how you point it at a different install).
const DEFAULT_CLI_PATH = '%USERPROFILE%\\.local\\bin\\claude.exe'
const cliPath = expandEnv(process.env.BUDDY_CLI_PATH || DEFAULT_CLI_PATH)
const prompt = 'Reply with exactly: OK'
const args = ['-p', '--output-format', 'stream-json', '--max-turns', '1']

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

child.on('close', (code) => {
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
