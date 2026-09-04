import type { ChatActivityPayload, ChatDonePayload, ChatStatusPayload } from '../shared/ipc'
import type { Expression, PackData } from '../shared/types'
import type { BuddyActions } from './actions'
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
}
export interface ChatSettings { workspace: string; model: string | null; sessionId: string | null }

export class ChatController implements ChatPort {
  private running = false
  private turnSerial = 0
  private currentExpression: Expression = 'neutral'
  private readonly settings: ChatSettings
  constructor(private readonly deps: { brain: Brain; actions: BuddyActions; pack: PackData; out: ChatOut;
    settings: ChatSettings; onSettingsChange?: (s: ChatSettings) => void }) {
    this.settings = { ...deps.settings }
  }
  get busy(): boolean { return this.running }
  status(): ChatStatusPayload {
    return { model: this.settings.model, workspace: this.settings.workspace, session: this.settings.sessionId ?? 'new' }
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
    this.currentExpression = 'neutral'
    try {
      const ctx = { state: this.deps.actions.getState(), workspace: this.settings.workspace,
        model: this.settings.model, sessionId: this.settings.sessionId }
      for await (const ev of this.deps.brain.respond(text, ctx)) {
        if (ev.type === 'text') this.deps.out.delta(ev.delta)
        else if (ev.type === 'activity') this.deps.out.activity({ id: ev.id, label: ev.label, done: ev.done ?? false })
        else if (ev.type === 'status') this.deps.out.system(ev.text)
        else if (ev.type === 'expression') this.currentExpression = ev.name
        else if (ev.type === 'done') {
          if (ev.sessionId && serial === this.turnSerial) { this.settings.sessionId = ev.sessionId; this.settingsChanged() }
          if (ev.error) this.deps.out.system(`${pickLine(this.deps.pack, 'error') ?? 'Error.'} ${ev.error}`, 'sadness')
          this.deps.out.done({ error: ev.error, expression: this.currentExpression })
        }
      }
    } catch (e) {
      this.deps.out.system(`${pickLine(this.deps.pack, 'error') ?? 'Error.'} ${(e as Error).message}`, 'sadness')
      this.deps.out.done({ error: (e as Error).message, expression: this.currentExpression })
    } finally {
      this.running = false
    }
  }

  permissionAnswer(_id: string, _allow: boolean): void { /* Plan B */ }
  stop(): void { this.deps.brain.stop() }
}
