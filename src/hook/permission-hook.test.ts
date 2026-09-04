import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const HOOK_PATH = join(__dirname, 'permission-hook.cjs')

interface HookOutput { hookSpecificOutput: { hookEventName: string; decision: string; decisionReason: string } }

function runHook(port: number, token: string, requestBody: unknown): Promise<HookOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH, '--port', String(port), '--token', token])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`hook exited ${code}: ${stderr}`)); return }
      try { resolve(JSON.parse(stdout.trim())) }
      catch (err) { reject(new Error(`bad hook output: ${stdout} (${(err as Error).message})`)) }
    })
    child.stdin.end(JSON.stringify(requestBody))
  })
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(address && typeof address === 'object' ? address.port : 0)
    })
  })
}

describe('permission-hook.cjs', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server) { await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined }
  })

  it('prints allow JSON when the server answers allow', async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision: 'allow', reason: 'looks fine' }))
      })
    })
    const port = await listen(server)

    const output = await runHook(port, 'a-token', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: '1' })
    expect(output.hookSpecificOutput.hookEventName).toBe('PermissionRequest')
    expect(output.hookSpecificOutput.decision).toBe('allow')
    expect(output.hookSpecificOutput.decisionReason).toBe('looks fine')
  })

  it('forwards the bearer token and the stdin body to the server', async () => {
    let receivedAuth: string | undefined
    let receivedBody = ''
    server = createServer((req, res) => {
      receivedAuth = req.headers.authorization
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny', reason: 'no' }))
      })
    })
    const port = await listen(server)

    await runHook(port, 'secret-token', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: '2' })
    expect(receivedAuth).toBe('Bearer secret-token')
    expect(JSON.parse(receivedBody)).toEqual({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: '2' })
  })

  it('prints deny JSON when the server is unreachable', async () => {
    server = createServer((_req, res) => res.end('unused'))
    const port = await listen(server)
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined

    const output = await runHook(port, 'a-token', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: '3' })
    expect(output.hookSpecificOutput.hookEventName).toBe('PermissionRequest')
    expect(output.hookSpecificOutput.decision).toBe('deny')
    expect(output.hookSpecificOutput.decisionReason.length).toBeGreaterThan(0)
  })
})
