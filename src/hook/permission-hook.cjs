#!/usr/bin/env node
'use strict'

// PermissionRequest hook, run by the Claude CLI as a plain child process (no dependencies:
// this must run under a bare `node` with nothing installed). Reads the hook's JSON request
// from stdin, forwards it to the local buddy server's /permission endpoint with the bearer
// token from argv, and prints the CLI's expected hookSpecificOutput JSON. Any failure (bad
// argv, unreachable server, bad response) prints a deny with the error as the reason and
// still exits 0, so a server hiccup never blocks the CLI on a stuck hook.

const http = require('node:http')

// The CLI kills this process after the "timeout" seconds set in the generated hooks
// settings (permissionTimeoutMs / 1000 + 10). This request timeout should sit a few seconds
// under that, so the hook can still print its own deny before the CLI force-kills it with no
// output at all. The server passes the real value on the command line (--timeout, in ms) so
// it always tracks the configured permissionTimeoutSec; this constant is only a fallback for
// the (should-never-happen) case where the flag is missing or malformed.
const DEFAULT_REQUEST_TIMEOUT_MS = 125000

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

function printDecision(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: decision === 'allow' ? 'allow' : 'deny',
      decisionReason: reason,
    },
  }) + '\n')
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

function postPermission(port, token, timeoutMs, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: Number(port),
      path: '/permission',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${token}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) reject(new Error(`permission server returned ${res.statusCode}: ${text.slice(0, 200)}`))
        else resolve(text)
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('permission request timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

function requestTimeoutMs() {
  const raw = argValue('--timeout')
  const n = raw !== undefined ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REQUEST_TIMEOUT_MS
}

async function main() {
  const port = argValue('--port')
  const token = argValue('--token')
  if (!port || !token) throw new Error('missing --port or --token')

  const body = await readStdin()
  const raw = await postPermission(port, token, requestTimeoutMs(), body)
  const parsed = JSON.parse(raw)
  const reason = typeof parsed.reason === 'string' ? parsed.reason : ''
  printDecision(parsed.decision === 'allow' ? 'allow' : 'deny', reason)
}

main().catch((err) => {
  printDecision('deny', err && err.message ? err.message : String(err))
})
