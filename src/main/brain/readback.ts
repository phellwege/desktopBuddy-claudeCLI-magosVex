// Readback: a second, tool-less CLI call that restates the main turn's reply in the pack's
// persona for the hologram's spoken voice. One process per call; never touches the main
// turn's session or workspace CLAUDE.md (see docs/superpowers/specs
// /2026-09-04-readback-layer-design.md section 4).
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { childEnv } from './claude-cli'
import { killTree } from './process'

export const READBACK_INSTRUCTION =
  'You are the voice layer of a desktop assistant. The user\'s message below is a reply the ' +
  'assistant just gave, written in plain language. Restate its substance in your own character ' +
  'in at most three short sentences. Add no facts and answer nothing new. Keep file names, ' +
  'commands, and numbers exactly as written. Use no code blocks, lists, or headings. If the reply ' +
  'is only code, say what the code does. Output the restatement and nothing else.'
export const READBACK_MAX_CHARS = 12000
export const READBACK_TIMEOUT_MS = 20000

export interface ReadbackDeps {
  cliPath: string
  persona: string
  scratchDir: string
  spawn?: typeof nodeSpawn // injectable for tests
  env?: NodeJS.ProcessEnv
  argsPrefix?: string[] // BUDDY_CLI_ARGS test hook, same as the brain
  timeoutMs?: number
}
export type ReadbackResult = { ok: true; text: string } | { ok: false; reason: string }

export function buildReadbackArgs(persona: string): string[] {
  return [
    '-p', '--output-format', 'json', '--model', 'haiku',
    '--setting-sources', 'project', '--no-session-persistence',
    '--system-prompt', `${persona}\n\n${READBACK_INSTRUCTION}`,
    '--tools', '', '--strict-mcp-config',
  ]
}

export function truncateInput(text: string): string {
  return text.length <= READBACK_MAX_CHARS ? text : text.slice(0, READBACK_MAX_CHARS) + ' [truncated]'
}

export function parseReadbackOutput(stdout: string): ReadbackResult {
  let parsed: unknown
  try { parsed = JSON.parse(stdout.trim()) } catch { return { ok: false, reason: 'malformed JSON' } }
  const o = parsed as { type?: string; subtype?: string; is_error?: boolean; result?: unknown }
  if (o.is_error === true) return { ok: false, reason: `is_error: ${String(o.result).slice(0, 120)}` }
  if (o.subtype !== 'success') return { ok: false, reason: `subtype ${o.subtype ?? 'missing'}` }
  const text = typeof o.result === 'string' ? o.result.trim() : ''
  return text ? { ok: true, text } : { ok: false, reason: 'empty result' }
}

export class Readback {
  private readonly children = new Set<ChildProcess>()
  constructor(private readonly deps: ReadbackDeps) {}

  run(text: string): Promise<ReadbackResult> {
    return new Promise((resolve) => {
      const spawnFn = this.deps.spawn ?? nodeSpawn
      const env = this.deps.env ?? childEnv(process.env)
      const timeoutMs = this.deps.timeoutMs ?? READBACK_TIMEOUT_MS
      try { mkdirSync(this.deps.scratchDir, { recursive: true }) } catch { /* the spawn below reports a missing cwd */ }
      const args = [...(this.deps.argsPrefix ?? []), ...buildReadbackArgs(this.deps.persona)]
      let child: ChildProcess
      try {
        child = spawnFn(this.deps.cliPath, args, { cwd: this.deps.scratchDir, env, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (e) {
        resolve({ ok: false, reason: (e as Error).message }); return
      }
      this.children.add(child)
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (r: ReadbackResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.children.delete(child)
        resolve(r)
      }
      const timer = setTimeout(() => { killTree(child); finish({ ok: false, reason: `timeout after ${timeoutMs} ms` }) }, timeoutMs)
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      child.on('error', (e: NodeJS.ErrnoException) => finish({ ok: false, reason: `${e.code ?? 'spawn error'}: ${e.message}` }))
      child.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          const tail = stderr.trim().split('\n').slice(-3).join(' | ')
          finish({ ok: false, reason: `exit code ${code ?? 'null'}${tail ? ': ' + tail : ''}` }); return
        }
        finish(parseReadbackOutput(stdout))
      })
      child.stdin?.on('error', () => { /* the child exited before reading; close() reports it */ })
      child.stdin?.end(truncateInput(text))
    })
  }

  stopAll(): void {
    for (const child of this.children) killTree(child)
    this.children.clear()
  }
}
