import type { ChatActivityPayload, ChatDonePayload, ChatReadbackPayload, ChatStatusPayload } from '../shared/ipc'
import type { Expression, PackData } from '../shared/types'
import type { BuddyActions } from './actions'
import type { ReadbackResult } from './brain/readback'
import type { Brain } from './brain/types'
import type { ChatPort } from './ipc'
import { HELP_TEXT, parseCommand, type Command } from './commands'
import { pickLine } from './pack'

export interface ChatOut {
  delta(text: string): void
  activity(a: ChatActivityPayload): void
  done(d: ChatDonePayload): void
  system(text: string, expression?: Expression): void
  status(s: ChatStatusPayload): void
  readback(p: ChatReadbackPayload): void
}
export interface ChatSettings { workspace: string; model: string | null; sessionId: string | null }

export class ChatController implements ChatPort {
  private running = false
  private turnSerial = 0
  private messageSerial = 0
  private currentExpression: Expression = 'neutral'
  // Permission requests the local server is waiting on: keyed by the hook's tool_use_id,
  // resolved by permissionAnswer() once the user answers the card in the panel.
  private readonly pendingPermissions = new Map<string, (d: { allow: boolean; reason: string; remember?: boolean }) => void>()
  private readonly settings: ChatSettings
  constructor(private readonly deps: { brain: Brain; actions: BuddyActions; pack: PackData; out: ChatOut;
    settings: ChatSettings; onSettingsChange?: (s: ChatSettings) => void;
    readback?: { run(text: string): Promise<ReadbackResult> }; log?: (line: string) => void }) {
    this.settings = { ...deps.settings }
  }
  get busy(): boolean { return this.running }
  status(): ChatStatusPayload {
    return { model: this.settings.model, workspace: this.settings.workspace, session: this.settings.sessionId ?? 'new', readback: Boolean(this.deps.readback) }
  }
  private settingsChanged(): void {
    this.deps.onSettingsChange?.({ ...this.settings })
    this.deps.out.status(this.status())
  }
  prompt(text: string): void {
    const parsed = parseCommand(text)
    if (parsed.ok) { this.run(parsed.command); return }
    if ('error' in parsed) { this.deps.out.system(parsed.error); return }
    if (this.running) { this.deps.out.system('Still working. Use /stop to abort the current rite.'); return }
    void this.ask(text.trim())
  }

  private run(cmd: Command): void {
    const a = this.deps.actions
    switch (cmd.kind) {
      case 'goto':
        void a.goTo(cmd.x, { run: cmd.run })
        this.deps.out.system(`${cmd.run ? 'running' : 'moving'} to ${Math.round(cmd.x * 100)}%`)
        break
      case 'mood':
        a.setMood(cmd.mood)
        this.deps.out.system(`mood: ${cmd.mood}`)
        break
      case 'emote':
        void a.emote(cmd.emote)
        this.deps.out.system(`emote: ${cmd.emote}`)
        break
      case 'sleep':
        a.sleep()
        this.deps.out.system('sleeping')
        break
      case 'wake':
        a.wake()
        this.deps.out.system('awake')
        break
      case 'stop':
        this.stop()
        this.deps.out.system(pickLine(this.deps.pack, 'stopped') ?? 'stopped')
        break
      case 'help': this.deps.out.system(HELP_TEXT); break
      case 'new':
        this.turnSerial++; this.settings.sessionId = null; this.settingsChanged()
        this.deps.out.system('new session')
        break
      case 'cd':
        this.settings.workspace = cmd.path; this.settingsChanged()
        this.deps.out.system(`workspace: ${cmd.path}`)
        break
      case 'model':
        this.settings.model = cmd.model; this.settingsChanged()
        this.deps.out.system(`model: ${cmd.model ?? 'default'}`)
        break
    }
  }

