// Image attachment types shared by main and the renderer. No runtime dependencies.
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export function isImageMediaType(v: unknown): v is ImageMediaType {
  return typeof v === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(v)
}
// One image ready for the wire. data is base64; bytes is the encoded size before base64.
export interface ImageAttachment { id: string; name: string; mediaType: ImageMediaType; data: string; width: number; height: number; bytes: number }
// What the panel holds per chip. thumb is a data URL. width and height are 0 for an
// image the codec could not decode (gif, webp), which is passed through as it came.
export interface StagedImage { id: string; name: string; width: number; height: number; thumb: string }
