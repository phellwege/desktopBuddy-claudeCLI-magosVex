import type { BuddyState, Expression } from '../../shared/types'
import type { UserContent } from './content'

export interface BrainContext { state: BuddyState; workspace: string; model: string | null; sessionId: string | null }
export type BrainEvent =
  | { type: 'text'; delta: string }
  | { type: 'activity'; id: string; label: string; toolName: string; done?: boolean }
  | { type: 'status'; text: string; expression?: Expression }
  | { type: 'expression'; name: Expression }
  | { type: 'done'; sessionId?: string; error?: string; stopped?: boolean }
export interface Brain {
  // prompt is the operator's text, or content blocks when images ride along (content.ts).
  respond(prompt: UserContent, ctx: BrainContext): AsyncIterable<BrainEvent>
  stop(): void
  // Hands a further user message to the turn that is running right now (the CLI gives it
  // to the model at its next tool boundary, or runs it as the next turn). Returns false
  // when there is nothing running that can take it; the caller then refuses the prompt.
  steer?(content: UserContent): boolean
}