  private async ask(text: string): Promise<void> {
    this.running = true
    const serial = this.turnSerial
    const id = ++this.messageSerial
    let reply = ''
    this.currentExpression = 'neutral'
    try {
      const ctx = { state: this.deps.actions.getState(), workspace: this.settings.workspace,
        model: this.settings.model, sessionId: this.settings.sessionId }
      for await (const ev of this.deps.brain.respond(text, ctx)) {
        if (ev.type === 'text') { this.deps.out.delta(ev.delta); reply += ev.delta }
        else if (ev.type === 'activity') this.deps.out.activity({ id: ev.id, label: ev.label, done: ev.done ?? false })
        else if (ev.type === 'status') this.deps.out.system(ev.text, ev.expression)
        else if (ev.type === 'expression') this.currentExpression = ev.name
        else if (ev.type === 'done') {
          if (ev.sessionId && serial === this.turnSerial) { this.settings.sessionId = ev.sessionId; this.settingsChanged() }
          // A user-initiated /stop already posted the pack's "stopped" line synchronously
          // (see the 'stop' case in run()); the killed child's own done event still carries
          // an error ("stopped (exit code ...)"), but it must not also post the pack's error
          // line, or a stop would show two lines instead of one.
          if (ev.error && !ev.stopped) this.deps.out.system(`${pickLine(this.deps.pack, 'error') ?? 'Error.'} ${ev.error}`, 'sadness')
          const willReadback = !ev.error && reply.trim().length > 0 && Boolean(this.deps.readback)
          this.deps.out.done({ id, error: ev.error, expression: this.currentExpression, readback: willReadback })
          if (willReadback) void this.readback(id, reply)
        }
      }
    } catch (e) {
      this.deps.out.system(`${pickLine(this.deps.pack, 'error') ?? 'Error.'} ${(e as Error).message}`, 'sadness')
      this.deps.out.done({ id, error: (e as Error).message, expression: this.currentExpression, readback: false })
    } finally {
      this.running = false
    }
  }

  // Fire and forget: the next turn may start while this runs, and a failure only logs.
  private async readback(id: number, text: string): Promise<void> {
    let result: ReadbackResult
    try { result = await this.deps.readback!.run(text) } catch (e) { result = { ok: false, reason: (e as Error).message } }
    if (result.ok) { this.deps.out.readback({ id, text: result.text }); return }
    this.deps.log?.(`readback failed: ${result.reason}`)
    // The bubble is waiting on this id; tell it to settle to the plain text now.
    this.deps.out.readback({ id, failed: true })
  }

  // Called by the local server's onPermission callback (bound in main/index.ts) once it has
  // shown the permission card; resolves when the user answers, or never, if the server's own
  // timeout fires first and answers the hook on its own.
  awaitPermissionAnswer(id: string): Promise<{ allow: boolean; reason: string; remember?: boolean }> {
    return new Promise((resolve) => { this.pendingPermissions.set(id, resolve) })
  }
  // Called by main/index.ts's onPermissionTimeout once the server's own timeout has already
  // answered "deny" on the wire. Settles the pending promise with a deny so anything waiting
  // on it (the one-at-a-time card queue in main) moves on, and posts nothing: the caller
  // owns dismissing the card and the status line.
  expirePermission(id: string): void {
    const resolve = this.pendingPermissions.get(id)
    if (!resolve) return
    this.pendingPermissions.delete(id)
    resolve({ allow: false, reason: 'timed out' })
  }
  // remember is only ever honored when the answer is allow: a deny is never remembered, no
  // matter what the caller passes (there is no "deny this session" button, but a stray true
  // here must still not poison the session allow-list).
  permissionAnswer(id: string, allow: boolean, remember = false): void {
    const resolve = this.pendingPermissions.get(id)
    if (!resolve) return
    this.pendingPermissions.delete(id)
    if (!allow) this.deps.out.system(pickLine(this.deps.pack, 'permissionDenied') ?? 'Denied.', 'anger')
    resolve({ allow, reason: allow ? 'user allowed' : 'user denied', remember: allow && remember ? true : undefined })
  }
  // Called directly by the local server's set_expression tool during a turn (buddy tool
  // calls never reach the stream parser, so this is the only path an in-turn expression
  // change has - BrainEvent{type:'expression'} still works too, for the echo brain).
  setExpression(name: Expression): void { this.currentExpression = name }
  stop(): void { this.deps.brain.stop() }
}
