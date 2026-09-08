import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { AttachmentStore, loadImagePath, MAX_BYTES, MAX_STAGED, normalizeImage, sniffMediaType, type DecodedImage, type ImageCodec, type ImageFs } from './images'
import type { ImageAttachment } from '../shared/images'

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const GIF_HEAD = Buffer.from('GIF89a', 'latin1')
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')])
const png = (extra = 0) => Buffer.concat([PNG_HEAD, Buffer.alloc(extra)])

// A codec whose decoded image has the size the test asks for and encodes to buffers of
// chosen lengths; every call is recorded so a test can assert which path ran.
export function fakeCodec(opts: { width: number; height: number; pngBytes?: number; jpegBytes?: number; decodes?: boolean }): ImageCodec & { calls: string[] } {
  const calls: string[] = []
  const make = (width: number, height: number): DecodedImage => ({
    width, height,
    resize(maxEdge) { calls.push(`resize ${maxEdge}`); const s = maxEdge / Math.max(width, height); return make(Math.round(width * s), Math.round(height * s)) },
    png() { calls.push('png'); return Buffer.alloc(opts.pngBytes ?? 100) },
    jpeg(quality) { calls.push(`jpeg ${quality}`); return Buffer.alloc(opts.jpegBytes ?? 50) },
    thumbnail(height) { calls.push(`thumb ${height}`); return `data:image/png;base64,thumb${height}` },
  })
  return { calls, decode(bytes) { calls.push(`decode ${bytes.length}`); return opts.decodes === false ? null : make(opts.width, opts.height) } }
}

describe('sniffMediaType', () => {
  it('recognises the four formats by their magic bytes', () => {
    expect(sniffMediaType(png())).toBe('image/png')
    expect(sniffMediaType(JPEG_HEAD)).toBe('image/jpeg')
    expect(sniffMediaType(GIF_HEAD)).toBe('image/gif')
    expect(sniffMediaType(WEBP_HEAD)).toBe('image/webp')
  })
  it('returns null for anything else', () => {
    expect(sniffMediaType(Buffer.from('hello world'))).toBeNull()
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull()
  })
})

describe('normalizeImage', () => {
  it('passes a small png through unchanged, with a thumbnail and the decoded size', () => {
    const codec = fakeCodec({ width: 800, height: 600 })
    const bytes = png(10)
    const r = normalizeImage({ bytes, name: 'a.png' }, codec)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.attachment).toMatchObject({ name: 'a.png', mediaType: 'image/png', data: bytes.toString('base64'), width: 800, height: 600, bytes: 18 })
    expect(r.staged).toEqual({ id: r.attachment.id, name: 'a.png', width: 800, height: 600, thumb: 'data:image/png;base64,thumb40' })
    expect(codec.calls).toEqual(['decode 18', 'thumb 40'])
  })
  it('gives every call a fresh id', () => {
    const codec = fakeCodec({ width: 1, height: 1 })
    const a = normalizeImage({ bytes: png(), name: 'a.png' }, codec)
    const b = normalizeImage({ bytes: png(), name: 'a.png' }, codec)
    expect(a.ok && b.ok && a.attachment.id !== b.attachment.id).toBe(true)
  })
  it('takes the caller media type over the sniff', () => {
    const r = normalizeImage({ bytes: png(), mediaType: 'image/jpeg', name: 'a.jpg' }, fakeCodec({ width: 1, height: 1 }))
    expect(r.ok && r.attachment.mediaType).toBe('image/jpeg')
  })
  it('resizes over MAX_EDGE and re-encodes as png', () => {
    const codec = fakeCodec({ width: 5000, height: 2000, pngBytes: 1000 })
    const r = normalizeImage({ bytes: png(), name: 'wide.png' }, codec)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.attachment).toMatchObject({ mediaType: 'image/png', width: 2576, height: 1030, bytes: 1000 })
    expect(codec.calls).toContain('resize 2576')
    expect(codec.calls).toContain('png')
    expect(codec.calls).not.toContain('jpeg 85')
  })
  it('falls back to jpeg 85 when the png is over the cap', () => {
    const codec = fakeCodec({ width: 5000, height: 2000, pngBytes: MAX_BYTES + 1, jpegBytes: 1000 })
    const r = normalizeImage({ bytes: png(), name: 'wide.png' }, codec)
    expect(r.ok && r.attachment.mediaType).toBe('image/jpeg')
    expect(r.ok && r.attachment.bytes).toBe(1000)
    expect(codec.calls).toContain('jpeg 85')
  })
  it('refuses when even the jpeg is over the cap', () => {
    const codec = fakeCodec({ width: 5000, height: 2000, pngBytes: MAX_BYTES + 1, jpegBytes: MAX_BYTES + 1 })
    expect(normalizeImage({ bytes: png(), name: 'huge.png' }, codec)).toEqual({ ok: false, reason: 'too large' })
  })
  it('re-encodes without resizing when only the byte cap is exceeded', () => {
    const codec = fakeCodec({ width: 1000, height: 1000, pngBytes: 500 })
    const r = normalizeImage({ bytes: png(MAX_BYTES), name: 'fat.png' }, codec)
    expect(r.ok && r.attachment.bytes).toBe(500)
    expect(codec.calls.some(c => c.startsWith('resize'))).toBe(false)
    expect(codec.calls).toContain('png')
  })
  it('refuses bytes that are not an image', () => {
    expect(normalizeImage({ bytes: Buffer.from('hello'), name: 'x.bin' }, fakeCodec({ width: 1, height: 1 }))).toEqual({ ok: false, reason: 'not an image' })
  })
  it('refuses a png or jpeg the codec cannot decode', () => {
    const codec = fakeCodec({ width: 1, height: 1, decodes: false })
    expect(normalizeImage({ bytes: png(), name: 'a.png' }, codec)).toEqual({ ok: false, reason: 'cannot decode' })
    expect(normalizeImage({ bytes: JPEG_HEAD, name: 'a.jpg' }, codec)).toEqual({ ok: false, reason: 'cannot decode' })
  })
  it('passes a gif through when the codec cannot decode it, with the raw bytes as the thumb', () => {
    const codec = fakeCodec({ width: 1, height: 1, decodes: false })
    const r = normalizeImage({ bytes: GIF_HEAD, name: 'a.gif' }, codec)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.attachment).toMatchObject({ mediaType: 'image/gif', width: 0, height: 0, data: GIF_HEAD.toString('base64') })
    expect(r.staged.thumb).toBe(`data:image/gif;base64,${GIF_HEAD.toString('base64')}`)
  })
  it('refuses a gif over the cap', () => {
    const codec = fakeCodec({ width: 1, height: 1, decodes: false })
    expect(normalizeImage({ bytes: Buffer.concat([GIF_HEAD, Buffer.alloc(MAX_BYTES)]), name: 'a.gif' }, codec)).toEqual({ ok: false, reason: 'too large' })
  })
})

