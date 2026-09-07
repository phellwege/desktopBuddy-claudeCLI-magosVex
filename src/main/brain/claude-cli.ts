// Claude Code CLI brain: one process per turn. Spawns the installed CLI in print mode with
// stream-json in and out, feeds it the prompt as a user line, keeps stdin open so a running
// turn can be steered, and turns each line of stdout into BrainEvents via parseStreamLine.
// No persona lives here; the tools note (prompt.ts) is the only system-prompt addition, and
// the CLI's own output is shown unaltered.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Mood } from '../../shared/types'
import type { LocalServer } from '../server'
import { isAuthError, parseStreamLine } from './stream'
import { toolsNote } from './prompt'
import { killTree } from './process'
import type { Brain, BrainContext, BrainEvent } from './types'

export interface ClaudeCliDeps {
  cliPath: string
  workspace: string
  extraDirs: string[]
  model: string | null
  allowedTools: string[]
  permissionMode: 'acceptEdits' | 'manual'
  server: LocalServer
  lines: { authError?: string[]; cliMissing?: string[]; error?: string[] }
  onMood(mood: Mood | 'restore'): void
  spawn?: typeof nodeSpawn // injectable for tests
  // Placed before the CLI flags: lets an interpreter stand in for claude.exe in tests
  // (cliPath = node.exe, argsPrefix = [fake script]). Never set for a real CLI.
  argsPrefix?: string[]
  env?: NodeJS.ProcessEnv
  // How long, after the first result, to wait for a child that neither exits nor starts a
  // follow-on turn before the turn is declared done and the child left to itself.
  drainGraceMs?: number
}

type SpawnFn = typeof nodeSpawn

const DRAIN_GRACE_MS = 1500

export function buildArgs(d: ClaudeCliDeps, sessionId: string | null, newSessionId: string): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', '--verbose']
  // Keeps the user's own hooks and plugins out of the buddy's turns; --bare is not an option,
  // it drops the subscription login the CLI relies on.
  args.push('--setting-sources', 'project')
  if (sessionId) args.push('--resume', sessionId)
  else args.push('--session-id', newSessionId)
  args.push('--append-system-prompt', toolsNote())
  args.push('--mcp-config', d.server.mcpConfig())
  args.push('--strict-mcp-config')
  args.push('--allowedTools', d.allowedTools.join(' '))
  args.push('--permission-mode', d.permissionMode)
  // The CLI calls this MCP tool (registered on the same buddy server as mcp-config above) for
  // any tool not already covered by --allowedTools, instead of the withdrawn hook design.
  args.push('--permission-prompt-tool', 'mcp__buddy__permission_prompt')
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

// One stream-json user message, newline terminated: the shape the CLI reads from stdin
// under --input-format stream-json, both for the prompt and for a steer.
export function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
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
  | { kind: 'grace' }

