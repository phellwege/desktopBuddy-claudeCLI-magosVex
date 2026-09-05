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
  it('falls back to the default for a permissionTimeoutSec outside 5..600, with a logged line, keeping the rest', () => {
    const p = tmp()
    writeFileSync(p, JSON.stringify({ permissionTimeoutSec: 2, model: 'sonnet' }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = loadConfig(p)
    expect(cfg.permissionTimeoutSec).toBe(DEFAULT_CONFIG.permissionTimeoutSec)
    expect(cfg.model).toBe('sonnet')
    expect(spy).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('permissionTimeoutSec'))
    spy.mockRestore()
  })
  it('accepts a permissionTimeoutSec at the edges of the 5..600 range', () => {
    const p = tmp()
    writeFileSync(p, JSON.stringify({ permissionTimeoutSec: 5 }))
    expect(loadConfig(p).permissionTimeoutSec).toBe(5)
    const p2 = tmp()
    writeFileSync(p2, JSON.stringify({ permissionTimeoutSec: 600 }))
    expect(loadConfig(p2).permissionTimeoutSec).toBe(600)
  })
  it('rejects a permissionTimeoutSec just past the 5..600 range', () => {
    const p = tmp()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(p, JSON.stringify({ permissionTimeoutSec: 601 }))
    expect(loadConfig(p).permissionTimeoutSec).toBe(DEFAULT_CONFIG.permissionTimeoutSec)
    spy.mockRestore()
  })
  it('falls back to the readback default on a wrong-typed value, and keeps an explicit false', () => {
    const p = tmp()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(p, JSON.stringify({ readback: 'yes' }))
    expect(loadConfig(p).readback).toBe(true)
    spy.mockRestore()
    const p2 = tmp()
    writeFileSync(p2, JSON.stringify({ readback: false }))
    expect(loadConfig(p2).readback).toBe(false)
  })
  it('accepts an explicit permissionMode of manual', () => {
    const p = tmp()
    writeFileSync(p, JSON.stringify({ permissionMode: 'manual' }))
    expect(loadConfig(p).permissionMode).toBe('manual')
  })
  it('falls back to the acceptEdits default for an invalid permissionMode, with a logged line, keeping the rest', () => {
    const p = tmp()
    writeFileSync(p, JSON.stringify({ permissionMode: 'yolo', model: 'sonnet' }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cfg = loadConfig(p)
    expect(cfg.permissionMode).toBe('acceptEdits')
    expect(cfg.model).toBe('sonnet')
    expect(spy).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('permissionMode'))
    spy.mockRestore()
  })
  it('falls back to the mutterIntervalMin default of 2 when the field is absent', () => {
    const p = tmp()
    expect(loadConfig(p).mutterIntervalMin).toBe(2)
  })
  it('accepts an explicit mutterIntervalMin, including 0 to disable mutters', () => {
    const p = tmp()
    writeFileSync(p, JSON.stringify({ mutterIntervalMin: 5 }))
    expect(loadConfig(p).mutterIntervalMin).toBe(5)
    const p2 = tmp()
    writeFileSync(p2, JSON.stringify({ mutterIntervalMin: 0 }))
    expect(loadConfig(p2).mutterIntervalMin).toBe(0)
  })
  it('falls back to the mutterIntervalMin default for a value outside 0 or 0.1..60, with a logged line, keeping the rest', () => {
    const p = tmp()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(p, JSON.stringify({ mutterIntervalMin: 61, model: 'sonnet' }))
    const cfg = loadConfig(p)
    expect(cfg.mutterIntervalMin).toBe(DEFAULT_CONFIG.mutterIntervalMin)
    expect(cfg.model).toBe('sonnet')
    expect(spy).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('mutterIntervalMin'))
    spy.mockRestore()
  })
  it('round-trips through saveConfig', () => {
    const p = tmp()
    saveConfig(p, { ...DEFAULT_CONFIG, workspace: 'D:\\w' })
    expect(loadConfig(p).workspace).toBe('D:\\w')
  })
})
