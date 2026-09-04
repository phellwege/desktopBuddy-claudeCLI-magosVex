import { describe, it, expect } from 'vitest'
import { makeOn } from './bridge'

class FakeIpc {
  listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  on(ch: string, l: (...a: unknown[]) => void): unknown {
    (this.listeners[ch] ??= []).push(l)
    return this
  }
  removeListener(ch: string, l: (...a: unknown[]) => void): unknown {
    this.listeners[ch] = (this.listeners[ch] ?? []).filter((x) => x !== l)
    return this
  }
  emit(ch: string, event: unknown, payload: unknown): void {
    for (const l of this.listeners[ch] ?? []) l(event, payload)
  }
}

describe('makeOn', () => {
  it('registers a new listener on every call, so two registrations yield two listeners', () => {
    const ipc = new FakeIpc()
    const on = makeOn(ipc)
    on('chat:delta')(() => {})
    on('chat:delta')(() => {})
    expect(ipc.listeners['chat:delta']?.length).toBe(2)
  })

  it('the returned disposer removes exactly its own wrapped listener', () => {
    const ipc = new FakeIpc()
    const on = makeOn(ipc)
    const calls1: unknown[] = []
    const calls2: unknown[] = []
    const off1 = on<{ text: string }>('chat:delta')((p) => calls1.push(p))
    on<{ text: string }>('chat:delta')((p) => calls2.push(p))
    expect(ipc.listeners['chat:delta']?.length).toBe(2)

    off1()
    expect(ipc.listeners['chat:delta']?.length).toBe(1)

    ipc.emit('chat:delta', { fake: 'ipcRendererEvent' }, { text: 'hi' })
    expect(calls1).toEqual([])
    expect(calls2).toEqual([{ text: 'hi' }])
  })

  it('the callback receives the payload, not the event', () => {
    const ipc = new FakeIpc()
    const on = makeOn(ipc)
    let received: unknown
    on<{ text: string }>('chat:delta')((p) => { received = p })

    ipc.emit('chat:delta', { fake: 'ipcRendererEvent' }, { text: 'payload' })
    expect(received).toEqual({ text: 'payload' })
  })
})
