// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown'

function textOf(html: string, selector: string): string | null {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.querySelector(selector)?.textContent ?? null
}

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
  it('keeps generic type syntax intact inside a fenced code block', () => {
    const html = renderMarkdown('```ts\nfunction foo<T>(x: T): T { return x }\n```')
    expect(textOf(html, 'code')).toContain('<T>')
  })
  it('keeps inline code content untouched, including angle brackets', () => {
    const html = renderMarkdown('prose `<div>` more prose')
    expect(textOf(html, 'code')).toBe('<div>')
  })
  it('escapes raw-looking tags in prose but still renders markdown that follows them', () => {
    const html = renderMarkdown('<script>alert(1)</script>**bold**')
    const div = document.createElement('div')
    div.innerHTML = html
    expect(div.querySelector('script')).toBeNull()
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<strong>bold</strong>')
  })
  it('keeps bare angle brackets as literal text in prose', () => {
    const html = renderMarkdown('a < b > c')
    const div = document.createElement('div')
    div.innerHTML = html
    expect(div.textContent?.trim()).toBe('a < b > c')
  })
  it('links render as plain text with the url', () => {
    const html = renderMarkdown('see [docs](https://example.com)')
    expect(html).not.toContain('<a ')
    expect(html).toContain('docs (https://example.com)')
  })
})
