import type { ChatActivityPayload, ChatDonePayload, ChatStatusPayload } from '../shared/ipc'
import type { PackData } from '../shared/types'
import type { BuddyActions } from './actions'
import type { Brain } from './brain/types'
import type { ChatPort } from './ipc'
import { HELP_TEXT, parseCommand, type Command } from './commands'
import { pickLine } from './pack'

export interface ChatOut {
  delta(text: string): void
  activity(a: ChatActivityPayload): void
  done(d: ChatDonePayload): void
  system(text: string): void
  status(s: ChatStatusPayload): void
}
export interface ChatSettings { workspace: string; model: string | null; sessionId: string | null }

export class ChatController implements ChatPort {
  private running = false
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
      case 'goto': void a.goTo(cmd.x, { run: cmd.run }); break
      case 'mood': a.setMood(cmd.mood); break
      case 'emote': void a.emote(cmd.emote); break
      case 'sleep': a.sleep(); break
      case 'wake': a.wake(); break
      case 'stop': this.stop(); break
      case 'help': this.deps.out.system(HELP_TEXT); break
      case 'new': this.settings.sessionId = null; this.settingsChanged(); break
      case 'cd': this.settings.workspace = cmd.path; this.settingsChanged(); break
      case 'model': this.settings.model = cmd.model; this.settingsChanged(); break
    }
  }

  private async ask(text: string): Promise<void> {
    this.running = true
    try {
      const ctx = { state: this.deps.actions.getState(), workspace: this.settings.workspace,
        model: this.settings.model, sessionId: this.settings.sessionId }
      for await (const ev of this.deps.brain.respond(text, ctx)) {
        if (ev.type === 'text') this.deps.out.delta(ev.delta)
        else if (ev.type === 'activity') this.deps.out.activity({ id: ev.id, label: ev.label, done: ev.done ?? false })
        else if (ev.type === 'status') this.deps.out.system(ev.text)
        else if (ev.type === 'done') {
          if (ev.sessionId) { this.settings.sessionId = ev.sessionId; this.settingsChanged() }
          if (ev.error) this.deps.out.system(`${pickLine(this.deps.pack, 'error') ?? 'Error.'} ${ev.error}`)
          this.deps.out.done({ error: ev.error })
        }
      }
    } catch (e) {
      this.deps.out.system(`${pickLine(this.deps.pack, 'error') ?? 'Error.'} ${(e as Error).message}`)
      this.deps.out.done({ error: (e as Error).message })
    } finally {
      this.running = false
    }
  }

  permissionAnswer(_id: string, _allow: boolean): void { /* Plan B */ }
  stop(): void { this.deps.brain.stop() }
}
