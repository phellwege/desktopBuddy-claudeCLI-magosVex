// Shared types for the buddy app; no runtime dependencies.
export type Activity = 'idle' | 'walking' | 'running' | 'hopping' | 'sitting' |
  'sleeping' | 'looking' | 'projecting' | 'emoting'
export type Mood = 'calm' | 'happy' | 'thinking' | 'confused' | 'alarmed'
export type Facing = 'left' | 'right'
export type EmoteKind = 'happy' | 'thinking' | 'confused' | 'alarmed' | 'look' | 'hop'
export type AnimationKey = 'idle' | 'walk' | 'run' | 'hop' | 'fall' | 'sit' | 'sleep' |
  'look' | 'project' | 'emote_happy' | 'emote_thinking' | 'emote_confused' | 'emote_alarmed'
export interface BuddyState { x: number; facing: Facing; activity: Activity; mood: Mood;
  panelOpen: boolean; asleep: boolean; targetX?: number }
export interface AtlasFrame { x: number; y: number; w: number; h: number; ax: number; ay: number; origin?: [number, number] }
export interface Atlas { image: string; maxFrameSize: [number, number]; frames: Record<string, AtlasFrame> }
export interface AnimationDef { right: string[]; left: string[]; fps: number; loop: boolean; mirrorLeft: boolean }
export type Animations = Record<AnimationKey, AnimationDef>
export interface PackTheme { accent: string; glow: string; background: string; text: string; font: string; glyph: string }
export type LineKey = 'greeting' | 'idleMutter' | 'thinking' | 'toolRunning' | 'permissionAsk' |
  'permissionDenied' | 'authError' | 'cliMissing' | 'error' | 'sleep' | 'wake' | 'stopped'
export interface PackData { dir: string; name: string; scale: number; theme: PackTheme;
  persona: { prompt: string; defaultMood: Mood; lines: Record<LineKey, string[]> };
  atlas: Atlas; animations: Animations }
export const WALK_SPEED = 0.08
export const RUN_SPEED = 0.25
