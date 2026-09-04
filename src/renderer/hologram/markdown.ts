import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import plaintext from 'highlight.js/lib/languages/plaintext'

hljs.registerLanguage('typescript', typescript); hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('javascript', javascript); hljs.registerLanguage('js', javascript)
hljs.registerLanguage('python', python); hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json); hljs.registerLanguage('plaintext', plaintext)

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      const body = hljs.highlight(text, { language }).value
      return `<pre><code class="hljs language-${language}">${body}</code></pre>\n`
    },
  },
})

interface Segment { code: boolean; text: string }
interface FenceMark { marker: string; length: number; info: string }

function isFenceLine(line: string): FenceMark | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!m) return null
  const marker = m[1] ?? ''
  const info = m[2] ?? ''
  return { marker: marker.charAt(0), length: marker.length, info }
}

// Splits the source into fenced-code segments (opening/closing fence lines, the info
// string, and the content between: left completely untouched) and prose segments
// (everything else, including inline code spans found later). Lines partition
// cleanly, so joining the segment texts back with '\n' reconstructs the source.
function splitFences(md: string): Segment[] {
  const lines = md.split('\n')
  const segments: Segment[] = []
  let prose: string[] = []
  const flush = (): void => { if (prose.length) { segments.push({ code: false, text: prose.join('\n') }); prose = [] } }
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const open = isFenceLine(line)
    if (!open) { prose.push(line); i++; continue }
    flush()
    const block = [line]
    i++
    while (i < lines.length) {
      const next = lines[i] ?? ''
      block.push(next)
      const close = isFenceLine(next)
      i++
      if (close && close.marker === open.marker && close.length >= open.length && close.info.trim() === '') break
    }
    segments.push({ code: true, text: block.join('\n') })
  }
  flush()
  return segments
}

// Escapes '<' and '>' in prose text, leaving backtick-delimited inline code spans
// untouched (matching CommonMark: the closing run must have exactly the same number
// of backticks as the opening run). marked's own inline-code renderer escapes the
// raw span content when it builds the <code> element, so passing it through as-is
// here is what lets e.g. `<div>` survive as literal text inside <code>.
function escapeProse(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text.charAt(i) === '`') {
      let j = i
      while (text.charAt(j) === '`') j++
      const openLen = j - i
      let k = j
      let closeEnd = -1
      while (k < text.length) {
        if (text.charAt(k) === '`') {
          let m = k
          while (text.charAt(m) === '`') m++
          if (m - k === openLen) { closeEnd = m; break }
          k = m
        } else {
          k++
        }
      }
      if (closeEnd === -1) { out += text.slice(i, j); i = j; continue }
      out += text.slice(i, closeEnd)
      i = closeEnd
      continue
    }
    const ch = text.charAt(i)
    out += ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch
    i++
  }
  return out
}

function escapeOutsideCode(md: string): string {
  return splitFences(md).map(s => (s.code ? s.text : escapeProse(s.text))).join('\n')
}

export function renderMarkdown(md: string): string {
  const html = marked.parse(escapeOutsideCode(md), { async: false }) as string
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}
