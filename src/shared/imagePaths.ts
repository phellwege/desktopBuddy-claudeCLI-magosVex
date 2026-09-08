// Image paths inside pasted text (spec 2026-09-07-image-attachments-design, 6). Runs in
// the renderer on a paste, never on typed text; no Node imports.
const EXT = String.raw`\.(?:png|jpe?g|gif|webp)`
// In order: a quoted path (Explorer's Copy as path puts "C:\dir\a.png" on the clipboard,
// quotes included), a file URL, a bare Windows drive or UNC path, a bare POSIX path. A
// bare path runs to the next whitespace or quote. Both bare forms carry the same
// lookbehind: without it on the Windows form, a lone letter right before ":/" inside a
// URL reads as a drive letter, so the "s" in "https://x.y/z.png" would match as
// "s://x.y/z.png"; without it on the POSIX form, that same URL's "/z.png" would match on
// its own. The lookbehind rules out starting mid-word or right after ":", ".", "/", "\".
const PATTERN = new RegExp(
  String.raw`"([^"\r\n]+?${EXT})"` +
  String.raw`|(file:///?[^\s"']+?${EXT})` +
  String.raw`|(?<![\w:./\\])((?:[A-Za-z]:[\\/]|\\\\)[^\s"']+?${EXT})` +
  String.raw`|(?<![\w:./\\])(/[^\s"']+?${EXT})`,
  'gi',
)

export function findImagePaths(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(PATTERN)) {
    const quoted = m[1], url = m[2], windows = m[3], posix = m[4]
    let path: string | undefined
    if (quoted !== undefined) path = quoted
    else if (url !== undefined) path = fromFileUrl(url)
    else if (windows !== undefined) path = windows
    else if (posix !== undefined) path = posix
    if (path && !found.includes(path)) found.push(path)
  }
  return found
}

// file:///C:/dir/a.png -> C:/dir/a.png ; file:///home/u/a.png -> /home/u/a.png ; percent
// escapes decoded. The two-slash host form (file://server/share) is not a path this app
// handles; it comes back as a POSIX path and fails to load, which the panel reports.
export function fromFileUrl(url: string): string {
  let rest = url.replace(/^file:\/\/\/?/i, '')
  try { rest = decodeURIComponent(rest) } catch { /* keep the raw form */ }
  if (/^[A-Za-z]:/.test(rest)) return rest
  return '/' + rest.replace(/^\/+/, '')
}
