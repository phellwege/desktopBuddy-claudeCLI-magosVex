import { describe, it, expect } from 'vitest'
import { parseCommand } from './commands'

describe('parseCommand', () => {
  it('treats non-slash text as not a command', () => {
    expect(parseCommand('hello there')).toEqual({ ok: false, notCommand: true })
  })
  it('parses /goto with a percentage', () => {
    expect(parseCommand('/goto 40')).toEqual({ ok: true, command: { kind: 'goto', x: 0.4, run: false } })
  })
  it('parses /goto with left, center, right', () => {
    expect(parseCommand('/goto left')).toEqual({ ok: true, command: { kind: 'goto', x: 0, run: false } })
    expect(parseCommand('/goto center')).toEqual({ ok: true, command: { kind: 'goto', x: 0.5, run: false } })
    expect(parseCommand('/goto right')).toEqual({ ok: true, command: { kind: 'goto', x: 1, run: false } })
  })
  it('clamps /goto outside 0..100', () => {
    expect(parseCommand('/goto 250')).toEqual({ ok: true, command: { kind: 'goto', x: 1, run: false } })
    expect(parseCommand('/goto -5')).toEqual({ ok: true, command: { kind: 'goto', x: 0, run: false } })
  })
  it('parses a display prefix on /goto and /run', () => {
    expect(parseCommand('/goto 2:50')).toEqual({ ok: true, command: { kind: 'goto', x: 0.5, run: false, display: 2 } })
    expect(parseCommand('/run 1:left')).toEqual({ ok: true, command: { kind: 'goto', x: 0, run: true, display: 1 } })
  })
  it('rejects a display prefix that is not a positive integer', () => {
    const usage = 'usage: /goto [display:]<0-100|left|center|right>'
    expect(parseCommand('/goto 0:50')).toEqual({ ok: false, error: usage })
    expect(parseCommand('/goto x:50')).toEqual({ ok: false, error: usage })
    expect(parseCommand('/goto 2:sideways')).toEqual({ ok: false, error: usage })
  })
  it('parses /displays', () => {
    expect(parseCommand('/displays')).toEqual({ ok: true, command: { kind: 'displays' } })
  })
  it('parses /run as goto with run', () => {
    expect(parseCommand('/run 80')).toEqual({ ok: true, command: { kind: 'goto', x: 0.8, run: true } })
  })
  it('rejects /goto with garbage', () => {
    expect(parseCommand('/goto sideways')).toEqual({ ok: false, error: 'usage: /goto [display:]<0-100|left|center|right>' })
  })
  it('parses moods and emotes and rejects unknown ones', () => {
    expect(parseCommand('/mood confused')).toEqual({ ok: true, command: { kind: 'mood', mood: 'confused' } })
    expect(parseCommand('/emote hop')).toEqual({ ok: true, command: { kind: 'emote', emote: 'hop' } })
    expect(parseCommand('/mood ecstatic')).toEqual({ ok: false, error: 'unknown mood: ecstatic' })
    expect(parseCommand('/emote dance')).toEqual({ ok: false, error: 'unknown emote: dance' })
  })
  it('parses bare commands', () => {
    for (const k of ['sleep', 'wake', 'stop', 'new', 'clear', 'help'] as const) {
      expect(parseCommand('/' + k)).toEqual({ ok: true, command: { kind: k } })
    }
  })
  it('parses /cd and /model', () => {
    expect(parseCommand('/cd C:\\repo\\fitstudio')).toEqual({ ok: true, command: { kind: 'cd', path: 'C:\\repo\\fitstudio' } })
    expect(parseCommand('/model sonnet')).toEqual({ ok: true, command: { kind: 'model', model: 'sonnet' } })
    expect(parseCommand('/model')).toEqual({ ok: true, command: { kind: 'model', model: null } })
    expect(parseCommand('/cd')).toEqual({ ok: true, command: { kind: 'cd', path: null } })
    expect(parseCommand('/ls')).toEqual({ ok: true, command: { kind: 'ls', path: null } })
    expect(parseCommand('/ls src')).toEqual({ ok: true, command: { kind: 'ls', path: 'src' } })
  })
  it('reports unknown commands', () => {
    expect(parseCommand('/dance')).toEqual({ ok: false, error: 'unknown command: /dance (try /help)' })
  })
  it('is case-insensitive on the command word and trims whitespace', () => {
    expect(parseCommand('  /GOTO 10 ')).toEqual({ ok: true, command: { kind: 'goto', x: 0.1, run: false } })
  })
  it('parses /cli and refuses arguments', () => {
    expect(parseCommand('/cli')).toEqual({ ok: true, command: { kind: 'cli' } })
    expect(parseCommand('/cli now')).toEqual({ ok: false, error: 'usage: /cli' })
  })
})