function fakeFs(files: Record<string, Buffer>): ImageFs {
  return { readFile: (p) => { const b = files[p]; if (!b) throw new Error('ENOENT'); return b } }
}

describe('loadImagePath', () => {
  it('resolves a relative path against the workspace and names the file by its basename', () => {
    const key = resolve('C:\\repo', 'shots/a.png')
    const r = loadImagePath('shots/a.png', 'C:\\repo', fakeFs({ [key]: png(10) }), fakeCodec({ width: 10, height: 10 }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.attachment.name).toBe('a.png')
    expect(r.attachment.mediaType).toBe('image/png')
  })
  it('takes an absolute path as it is', () => {
    const key = resolve('D:\\pics\\b.JPG')
    const r = loadImagePath('D:\\pics\\b.JPG', 'C:\\repo', fakeFs({ [key]: JPEG_HEAD }), fakeCodec({ width: 10, height: 10 }))
    expect(r.ok && r.attachment.mediaType).toBe('image/jpeg')
    expect(r.ok && r.attachment.name).toBe('b.JPG')
  })
  it('gates on the extension before reading', () => {
    let reads = 0
    const fs: ImageFs = { readFile: () => { reads++; return png() } }
    expect(loadImagePath('C:\\x\\notes.txt', 'C:\\repo', fs, fakeCodec({ width: 1, height: 1 }))).toEqual({ ok: false, reason: 'not an image file' })
    expect(reads).toBe(0)
  })
  it('reports a missing file', () => {
    expect(loadImagePath('C:\\x\\gone.png', 'C:\\repo', fakeFs({}), fakeCodec({ width: 1, height: 1 }))).toEqual({ ok: false, reason: 'no such file' })
  })
})

describe('AttachmentStore', () => {
  const att = (id: string): ImageAttachment => ({ id, name: `${id}.png`, mediaType: 'image/png', data: 'QUJD', width: 1, height: 1, bytes: 3 })
  it('takes staged attachments in the order asked and removes them', () => {
    const s = new AttachmentStore()
    s.stage(att('a')); s.stage(att('b')); s.stage(att('c'))
    expect(s.take(['c', 'a']).map(x => x.id)).toEqual(['c', 'a'])
    expect(s.size).toBe(1)
    expect(s.take(['c'])).toEqual([])
  })
  it('skips unknown ids', () => {
    const s = new AttachmentStore()
    s.stage(att('a'))
    expect(s.take(['zzz', 'a']).map(x => x.id)).toEqual(['a'])
  })
  it('discards one and clears all', () => {
    const s = new AttachmentStore()
    s.stage(att('a')); s.stage(att('b'))
    s.discard('a')
    expect(s.size).toBe(1)
    s.clear()
    expect(s.size).toBe(0)
  })
  it('refuses beyond MAX_STAGED', () => {
    const s = new AttachmentStore()
    for (let i = 0; i < MAX_STAGED; i++) expect(s.stage(att(`i${i}`))).toEqual({ ok: true })
    expect(s.stage(att('one-more'))).toEqual({ ok: false, reason: 'too many images' })
    expect(s.size).toBe(MAX_STAGED)
  })
})
