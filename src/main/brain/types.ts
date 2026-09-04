import type { BuddyState, Expression } from '../../shared/types'

export interface BrainContext { state: BuddyState; workspace: string; model: string | null; sessionId: string | null }
export type BrainEvent =
  | { type: 'text'; delta: string }
  | { type: 'activity'; id: string; label: string; toolName: string; done?: boolean }
  | { type: 'status'; text: string; expression?: Expression }
  | { type: 'expression'; name: Expression }
  | { type: 'done'; sessionId?: string; error?: string; stopped?: boolean }
export interface Brain { respond(prompt: string, ctx: BrainContext): AsyncIterable<BrainEvent>; stop(): void }
