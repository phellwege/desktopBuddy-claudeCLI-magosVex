export interface IpcLike {
  on(ch: string, l: (...a: unknown[]) => void): unknown
  removeListener(ch: string, l: (...a: unknown[]) => void): unknown
}

export function makeOn(ipc: IpcLike) {
  return <T,>(channel: string) => (cb: (p: T) => void): (() => void) => {
    const wrapped = (...args: unknown[]) => cb(args[1] as T)
    ipc.on(channel, wrapped)
    return () => ipc.removeListener(channel, wrapped)
  }
}