export class ClaudeCliBrain implements Brain {
  private child: ChildProcess | null = null
  private stopped = false
  // True from the prompt going down stdin until the first result, when the brain ends stdin
  // so the child can drain whatever it queued and exit. steer() writes only while this holds.
  private stdinOpen = false

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
    // The most recent result line. Set at the first result (the turn boundary) and replaced
    // by any follow-on turn's result while the child drains; reported in the single done.
    let lastResult: { sessionId?: string; error?: string } | null = null
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const clearGrace = (): void => { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null } }
    const armGrace = (): void => {
      clearGrace()
      graceTimer = setTimeout(() => channel.push({ kind: 'grace' }), this.deps.drainGraceMs ?? DRAIN_GRACE_MS)
    }

    const child = spawnFn(this.deps.cliPath, [...(this.deps.argsPrefix ?? []), ...args], { cwd: workspace, env })
    this.child = child

    const onStdout = (chunk: Buffer): void => {
      stdoutRemainder += chunk.toString('utf8')
      const lines = stdoutRemainder.split('\n')
      stdoutRemainder = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) channel.push({ kind: 'line', line })
    }
    const onStderr = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) stderrLines.push(line.trim())
    }
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.on('error', (error: NodeJS.ErrnoException) => { channel.push({ kind: 'spawnError', error }); channel.end() })
    child.on('close', (code) => {
      clearGrace()
      if (stdoutRemainder.trim()) channel.push({ kind: 'line', line: stdoutRemainder })
      channel.push({ kind: 'close', code })
      channel.end()
    })

    // A child that already exited (or never started a real stdin pipe, as some fakes in
    // tests don't) can make this write fail with EPIPE/EOF; without a listener, Node treats
    // an 'error' event with no handler as an uncaught exception and crashes the process.
    child.stdin?.on('error', () => { /* ignore: the child is gone, nothing to write to */ })
    child.stdin?.write(userLine(prompt))
    // stdin stays open: steer() writes further user lines until the first result. Measured
    // CLI behaviour (spec section 2): a line written during a tool loop is handed to the
    // model at its next tool boundary; one written with no boundary left runs as the next
    // turn of the same process once stdin is closed.
    this.stdinOpen = true
    const endStdin = (): void => {
      if (!this.stdinOpen) return
      this.stdinOpen = false
      child.stdin?.end()
    }

    try {
      for await (const item of channel) {
        if (item.kind === 'line') {
          for (const out of parseStreamLine(item.line)) {
            switch (out.type) {
              case 'ignore': break
              case 'init':
                sessionIdFromInit = out.init.sessionId
                // An init after the first result is a queued steer running as its own turn:
                // wait for its result rather than declaring the turn done under it.
                clearGrace()
                break
              case 'text': yield out; break
              case 'activity':
                if (!sawActivity) { sawActivity = true; this.deps.onMood('thinking') }
                yield out
                break
              case 'done': {
                if (out.error && isAuthError(out.error)) {
                  const authLine = pickLine(this.deps.lines.authError)
                  if (authLine) yield { type: 'status', text: authLine, expression: 'sadness' }
                }
                // A result line is a turn boundary, not the end of the child. Close stdin
                // (the child then drains anything queued and exits) and keep reading; the
                // single done goes out at close, or after the grace if the child lingers.
                lastResult = { sessionId: out.sessionId ?? sessionIdFromInit, error: out.error }
                endStdin()
                armGrace()
                break
              }
              default: break
            }
          }
        } else if (item.kind === 'spawnError') {
          if (item.error.code === 'ENOENT') {
            const missingLine = pickLine(this.deps.lines.cliMissing)
            if (missingLine) yield { type: 'status', text: missingLine, expression: 'sadness' }
          }
          yield { type: 'done', error: item.error.message }
          return
        } else if (item.kind === 'grace') {
          // The child is still alive after its result with no follow-on turn (the real CLI
          // waits on background work this way). The reply is complete; leave the child to
          // finish on its own, as the code did before stdin was held open, and stop
          // listening to it.
          child.stdout?.off('data', onStdout)
          child.stderr?.off('data', onStderr)
          yield { type: 'done', sessionId: lastResult?.sessionId ?? sessionIdFromInit, error: lastResult?.error }
          return
        } else if (item.kind === 'close') {
          if (this.stopped) {
            // The session id learned from init survives a stop or a crash, so the next turn
            // resumes the same conversation instead of starting over.
            yield { type: 'done', sessionId: sessionIdFromInit, error: `stopped (exit code ${item.code ?? 'null'})`, stopped: true }
          } else if (lastResult) {
            yield { type: 'done', sessionId: lastResult.sessionId ?? sessionIdFromInit, error: lastResult.error }
          } else {
            const tail = stderrLines.slice(-5).join('\n')
            yield { type: 'done', sessionId: sessionIdFromInit, error: `exit code ${item.code ?? 'null'}${tail ? ': ' + tail : ''}` }
          }
        }
      }
    } finally {
      clearGrace()
      this.stdinOpen = false
      this.child = null
      this.deps.onMood('restore')
    }
  }

  // Writes one more user line to the running child. False when nothing is running or the
  // turn is already draining (stdin closed at its first result); never throws, the stdin
  // error listener above swallows a write to a child that has gone.
  steer(text: string): boolean {
    const child = this.child
    if (!child || !this.stdinOpen || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false
    child.stdin.write(userLine(text))
    return true
  }

  stop(): void {
    this.stopped = true
    const child = this.child
    if (!child) return
    killTree(child)
  }
}
