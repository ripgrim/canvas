import { previewAppearanceLimits, previewImageMimes } from '@canvas/preview-runtime/protocol'
import { appearanceLimits } from '@canvas/repo-engine/appearance'

const inputLimit = 25 * 1024 * 1024
export const embeddedImageByteLimit = Math.floor(previewAppearanceLimits.assetData / 4) * 3
const embeddedImageByteLabel = String(embeddedImageByteLimit).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
export const oversizedAnimatedImageMessage = `This animated image exceeds the ${embeddedImageByteLabel}-byte embedded preview limit. Choose an AVIF, PNG, JPEG, GIF, or WebP image within that limit.`
const heicMimes = new Set(['image/heic', 'image/heif'])
const heicExtensions = /\.(?:heic|heif)$/i

type DecodedImage = { width: number; height: number; close: () => void }
type ImageImportDependencies = {
  convertHeic: (source: File) => Promise<Blob>
  decode: (source: Blob) => Promise<DecodedImage>
  encodeWebp: (image: DecodedImage, quality: number, scale: number) => Promise<Blob>
}

const replaceExtension = (name: string, extension: string) => `${name.replace(/\.[^.]+$/, '') || 'Image'}.${extension}`
const textAt = (bytes: Uint8Array, offset: number, value: string) => [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0))
const animatedWebp = async (source: Blob) => {
  const bytes = new Uint8Array(await source.slice(0, 21).arrayBuffer())
  return bytes.length >= 21 && textAt(bytes, 0, 'RIFF') && textAt(bytes, 8, 'WEBP') && textAt(bytes, 12, 'VP8X') && Boolean(bytes[20]! & 0x02)
}
const animatedGif = async (source: Blob) => {
  const bytes = new Uint8Array(await source.arrayBuffer())
  if (bytes.length < 14 || !(textAt(bytes, 0, 'GIF87a') || textAt(bytes, 0, 'GIF89a'))) return false
  let offset = 13
  if (bytes[10]! & 0x80) offset += 3 * 2 ** ((bytes[10]! & 0x07) + 1)
  let frames = 0
  const skipBlocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset++]!
      if (size === 0) return true
      offset += size
      if (offset > bytes.length) return false
    }
    return false
  }
  while (offset < bytes.length) {
    const marker = bytes[offset++]!
    if (marker === 0x3b) return false
    if (marker === 0x21) { offset++; if (!skipBlocks()) return false; continue }
    if (marker !== 0x2c || offset + 9 > bytes.length) return false
    const packed = bytes[offset + 8]!
    offset += 9
    if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1)
    if (offset >= bytes.length) return false
    offset++
    if (!skipBlocks()) return false
    frames++
    if (frames > 1) return true
  }
  return false
}

const browserDependencies = (): ImageImportDependencies => ({
  convertHeic: async source => {
    const { heicTo } = await import('heic-to/csp')
    return heicTo({ blob: source, type: 'image/jpeg', quality: 0.92 }) as Promise<Blob>
  },
  decode: async source => {
    if (source.type !== 'image/svg+xml') return createImageBitmap(source)
    const url = URL.createObjectURL(source)
    const image = new Image()
    try {
      image.src = url
      await image.decode()
      const width = image.naturalWidth
      const height = image.naturalHeight
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || width > appearanceLimits.assetDimension || height > appearanceLimits.assetDimension
        || width * height > appearanceLimits.assetPixels) throw new Error('Image dimensions exceed the import limit')
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Image conversion is unavailable.')
      context.drawImage(image, 0, 0, width, height)
      return createImageBitmap(canvas)
    } finally { URL.revokeObjectURL(url) }
  },
  encodeWebp: async (image, quality, scale) => {
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image conversion is unavailable.')
    context.drawImage(image as CanvasImageSource, 0, 0, width, height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality))
    if (!blob) throw new Error('Image conversion failed.')
    return blob
  },
})

/** Accepts the broad image picker contract while keeping session-only preview transport bounded and validated. */
export async function prepareImageFile(source: File, dependencies: ImageImportDependencies = browserDependencies()): Promise<File> {
  const heic = heicMimes.has(source.type.toLowerCase()) || heicExtensions.test(source.name)
  if (source.size < 1 || source.size > inputLimit || !heic && !source.type.startsWith('image/')) throw new Error('Choose an image up to 25 MB.')
  const converted = heic ? await dependencies.convertHeic(source) : source
  const convertedFile = heic ? new File([converted], replaceExtension(source.name, 'jpg'), { type: 'image/jpeg' }) : source
  if ((previewImageMimes as readonly string[]).includes(convertedFile.type) && convertedFile.size <= embeddedImageByteLimit) return convertedFile
  if (convertedFile.type === 'image/gif' && await animatedGif(convertedFile) || convertedFile.type === 'image/webp' && await animatedWebp(convertedFile)) throw new Error(oversizedAnimatedImageMessage)

  const bitmap = await dependencies.decode(convertedFile)
  try {
    const attempts = [
      { quality: 0.92, scale: 1 }, { quality: 0.82, scale: 1 }, { quality: 0.72, scale: 1 },
      { quality: 0.82, scale: 0.8 }, { quality: 0.78, scale: 0.64 }, { quality: 0.74, scale: 0.5 },
    ]
    for (const attempt of attempts) {
      const blob = await dependencies.encodeWebp(bitmap, attempt.quality, attempt.scale)
      if (blob.size > 0 && blob.size <= embeddedImageByteLimit) return new File([blob], replaceExtension(source.name, 'webp'), { type: 'image/webp' })
    }
  } finally { bitmap.close() }
  throw new Error('This image could not be reduced enough for preview. Choose a smaller image.')
}
