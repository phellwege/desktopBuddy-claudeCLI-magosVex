import type { AnimationKey, Animations, BuddyState, Expression, PackTheme, Point, Rect } from './types'

export const CH = {
  packLoaded: 'pack:loaded',
  buddyState: 'buddy:state',
  overlayStage: 'overlay:stage',
  overlayReady: 'overlay:ready',
  overlayHover: 'overlay:hover',
  overlayClick: 'overlay:click',
  overlayContextMenu: 'overlay:contextMenu',
  overlayArrived: 'overlay:arrived',
  overlayOneShotDone: 'overlay:oneShotDone',
  overlayOrigin: 'overlay:origin',
  hologramOrigin: 'hologram:origin',
  hologramHover: 'hologram:hover',
  theme: 'theme',
  chatDelta: 'chat:delta',
  chatActivity: 'chat:activity',
  chatDone: 'chat:done',
  chatReadback: 'chat:readback',
  chatPermission: 'chat:permission',
  chatStatus: 'chat:status',
  chatSystem: 'chat:system',
  chatClear: 'chat:clear',
  hologramReady: 'hologram:ready',
  chatPrompt: 'chat:prompt',
  chatPermissionAnswer: 'chat:permissionAnswer',
  chatClose: 'chat:close',
  chatStop: 'chat:stop',
} as const

export interface PackLoadedPayload { atlasUrl: string; atlasJsonUrl: string; animations: Animations; scale: number; name: string; faces: Record<Expression, string> | null }
export interface BuddyStatePayload { state: BuddyState; animation: AnimationKey; speed: number }
// Where the overlay window sits on the virtual desktop, and which display's floor the
// character rests on while it is there. Sent whenever the window is re-bound: on startup,
// on a display change, and at both ends of a flight (expanded to span two displays, then
// collapsed back to a strip). The renderer needs it because character positions are
// absolute virtual coordinates while CSS transforms are window-relative.
export interface StagePayload { origin: Point; wa: Rect; charW: number }
export interface ChatDeltaPayload { text: string }
export interface ChatActivityPayload { id: string; label: string; done: boolean }
// readback: true when main will follow this reply with a chat:readback for the same id.
export interface ChatDonePayload { id: number; error?: string; expression?: Expression; readback?: boolean }
// text on success; failed when the call failed, timed out, or returned nothing.
export interface ChatReadbackPayload { id: number; text?: string; failed?: true }
// A normal card carries toolName/summary/line; a dismiss carries only the id, telling the
// renderer to hide the card if it is still showing that same request (the server's own
// permission timeout already answered "deny" on the wire by the time this arrives).
export interface ChatPermissionPayload { id: string; toolName?: string; summary?: string; line?: string; dismiss?: boolean }
export interface ChatStatusPayload { model: string | null; workspace: string; session: string; error?: string; readback?: boolean }
export interface ChatSystemPayload { text: string; expression?: Expression }
export interface ThemePayload extends PackTheme { name: string }
export interface OriginPayload { x: number; y: number; xFraction: number }

export interface BuddyBridge {
  onPackLoaded(cb: (p: PackLoadedPayload) => void): () => void
  onBuddyState(cb: (p: BuddyStatePayload) => void): () => void
  onOverlayStage(cb: (p: StagePayload) => void): () => void
  overlayReady(): void
  hover(over: boolean): void
  click(): void
  /** x, y are window-content (client) coordinates, not screen coordinates - main passes
   * them straight through to Menu.popup({ window, x, y }), which expects the former. */
  contextMenu(x: number, y: number): void
  arrived(): void
  oneShotDone(): void
  /** x, y are screen coordinates - the overlay's own window position plus the drawn
   * origin point, so main can translate it into any other window's content coordinates.
   * xFraction is the character's live x fraction (motion.x), which may be mid-walk and
   * ahead of Buddy.x (which only updates on arrival) - it lets main re-place the hologram
   * under a walking character instead of waiting for the walk to finish. */
  origin(x: number, y: number, xFraction: number): void
  onOrigin(cb: (p: OriginPayload) => void): () => void
  onTheme(cb: (p: ThemePayload) => void): () => void
  onChatDelta(cb: (p: ChatDeltaPayload) => void): () => void
  onChatActivity(cb: (p: ChatActivityPayload) => void): () => void
  onChatDone(cb: (p: ChatDonePayload) => void): () => void
  onChatReadback(cb: (p: ChatReadbackPayload) => void): () => void
  onChatPermission(cb: (p: ChatPermissionPayload) => void): () => void
  onChatStatus(cb: (p: ChatStatusPayload) => void): () => void
  onChatSystem(cb: (p: ChatSystemPayload) => void): () => void
  onChatClear(cb: () => void): () => void
  hologramReady(): void
  hologramHover(over: boolean): void
  prompt(text: string): void
  permissionAnswer(id: string, allow: boolean, remember?: boolean): void
  closePanel(): void
  stop(): void
}

declare global { interface Window { buddy: BuddyBridge } }
