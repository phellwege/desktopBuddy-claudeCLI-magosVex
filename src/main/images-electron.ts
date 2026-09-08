// The production ImageCodec over Electron's nativeImage, kept out of images.ts so that file
// and its tests run under plain Node. nativeImage decodes PNG and JPEG; anything else
// comes back empty and images.ts passes it through or refuses it.
import { nativeImage, type NativeImage } from 'electron'
import type { DecodedImage, ImageCodec } from './images'

function wrap(img: NativeImage): DecodedImage {
  const { width, height } = img.getSize()
  return {
    width, height,
    resize(maxEdge) {
      const scale = maxEdge / Math.max(width, height)
      return wrap(img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' }))
    },
    png: () => img.toPNG(),
    jpeg: (quality) => img.toJPEG(quality),
    // Height only: nativeImage keeps the aspect ratio when one side is given.
    thumbnail: (h) => img.resize({ height: h, quality: 'good' }).toDataURL(),
  }
}

export const electronCodec: ImageCodec = {
  decode(bytes) {
    const img = nativeImage.createFromBuffer(bytes)
    return img.isEmpty() ? null : wrap(img)
  },
}
