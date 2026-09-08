import { describe, it, expect } from 'vitest'
import { buildUserContent, caption, describeContent } from './content'
import type { ImageAttachment } from '../../shared/images'

const img = (id: string, name: string): ImageAttachment => ({ id, name, mediaType: 'image/png', data: 'QUJD', width: 2, height: 1, bytes: 3 })

describe('buildUserContent', () => {
  it('is the plain string when there are no images', () => {
    expect(buildUserContent('hello', [])).toBe('hello')
  })
  it('puts each image block before its caption, and the text last', () => {
    expect(buildUserContent('what are these?', [img('a', 'shot.png'), img('b', 'two.png')])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'text', text: '[Image #1: shot.png]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'text', text: '[Image #2: two.png]' },
      { type: 'text', text: 'what are these?' },
    ])
  })
  it('omits the trailing text block when the text is empty', () => {
    const blocks = buildUserContent('', [img('a', 'shot.png')])
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toEqual({ type: 'text', text: caption(1, 'shot.png') })
  })
})

describe('describeContent', () => {
  it('passes a string through with no images', () => {
    expect(describeContent('hi')).toEqual({ text: 'hi', imageNames: [] })
  })
  it('separates the operator text from the captions', () => {
    const content = buildUserContent('look', [img('a', 'shot.png'), img('b', 'two.png')])
    expect(describeContent(content)).toEqual({ text: 'look', imageNames: ['shot.png', 'two.png'] })
  })
  it('reads empty text from an images-only message', () => {
    expect(describeContent(buildUserContent('', [img('a', 'x.png')]))).toEqual({ text: '', imageNames: ['x.png'] })
  })
})
