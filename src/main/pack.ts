import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { EXPRESSIONS } from '../shared/types'
import type { AnimationDef, AnimationKey, Animations, Expression, LineKey, PackData } from '../shared/types'

export const ANIMATION_KEYS: AnimationKey[] = ['idle', 'walk', 'run', 'hop', 'fall', 'sit', 'sleep',
  'look', 'project', 'emote_happy', 'emote_thinking', 'emote_confused', 'emote_alarmed']
const LINE_KEYS: LineKey[] = ['greeting', 'idleMutter', 'thinking', 'toolRunning', 'permissionAsk',
  'permissionDenied', 'authError', 'cliMissing', 'error', 'sleep', 'wake', 'stopped']
const DEFAULT_FPS: Partial<Record<AnimationKey, number>> = { idle: 6, walk: 8, run: 12 }
const LOOPING = new Set<AnimationKey>(['idle', 'walk', 'run', 'sit', 'sleep', 'project', 'emote_thinking'])
const FALLBACK: Partial<Record<AnimationKey, AnimationKey>> = {
  run: 'walk', hop: 'idle', fall: 'idle', sit: 'idle', sleep: 'sit', look: 'idle', project: 'idle',
  emote_happy: 'idle', emote_thinking: 'idle', emote_confused: 'idle', emote_alarmed: 'idle',
}

const ThemeSchema = z.object({ accent: z.string(), glow: z.string(), background: z.string(),
  text: z.string(), font: z.string(), glyph: z.string() })
const ManifestSchema = z.object({
  name: z.string().min(1),
  packVersion: z.literal(1),
  scale: z.number().positive().default(1),
  theme: ThemeSchema,
  persona: z.object({
    promptFile: z.string().default('persona.md'),
    defaultMood: z.enum(['calm', 'happy', 'thinking', 'confused', 'alarmed']).default('calm'),
    lines: z.record(z.string(), z.array(z.string())).default({}),
  }),
  voice: z.unknown().nullable().default(null),
})
const FrameSchema = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().positive(),
  h: z.number().int().positive(), ax: z.number(), ay: z.number(),
  origin: z.tuple([z.number(), z.number()]).optional() })
const AtlasSchema = z.object({ image: z.string(),
  maxFrameSize: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  frames: z.record(z.string(), FrameSchema) })
const RawAnimSchema = z.object({ frames: z.array(z.string()).optional(), right: z.array(z.string()).optional(),
  left: z.array(z.string()).optional(), fps: z.number().positive().optional(),
  loop: z.boolean().optional(), mirror: z.boolean().optional(),
  repeat: z.number().int().positive().optional() })
type RawAnim = z.infer<typeof RawAnimSchema>
const AnimationsSchema = z.record(z.string(), RawAnimSchema)
const FacesRawSchema = z.record(z.string(), z.string())

export type LoadResult = { ok: true; pack: PackData } | { ok: false; errors: string[] }

function readJson(path: string, errors: string[]): unknown {
  if (!existsSync(path)) { errors.push(`missing ${path}`); return null }
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (e) { errors.push(`invalid JSON in ${path}: ${(e as Error).message}`); return null }
}

function issues(prefix: string, err: z.ZodError): string[] {
  return err.issues.map(i => `${prefix}: ${i.path.join('.') || '(root)'} ${i.message}`)
}

export function resolveAnimations(raw: Record<string, RawAnim>, frameNames: Set<string>, errors: string[]): Animations | null {
  const out: Partial<Animations> = {}
  for (const key of Object.keys(raw)) {
    if (!ANIMATION_KEYS.includes(key as AnimationKey)) errors.push(`animations: unknown key "${key}"`)
  }
  for (const key of ANIMATION_KEYS) {
    const r = raw[key]
    if (!r) continue
    const right = r.frames ?? r.right
    if (!right || right.length === 0) { errors.push(`animations.${key}: needs "frames" or "right"`); continue }
    const left = r.frames ? right : (r.left ?? right)
    const mirrorLeft = r.frames ? false : (r.left ? false : (r.mirror ?? true))
    for (const f of new Set([...right, ...left])) {
      if (!frameNames.has(f)) errors.push(`animations.${key}: unknown frame "${f}"`)
    }
    const loop = r.loop ?? LOOPING.has(key)
    // A looping animation never ends, so it would silently swallow a repeat: say so rather
    // than let a pack author set a number that does nothing.
    if (loop && r.repeat !== undefined) errors.push(`animations.${key}: repeat has no effect on a looping animation`)
    out[key] = { right, left, fps: r.fps ?? DEFAULT_FPS[key] ?? 8, loop, mirrorLeft, repeat: r.repeat ?? 1 }
  }
  for (const key of ['idle', 'walk'] as const) {
    if (!out[key]) errors.push(`animations: missing required "${key}"`)
  }
  for (const key of ANIMATION_KEYS) {
    if (out[key]) continue
    const fb = FALLBACK[key]
    const src = fb ? out[fb] : undefined
    if (!src) continue
    out[key] = { right: src.right, left: src.left, mirrorLeft: src.mirrorLeft,
      fps: DEFAULT_FPS[key] ?? 8, loop: LOOPING.has(key), repeat: 1 }
  }
  if (errors.length) return null
  return out as Animations
}

