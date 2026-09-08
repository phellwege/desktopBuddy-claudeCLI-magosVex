// Image attachments for the brain (spec 2026-09-07-image-attachments-design, 5). Pure
// apart from the codec, which wraps Electron's nativeImage in production
// (images-electron.ts) and is faked in tests, so this file runs under plain Node.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { isImageMediaType, type ImageAttachment, type ImageMediaType, type StagedImage } from '../shared/images'

// The long edge above which the API downscales on the current high-resolution models;
// nothing legible the API would have kept is thrown away.
export const MAX_EDGE = 2576
// Encoded bytes before base64: 4 MB after, under every documented cap.
export const MAX_BYTES = 3 * 1024 * 1024
export const MAX_STAGED = 20
export const THUMB_HEIGHT = 40
export const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
}

export interface DecodedImage {
  width: number
  height: number
  resize(maxEdge: number): DecodedImage
  png(): Buffer
  jpeg(quality: number): Buffer
  // A data URL for the chip.
  thumbnail(height: number): string
}
export interface ImageCodec { decode(bytes: Buffer): DecodedImage | null }
export interface ImageSource { bytes: Buffer; mediaType?: string; name: string }
export type NormalizeResult =
  | { ok: true; attachment: ImageAttachment; staged: StagedImage }
  | { ok: false; reason: string }

export function sniffMediaType(bytes: Buffer): ImageMediaType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

function finish(src: ImageSource, mediaType: ImageMediaType, encoded: Buffer, width: number, height: number, thumb: string): NormalizeResult {
  const id = randomUUID()
  return {
    ok: true,
    attachment: { id, name: src.name, mediaType, data: encoded.toString('base64'), width, height, bytes: encoded.length },
    staged: { id, name: src.name, width, height, thumb },
  }
}

// Spec 5, in order: type (caller's, else sniffed); decode; a gif or webp the codec cannot
// read passes through under the cap; within both caps the bytes pass through unchanged;
// otherwise resize to MAX_EDGE when needed and encode png, jpeg 85 when the png is over
// the cap, refuse when the jpeg still is.
export function normalizeImage(src: ImageSource, codec: ImageCodec): NormalizeResult {
  const type = isImageMediaType(src.mediaType) ? src.mediaType : sniffMediaType(src.bytes)
  if (!type) return { ok: false, reason: 'not an image' }
  const decoded = codec.decode(src.bytes)
  if (!decoded) {
    if (type === 'image/png' || type === 'image/jpeg') return { ok: false, reason: 'cannot decode' }
    if (src.bytes.length > MAX_BYTES) return { ok: false, reason: 'too large' }
    return finish(src, type, src.bytes, 0, 0, `data:${type};base64,${src.bytes.toString('base64')}`)
  }
  const longEdge = Math.max(decoded.width, decoded.height)
  if (longEdge <= MAX_EDGE && src.bytes.length <= MAX_BYTES) {
    return finish(src, type, src.bytes, decoded.width, decoded.height, decoded.thumbnail(THUMB_HEIGHT))
  }
  const scaled = longEdge > MAX_EDGE ? decoded.resize(MAX_EDGE) : decoded
  let encoded = scaled.png()
  let outType: ImageMediaType = 'image/png'
  if (encoded.length > MAX_BYTES) { encoded = scaled.jpeg(85); outType = 'image/jpeg' }
  if (encoded.length > MAX_BYTES) return { ok: false, reason: 'too large' }
  return finish(src, outType, encoded, scaled.width, scaled.height, scaled.thumbnail(THUMB_HEIGHT))
}

// Disk access for a pasted path, injectable so tests never touch the real disk.
export interface ImageFs { readFile(path: string): Buffer }
export const nodeImageFs: ImageFs = { readFile: (p) => readFileSync(p) }

// A relative path resolves against the workspace, as the CLI's own Read would. The
// extension gate runs before the read so a stray .txt never hits the disk (spec 5).
export function loadImagePath(path: string, workspace: string, fs: ImageFs, codec: ImageCodec): NormalizeResult {
  const target = isAbsolute(path) ? resolve(path) : resolve(workspace, path)
  const type = IMAGE_EXTENSIONS[extname(target).toLowerCase()]
  if (!type) return { ok: false, reason: 'not an image file' }
  let bytes: Buffer
  try { bytes = fs.readFile(target) } catch { return { ok: false, reason: 'no such file' } }
  return normalizeImage({ bytes, mediaType: type, name: basename(target) }, codec)
}

// Attachments staged in the panel and not yet sent, by id. Main owns it (spec 5): the
// renderer holds ids and thumbnails only, and the bytes cross IPC once.
export class AttachmentStore {
  private readonly items = new Map<string, ImageAttachment>()
  get size(): number { return this.items.size }
  stage(attachment: ImageAttachment): { ok: true } | { ok: false; reason: string } {
    if (this.items.size >= MAX_STAGED) return { ok: false, reason: 'too many images' }
    this.items.set(attachment.id, attachment)
    return { ok: true }
  }
  // In the order asked, which is the order of the chips; unknown ids are skipped.
  take(ids: readonly string[]): ImageAttachment[] {
    const out: ImageAttachment[] = []
    for (const id of ids) {
      const a = this.items.get(id)
      if (!a) continue
      out.push(a)
      this.items.delete(id)
    }
    return out
  }
  discard(id: string): void { this.items.delete(id) }
  clear(): void { this.items.clear() }
}
