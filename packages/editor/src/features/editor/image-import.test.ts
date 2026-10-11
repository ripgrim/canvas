import { describe, expect, it, vi } from 'vitest'
import { previewImageMimes } from '@canvas/preview-runtime/protocol'
import { imageMimes } from '@canvas/repo-engine/appearance'
import { embeddedImageByteLimit, prepareImageFile } from './image-import'

const bitmap = { width: 1600, height: 1200, close: vi.fn() }
const dependencies = (outputs: Blob[]) => ({
  convertHeic: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
  decode: vi.fn(async () => bitmap),
  encodeWebp: vi.fn(async () => outputs.shift() ?? new Blob([])),
})
const oversizedGif = (frames: number) => {
  const bytes = new Uint8Array(embeddedImageByteLimit + 1)
  bytes.set(new TextEncoder().encode('GIF89a'))
  bytes.set([1, 0, 1, 0, 0, 0, 0], 6)
  let offset = 13
  for (let frame = 0; frame < frames; frame++) {
    bytes.set([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 0], offset)
    offset += 12
  }
  bytes[offset] = 0x3b
  return new File([bytes], 'motion.gif', { type: 'image/gif' })
}

describe('FILE-ASSET-002 image import normalization', () => {
  it('uses the preview runtime image MIME contract for every stored image MIME', () => {
    expect(previewImageMimes).toEqual(imageMimes)
  })

  it('FILE-ASSET-001 preserves a supported image at the exact preview byte limit', async () => {
    const source = new File([new Uint8Array(embeddedImageByteLimit)], 'still.png', { type: 'image/png' })
    const deps = dependencies([])
    await expect(prepareImageFile(source, deps)).resolves.toBe(source)
    expect(deps.decode).not.toHaveBeenCalled()
  })

  it('FILE-ASSET-SEC-001 normalizes a static image one byte over the preview limit', async () => {
    const source = new File([new Uint8Array(embeddedImageByteLimit + 1)], 'still.png', { type: 'image/png' })
    const deps = dependencies([new Blob(['webp'], { type: 'image/webp' })])
    const result = await prepareImageFile(source, deps)
    expect(result).not.toBe(source)
    expect(result.name).toBe('still.webp')
    expect(result.type).toBe('image/webp')
    expect(result.size).toBeLessThanOrEqual(embeddedImageByteLimit)
  })

  it('preserves an AVIF that fits the preview boundary', async () => {
    const source = new File(['avif'], 'portrait.avif', { type: 'image/avif' })
    const deps = dependencies([])
    await expect(prepareImageFile(source, deps)).resolves.toBe(source)
    expect(deps.decode).not.toHaveBeenCalled()
  })

  it('preserves accepted animation bytes instead of flattening them', async () => {
    const source = new File(['gif'], 'motion.gif', { type: 'image/gif' })
    const deps = dependencies([])
    expect(await prepareImageFile(source, deps)).toBe(source)
    expect(deps.decode).not.toHaveBeenCalled()
  })

  it('rejects an animated WebP one byte over the preview limit instead of flattening its frames', async () => {
    const header = new Uint8Array(embeddedImageByteLimit + 1)
    header.set([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8X')])
    header[20] = 0x02
    const source = new File([header], 'motion.webp', { type: 'image/webp' })
    const deps = dependencies([])
    await expect(prepareImageFile(source, deps)).rejects.toThrow('This animated image exceeds the 1,500,003-byte embedded preview limit. Choose an AVIF, PNG, JPEG, GIF, or WebP image within that limit.')
    expect(deps.decode).not.toHaveBeenCalled()
    expect(deps.encodeWebp).not.toHaveBeenCalled()
  })

  it('normalizes an oversized static GIF but rejects an oversized animated GIF', async () => {
    const staticDeps = dependencies([new Blob(['webp'], { type: 'image/webp' })])
    await expect(prepareImageFile(oversizedGif(1), staticDeps)).resolves.toMatchObject({ name: 'motion.webp', type: 'image/webp' })
    expect(staticDeps.decode).toHaveBeenCalledOnce()

    const animatedDeps = dependencies([])
    await expect(prepareImageFile(oversizedGif(2), animatedDeps)).rejects.toThrow('This animated image exceeds the 1,500,003-byte embedded preview limit. Choose an AVIF, PNG, JPEG, GIF, or WebP image within that limit.')
    expect(animatedDeps.decode).not.toHaveBeenCalled()
  })

  it('converts HEIC to JPEG at the explicit conversion boundary', async () => {
    const source = new File(['heic'], 'portrait.heic', { type: 'image/heic' })
    const deps = dependencies([])
    const result = await prepareImageFile(source, deps)
    expect(deps.convertHeic).toHaveBeenCalledWith(source)
    expect(result.name).toBe('portrait.jpg')
    expect(result.type).toBe('image/jpeg')
  })

  it.each([
    ['empty MIME', ''],
    ['generic MIME', 'application/octet-stream'],
  ])('uses the HEIF extension fallback for %s', async (_, type) => {
    const source = new File(['heif'], 'portrait.HEIF', { type })
    const deps = dependencies([])
    const result = await prepareImageFile(source, deps)
    expect(deps.convertHeic).toHaveBeenCalledWith(source)
    expect(result.name).toBe('portrait.jpg')
    expect(result.type).toBe('image/jpeg')
  })

  it('encodes a browser-decodable unsupported image as bounded WebP', async () => {
    const source = new File(['bmp'], 'scan.bmp', { type: 'image/bmp' })
    const deps = dependencies([new Blob(['webp'], { type: 'image/webp' })])
    const result = await prepareImageFile(source, deps)
    expect(result.name).toBe('scan.webp')
    expect(result.type).toBe('image/webp')
    expect(deps.encodeWebp).toHaveBeenCalledWith(bitmap, 0.92, 1)
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('rejects deceptive non-images before decode', async () => {
    const deps = dependencies([])
    await expect(prepareImageFile(new File(['text'], 'fake.png', { type: 'text/plain' }), deps)).rejects.toThrow('Choose an image up to 25 MB.')
    expect(deps.decode).not.toHaveBeenCalled()
  })
})
