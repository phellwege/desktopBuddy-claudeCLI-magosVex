import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Config {
  pack: string
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

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    saveConfig(path, DEFAULT_CONFIG)
    return { ...DEFAULT_CONFIG }
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
    return { ...DEFAULT_CONFIG, ...raw }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(path: string, cfg: Config): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')
}
