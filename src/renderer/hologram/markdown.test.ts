// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders markdown and strips scripts', () => {
    const html = renderMarkdown('# Hi\n\n<script>alert(1)</script>**bold**')
    expect(html).toContain('<h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('<script')
  })
  it('highlights fenced code', () => {
    const html = renderMarkdown('```ts\nconst x: number = 1\n```')
    expect(html).toContain('<pre><code class="hljs language-ts">')
    expect(html).toContain('hljs-keyword')
  })
})
