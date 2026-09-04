import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Config {
  pack: string
  // Must be a real executable (claude.exe): a .cmd shim cannot be spawned without a shell,
  // and the brain never uses one because the inline JSON arguments would need cmd quoting.
  cliPath: string
  workspace: string
  extraDirs: string[]
  model: string | null
  allowedTools: string[]
  permissionTimeoutSec: number
  wanderIntervalSec: [number, number]
  sleepAfterMin: number
  scale: number
}

export const DEFAULT_CONFIG: Config = {
  pack: 'packs/mechanicus',
  cliPath: '%USERPROFILE%\\.local\\bin\\claude.exe',
  workspace: 'C:\\repo',
  extraDirs: [],
  model: null,
  allowedTools: ['Read', 'Glob', 'Grep', 'mcp__buddy__*'],
  permissionTimeoutSec: 120,
  wanderIntervalSec: [8, 30],
  sleepAfterMin: 10,
  scale: 1.0,
}

export function expandEnv(s: string): string {
  return s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}
function isFiniteNumber(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v)
}

// One validator per field, checked against the raw JSON before it overwrites a default: a
// field with the wrong type is dropped (logged) rather than let through to crash something
// downstream that trusted the Config type.
const VALIDATORS: { [K in keyof Config]: (v: unknown) => boolean } = {
  pack: (v) => typeof v === 'string',
  cliPath: (v) => typeof v === 'string',
  workspace: (v) => typeof v === 'string',
  extraDirs: isStringArray,
  model: (v) => v === null || typeof v === 'string',
  allowedTools: isStringArray,
  permissionTimeoutSec: isFiniteNumber,
  wanderIntervalSec: (v) => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number'),
  sleepAfterMin: isFiniteNumber,
  scale: isFiniteNumber,
}

function validateConfig(raw: Record<string, unknown>): Config {
  const out = { ...DEFAULT_CONFIG } as Config
  const target = out as unknown as Record<string, unknown>
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof Config)[]) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (VALIDATORS[key](value)) target[key] = value
    else console.error(`config: "${key}" has the wrong type, falling back to the default`)
  }
  return out
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    saveConfig(path, DEFAULT_CONFIG)
    return { ...DEFAULT_CONFIG }
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return validateConfig(raw)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(path: string, cfg: Config): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')
}
