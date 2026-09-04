import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PACK_SCHEME = 'pack'

export function resolvePackPath(packDir: string, url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== `${PACK_SCHEME}:`) return null
  // The URL parser already collapses ".." dot-segments before we see u.pathname
  // (WHATWG URL spec normalizes double-dot path segments for hierarchical paths
  // regardless of scheme), so check the raw input for an explicit traversal
  // attempt as well, independent of that normalization.
  if (/(^|\/)\.\.(\/|$)/.test(url)) return null
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  if (!rel) return null
  const root = resolve(packDir)
  const full = resolve(root, rel)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

export async function registerPackScheme(): Promise<void> {
  const { protocol } = await import('electron')
  protocol.registerSchemesAsPrivileged([
    { scheme: PACK_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ])
}

export async function handlePackProtocol(packDir: string): Promise<void> {
  const { protocol, net } = await import('electron')
  protocol.handle(PACK_SCHEME, (request) => {
    const path = resolvePackPath(packDir, request.url)
    if (!path) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(path).toString())
  })
}
