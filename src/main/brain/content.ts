// The user message the brain writes to the CLI: plain text, or, when images ride along,
// an array of Messages API content blocks (spec 2026-09-07-image-attachments-design, 4).
import type { ImageAttachment, ImageMediaType } from '../../shared/images'

export type UserBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
export type UserContent = string | UserBlock[]

export function caption(index: number, name: string): string { return `[Image #${index}: ${name}]` }

// Images first, each followed by its caption, then the operator's text. With no images the
// content is the plain string, so nothing already on the wire changes shape.
export function buildUserContent(text: string, images: readonly ImageAttachment[]): UserContent {
  if (images.length === 0) return text
  const blocks: UserBlock[] = []
  images.forEach((img, i) => {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
    blocks.push({ type: 'text', text: caption(i + 1, img.name) })
  })
  if (text.length > 0) blocks.push({ type: 'text', text })
  return blocks
}

const CAPTION = /^\[Image #\d+: (.*)\]$/
// The operator's own words and the attached image names, read back out of content built
// above. The echo brain uses it; the real CLI gets the blocks as they are.
export function describeContent(content: UserContent): { text: string; imageNames: string[] } {
  if (typeof content === 'string') return { text: content, imageNames: [] }
  const texts: string[] = []
  const imageNames: string[] = []
  for (const block of content) {
    if (block.type !== 'text') continue
    const m = CAPTION.exec(block.text)
    if (m) imageNames.push(m[1] ?? '')
    else texts.push(block.text)
  }
  return { text: texts.join(' '), imageNames }
}
