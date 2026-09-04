import type { AnimationKey, Animations, BuddyState, PackTheme } from './types'

export const CH = {
  packLoaded: 'pack:loaded',
  buddyState: 'buddy:state',
  overlayReady: 'overlay:ready',
  overlayHover: 'overlay:hover',
  overlayClick: 'overlay:click',
  overlayContextMenu: 'overlay:contextMenu',
  overlayArrived: 'overlay:arrived',
  overlayOneShotDone: 'overlay:oneShotDone',
  theme: 'theme',
  chatDelta: 'chat:delta',
  chatActivity: 'chat:activity',
  chatDone: 'chat:done',
  chatPermission: 'chat:permission',
  chatStatus: 'chat:status',
  chatSystem: 'chat:system',
  hologramReady: 'hologram:ready',
  chatPrompt: 'chat:prompt',
  chatPermissionAnswer: 'chat:permissionAnswer',
  chatClose: 'chat:close',
  chatStop: 'chat:stop',
} as const

export interface PackLoadedPayload { atlasUrl: string; atlasJsonUrl: string; animations: Animations; scale: number; name: string }
export interface BuddyStatePayload { state: BuddyState; animation: AnimationKey; speed: number }
export interface ChatDeltaPayload { text: string }
export interface ChatActivityPayload { id: string; label: string; done: boolean }
export interface ChatDonePayload { error?: string }
export interface ChatPermissionPayload { id: string; toolName: string; summary: string; line: string }
export interface ChatStatusPayload { model: string | null; workspace: string; session: string; error?: string }
export interface ChatSystemPayload { text: string }
export interface ThemePayload extends PackTheme { name: string }

export interface BuddyBridge {
  onPackLoaded(cb: (p: PackLoadedPayload) => void): () => void
  onBuddyState(cb: (p: BuddyStatePayload) => void): () => void
  overlayReady(): void
  hover(over: boolean): void
  click(): void
  /** x, y are window-content (client) coordinates, not screen coordinates - main passes
   * them straight through to Menu.popup({ window, x, y }), which expects the former. */
  contextMenu(x: number, y: number): void
  arrived(): void
  oneShotDone(): void
  onTheme(cb: (p: ThemePayload) => void): () => void
  onChatDelta(cb: (p: ChatDeltaPayload) => void): () => void
  onChatActivity(cb: (p: ChatActivityPayload) => void): () => void
  onChatDone(cb: (p: ChatDonePayload) => void): () => void
  onChatPermission(cb: (p: ChatPermissionPayload) => void): () => void
  onChatStatus(cb: (p: ChatStatusPayload) => void): () => void
  onChatSystem(cb: (p: ChatSystemPayload) => void): () => void
  hologramReady(): void
  prompt(text: string): void
  permissionAnswer(id: string, allow: boolean): void
  closePanel(): void
  stop(): void
}

declare global { interface Window { buddy: BuddyBridge } }
