// Shared types for the buddy app; no runtime dependencies.
export type Activity = 'idle' | 'walking' | 'running' | 'hopping' | 'sitting' |
  'sleeping' | 'looking' | 'projecting' | 'emoting' | 'hovering'
export type Mood = 'calm' | 'happy' | 'thinking' | 'confused' | 'alarmed'
export type Expression = 'neutral' | 'happy' | 'disbelief' | 'irritation' | 'anger' |
  'love' | 'sadness' | 'cringe' | 'begging'
export const EXPRESSIONS: readonly Expression[] =
  ['neutral', 'happy', 'disbelief', 'irritation', 'anger', 'love', 'sadness', 'cringe', 'begging']
export type Facing = 'left' | 'right'
export type EmoteKind = 'happy' | 'thinking' | 'confused' | 'alarmed' | 'look' | 'hop'
export type AnimationKey = 'idle' | 'walk' | 'run' | 'hop' | 'fall' | 'sit' | 'sleep' |
  'look' | 'project' | 'hover' | 'emote_happy' | 'emote_thinking' | 'emote_confused' | 'emote_alarmed'

// A point on the virtual desktop, in device-independent pixels. Regularly negative: a
// display placed above or left of the primary has a negative origin.
export interface Point { x: number; y: number }
// A rectangle on the virtual desktop: a display's work area, or a window's bounds.
export interface Rect { x: number; y: number; width: number; height: number }
// One stage of a journey. `to` is the character's floor-center point at the end of the
// leg. A walk holds the display's floor; a fly crosses the gap between two displays.
export type Leg =
  | { kind: 'walk'; to: Point; run: boolean }
  | { kind: 'fly'; to: Point; hop: boolean }
// A leg annotated with where he stands once it completes, so the state machine can update
// itself without knowing anything about display geometry.
export type PlannedLeg = Leg & { display: number; fraction: number; facing: Facing }

export interface BuddyState { x: number; display: number; facing: Facing; activity: Activity;
  mood: Mood; panelOpen: boolean; asleep: boolean; targetX?: number; leg?: PlannedLeg }
export interface AtlasFrame { x: number; y: number; w: number; h: number; ax: number; ay: number; origin?: [number, number] }
export interface Atlas { image: string; maxFrameSize: [number, number]; frames: Record<string, AtlasFrame> }
// repeat: how many times a one-shot animation plays before it reports finishing. Only
// meaningful when loop is false; a short emote needs a few passes to be noticed at all.
export interface AnimationDef { right: string[]; left: string[]; fps: number; loop: boolean; mirrorLeft: boolean; repeat: number }
export type Animations = Record<AnimationKey, AnimationDef> & { faces?: Partial<Record<Expression, string>> }
export interface PackTheme { accent: string; glow: string; background: string; text: string; font: string; glyph: string }
export type LineKey = 'greeting' | 'idleMutter' | 'thinking' | 'toolRunning' | 'permissionAsk' |
  'permissionDenied' | 'authError' | 'cliMissing' | 'error' | 'sleep' | 'wake' | 'stopped'
export interface PackData { dir: string; name: string; scale: number; theme: PackTheme;
  persona: { prompt: string; defaultMood: Mood; lines: Record<LineKey, string[]> };
  atlas: Atlas; animations: Animations; faces: Record<Expression, string> | null }
// Pixels per second. These were fractions of the walk band per second (0.08 and 0.25),
// which on a 1920 px display with a 200 px character worked out to about these values.
// Multi-monitor made the old unit a bug: the same fraction crosses a 5120 px ultrawide
// 2.7x faster in pixels, fast enough to be unusable.
export const WALK_SPEED = 140
export const RUN_SPEED = 430
// Airborne speed along a fly leg, whether that leg is a seam hop, a vertical rise, or a
// long diagonal. Faster than a run: he is covering the gap between two displays.
export const FLY_SPEED = 700