export function resolveFaces(raw: Record<string, string> | undefined, frameNames: Set<string>, errors: string[]): Record<Expression, string> | null {
  if (!raw) return null
  const before = errors.length
  for (const name of Object.keys(raw)) {
    if (!EXPRESSIONS.includes(name as Expression)) errors.push(`animations.faces: unknown expression "${name}"`)
  }
  for (const frame of Object.values(raw)) {
    if (!frameNames.has(frame)) errors.push(`animations.faces: unknown frame "${frame}"`)
  }
  if (!raw.neutral) errors.push('animations.faces: missing required "neutral"')
  if (errors.length > before) return null
  const out = {} as Record<Expression, string>
  for (const name of EXPRESSIONS) out[name] = raw[name] ?? raw.neutral!
  return out
}

export function loadPack(dir: string): LoadResult {
  const errors: string[] = []
  const root = resolve(dir)
  const manifestRaw = readJson(join(root, 'manifest.json'), errors)
  const atlasRaw = readJson(join(root, 'atlas.json'), errors)
  const animRaw = readJson(join(root, 'animations.json'), errors)
  if (errors.length) return { ok: false, errors }
  // "faces" is a sibling of the animation keys inside animations.json, not an animation
  // itself, so it is split off before the per-key animations schema (which would otherwise
  // flag it as an unknown key) ever sees the object.
  let animOnly: unknown = animRaw
  let facesRaw: unknown
  if (animRaw && typeof animRaw === 'object' && !Array.isArray(animRaw)) {
    const { faces, ...rest } = animRaw as Record<string, unknown>
    animOnly = rest
    facesRaw = faces
  }
  const m = ManifestSchema.safeParse(manifestRaw)
  const a = AtlasSchema.safeParse(atlasRaw)
  const an = AnimationsSchema.safeParse(animOnly)
  let facesData: Record<string, string> | undefined
  if (facesRaw !== undefined) {
    const fv = FacesRawSchema.safeParse(facesRaw)
    if (!fv.success) errors.push(...issues('animations.json faces', fv.error))
    else facesData = fv.data
  }
  if (!m.success) errors.push(...issues('manifest.json', m.error))
  if (!a.success) errors.push(...issues('atlas.json', a.error))
  if (!an.success) errors.push(...issues('animations.json', an.error))
  if (!m.success || !a.success || !an.success) return { ok: false, errors }
  const promptPath = join(root, m.data.persona.promptFile)
  if (!existsSync(promptPath)) errors.push(`persona: missing ${m.data.persona.promptFile}`)
  if (!existsSync(join(root, a.data.image))) errors.push(`atlas: missing image ${a.data.image}`)
  const frameNames = new Set(Object.keys(a.data.frames))
  const animations = resolveAnimations(an.data, frameNames, errors)
  const faces = resolveFaces(facesData, frameNames, errors)
  if (errors.length || !animations) return { ok: false, errors }
  if (faces) animations.faces = faces
  const lines = Object.fromEntries(LINE_KEYS.map(k => [k, m.data.persona.lines[k] ?? []])) as Record<LineKey, string[]>
  return { ok: true, pack: {
    dir: root, name: m.data.name, scale: m.data.scale, theme: m.data.theme,
    persona: { prompt: readFileSync(promptPath, 'utf8'), defaultMood: m.data.persona.defaultMood, lines },
    atlas: a.data, animations, faces,
  } }
}

export function pickLine(pack: PackData, key: LineKey, rng: () => number = Math.random): string | null {
  const list = pack.persona.lines[key]
  if (list.length === 0) return null
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))] ?? null
}
