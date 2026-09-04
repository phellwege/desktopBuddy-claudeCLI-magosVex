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

export function renderMarkdown(md: string): string {
  // Strip disallowed raw HTML (script tags and the like) from the source before
  // markdown parsing: marked's CommonMark html-block rule otherwise treats trailing
  // text on the same line as a closing tag (e.g. "</script>**bold**") as part of the
  // raw HTML block, so it never reaches markdown's inline parser.
  const safeSource = DOMPurify.sanitize(md, { USE_PROFILES: { html: true } })
  const html = marked.parse(safeSource, { async: false }) as string
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}
