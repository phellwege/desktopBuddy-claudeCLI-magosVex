// Claude Code CLI brain: one process per turn. Spawns the installed CLI in print mode with
// stream-json output, feeds it the prompt over stdin, and turns each line of stdout into
// BrainEvents via parseStreamLine. No persona lives here; the tools note (prompt.ts) is the
// only system-prompt addition, and the CLI's own output is shown unaltered.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Mood } from '../../shared/types'
import type { LocalServer } from '../server'
import { isAuthError, parseStreamLine } from './stream'
import { toolsNote } from './prompt'
import type { Brain, BrainContext, BrainEvent } from './types'

export interface ClaudeCliDeps {
  cliPath: string
  workspace: string
  extraDirs: string[]
  model: string | null
  allowedTools: string[]
  server: LocalServer
  hookPath: string
  lines: { authError?: string[]; cliMissing?: string[]; error?: string[] }
  onMood(mood: Mood | 'restore'): void
  spawn?: typeof nodeSpawn // injectable for tests
  env?: NodeJS.ProcessEnv
}

type SpawnFn = typeof nodeSpawn

export function buildArgs(d: ClaudeCliDeps, sessionId: string | null, newSessionId: string): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose']
  if (sessionId) args.push('--resume', sessionId)
  else args.push('--session-id', newSessionId)
  args.push('--append-system-prompt', toolsNote())
  args.push('--mcp-config', d.server.mcpConfig())
  args.push('--strict-mcp-config')
  args.push('--allowedTools', d.allowedTools.join(' '))
  args.push('--permission-mode', 'manual')
  args.push('--settings', d.server.hookSettings(d.hookPath))
  if (d.model) args.push('--model', d.model)
  for (const dir of d.extraDirs) args.push('--add-dir', dir)
  return args
}

// The child's environment is the parent's minus the two variables that would make the CLI
// think it is already running inside Claude Code, or push it onto API-key billing instead
// of the subscription login this brain relies on.
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.CLAUDECODE
  delete env.ANTHROPIC_API_KEY
  return env
}

function pickLine(lines: string[] | undefined): string | undefined {
  if (!lines || lines.length === 0) return undefined
  return lines[Math.floor(Math.random() * lines.length)]
}

// A minimal push queue: child-process listeners (data/close/error) push items from their own
// callbacks, and the generator's for-await pulls them in order, awaiting when empty. Reading
// stops for good once end() is called; anything already queued before that is still delivered.
class EventChannel<T> {
  private readonly queue: T[] = []
  private waiting: ((r: IteratorResult<T>) => void) | null = null
  private ended = false

  push(item: T): void {
    if (this.ended) return
    const waiting = this.waiting
    if (waiting) { this.waiting = null; waiting({ value: item, done: false }) }
    else this.queue.push(item)
  }
  end(): void {
    this.ended = true
    if (this.waiting) { const waiting = this.waiting; this.waiting = null; waiting({ value: undefined as unknown as T, done: true }) }
  }
  private next(): Promise<IteratorResult<T>> {
    const item = this.queue.shift()
    if (item !== undefined) return Promise.resolve({ value: item, done: false })
    if (this.ended) return Promise.resolve({ value: undefined as unknown as T, done: true })
    return new Promise((resolve) => { this.waiting = resolve })
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() }
  }
}

type Item =
  | { kind: 'line'; line: string }
  | { kind: 'spawnError'; error: NodeJS.ErrnoException }
  | { kind: 'close'; code: number | null }

export class ClaudeCliBrain implements Brain {
  private child: ChildProcess | null = null
  private stopped = false

  constructor(private readonly deps: ClaudeCliDeps) {}

  async *respond(prompt: string, ctx: BrainContext): AsyncIterable<BrainEvent> {
    this.stopped = false
    const spawnFn: SpawnFn = this.deps.spawn ?? nodeSpawn
    const newSessionId = randomUUID()
    // /cd and /model change the workspace and model for the next turn (spec 6.5); ctx carries
    // ChatController's live settings on every call, so it wins over the deps this brain was
    // constructed with.
    const workspace = ctx.workspace
    const args = buildArgs({ ...this.deps, model: ctx.model }, ctx.sessionId, newSessionId)
    const env = childEnv(this.deps.env ?? process.env)

    const channel = new EventChannel<Item>()
    let stdoutRemainder = ''
    const stderrLines: string[] = []
    let sessionIdFromInit: string | undefined
    let sawActivity = false
    let doneEmitted = false

    const child = spawnFn(this.deps.cliPath, args, { cwd: workspace, env })
    this.child = child

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutRemainder += chunk.toString('utf8')
      const lines = stdoutRemainder.split('\n')
      stdoutRemainder = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) channel.push({ kind: 'line', line })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) stderrLines.push(line.trim())
    })
    child.on('error', (error: NodeJS.ErrnoException) => { channel.push({ kind: 'spawnError', error }); channel.end() })
    child.on('close', (code) => {
      if (stdoutRemainder.trim()) channel.push({ kind: 'line', line: stdoutRemainder })
      channel.push({ kind: 'close', code })
      channel.end()
    })

    child.stdin?.write(prompt)
    child.stdin?.end()

    try {
      for await (const item of channel) {
        if (item.kind === 'line') {
          for (const out of parseStreamLine(item.line)) {
            switch (out.type) {
              case 'ignore': break
              case 'init': sessionIdFromInit = out.init.sessionId; break
              case 'text': yield out; break
              case 'activity':
                if (!sawActivity) { sawActivity = true; this.deps.onMood('thinking') }
                yield out
                break
              case 'done': {
                doneEmitted = true
                if (out.error && isAuthError(out.error)) {
                  const authLine = pickLine(this.deps.lines.authError)
                  if (authLine) yield { type: 'status', text: authLine, expression: 'sadness' }
                }
                yield { type: 'done', sessionId: out.sessionId ?? sessionIdFromInit, error: out.error }
                // The result line is terminal: nothing after it belongs to this turn.
                return
              }
              default: break
            }
          }
        } else if (item.kind === 'spawnError') {
          doneEmitted = true
          if (item.error.code === 'ENOENT') {
            const missingLine = pickLine(this.deps.lines.cliMissing)
            if (missingLine) yield { type: 'status', text: missingLine, expression: 'sadness' }
          }
          yield { type: 'done', error: item.error.message }
          return
        } else if (item.kind === 'close' && !doneEmitted) {
          // The session id learned from init survives a stop or a crash, so the next turn
          // resumes the same conversation instead of starting over.
          if (this.stopped) {
            yield { type: 'done', sessionId: sessionIdFromInit, error: `stopped (exit code ${item.code ?? 'null'})` }
          } else {
            const tail = stderrLines.slice(-5).join('\n')
            yield { type: 'done', sessionId: sessionIdFromInit, error: `exit code ${item.code ?? 'null'}${tail ? ': ' + tail : ''}` }
          }
        }
      }
    } finally {
      this.child = null
      this.deps.onMood('restore')
    }
  }

  stop(): void {
    this.stopped = true
    const child = this.child
    if (!child || child.pid === undefined) return
    if (process.platform === 'win32') nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    else child.kill()
  }
}
