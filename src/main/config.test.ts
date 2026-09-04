import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, expandEnv, loadConfig, saveConfig } from './config'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'cfg-')), 'config.json')

describe('config', () => {
  it('expands %VAR% from the environment', () => {
    process.env.BUDDY_TEST_VAR = 'X:\\home'
    expect(expandEnv('%BUDDY_TEST_VAR%\\.local')).toBe('X:\\home\\.local')
    expect(expandEnv('%NOPE_NOT_SET%\\a')).toBe('%NOPE_NOT_SET%\\a')
  })
  it('writes defaults when the file is missing', () => {
    const p = tmp()
    const cfg = loadConfig(p)
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(existsSync(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8')).workspace).toBe('C:\\repo')
  })
  it('merges a partial file over defaults', () => {
    const p = tmp()
    writeFileSync(p, JSON.stringify({ model: 'sonnet', scale: 1.5 }))
    const cfg = loadConfig(p)
    expect(cfg.model).toBe('sonnet')
    expect(cfg.scale).toBe(1.5)
    expect(cfg.pack).toBe(DEFAULT_CONFIG.pack)
  })
  it('falls back to defaults on invalid JSON without overwriting the file', () => {
    const p = tmp()
    writeFileSync(p, '{ not json')
    expect(loadConfig(p)).toEqual(DEFAULT_CONFIG)
    expect(readFileSync(p, 'utf8')).toBe('{ not json')
  })
  it('falls back to the default for a wrong-typed field, with a logged line, keeping the rest', () => {
    const p = tmp()
    writeFileSync(p, JSON.stringify({ scale: 'big', model: 'sonnet' }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = loadConfig(p)
    expect(cfg.scale).toBe(DEFAULT_CONFIG.scale)
    expect(cfg.model).toBe('sonnet')
    expect(spy).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('scale'))
    spy.mockRestore()
  })
  it('round-trips through saveConfig', () => {
    const p = tmp()
    saveConfig(p, { ...DEFAULT_CONFIG, workspace: 'D:\\w' })
    expect(loadConfig(p).workspace).toBe('D:\\w')
  })
})
