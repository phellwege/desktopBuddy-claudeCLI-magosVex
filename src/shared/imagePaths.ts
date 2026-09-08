// Image paths inside pasted text (spec 2026-09-07-image-attachments-design, 6). Runs in
// the renderer on a paste, never on typed text; no Node imports.
const EXT = String.raw`\.(?:png|jpe?g|gif|webp)`
// The bare forms (Windows/UNC and POSIX) must stop at the extension: without a terminator,
// "C:\a.png.bak" would match "C:\a.png" as a substring of a file that is not actually a
// png. Required next: end of text, or whitespace, a quote, or one of the punctuation marks
// a path is commonly followed by in prose.
const TERM = String.raw`(?=$|[\s"'),;\]>])`
// In order: a quoted path (Explorer's Copy as path puts "C:\dir\a.png" on the clipboard,
// quotes included), a file URL, a bare Windows drive or UNC path, a bare POSIX path. A
// bare path runs to the next whitespace or quote, then the terminator above. The quoted
// form rejects a web URL right after the opening quote (a pasted "https://x/y.png" is not
// a local file). The Windows/UNC form carries a narrow lookbehind: a drive letter is a
// single character, so without a guard a lone letter right before ":/" inside a URL reads
// as a drive letter, and the "s" in "https://x.y/z.png" would match as "s://x.y/z.png".
// Excluding only a letter or digit right before the match blocks that (the preceding "p"
// in "http" is a letter) while still matching a drive letter right after ":", ".", "/",
// "\", "(", a quote, or the start of the text, e.g. "see:C:\a.png" or "(C:\a.png)". The
// POSIX form keeps its wider lookbehind so that same URL's "/z.png" does not match on its
// own.
const PATTERN = new RegExp(
  String.raw`"(?!https?:)([^"\r\n]+?${EXT})"` +
  String.raw`|(file:///?[^\s"']+?${EXT})` +
  String.raw`|(?<![A-Za-z0-9])((?:[A-Za-z]:[\\/]|\\\\)[^\s"']+?${EXT})${TERM}` +
  String.raw`|(?<![\w:./\\])(/[^\s"']+?${EXT})${TERM}`,
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

// Spec 6: a UNC path (\\server\share\a.png) inside pasted prose is read by main the moment
// it is pasted, which makes an outbound SMB connection to whatever host the pasted text
// names and offers the user's NTLM credential hash to it. Local drive paths carry no such
// risk. So a UNC path only stages when the whole paste, trimmed and with one pair of
// surrounding quotes stripped, is exactly that path - a deliberate paste of just the path,
// not a UNC path that merely appears inside other text. findImagePaths itself keeps
// matching every UNC path (the detector stays complete); only staging is narrowed here.
export function stageablePaths(text: string): string[] {
  const trimmed = text.trim()
  const dequoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
  return findImagePaths(text).filter((p) => !p.startsWith('\\\\') || p === dequoted)
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
