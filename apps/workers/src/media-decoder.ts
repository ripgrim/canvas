import decodeAvif, { init as initAvif } from "@jsquash/avif/decode.js"
import avifModule from "@jsquash/avif/codec/dec/avif_dec.wasm"
import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js"
import jpegModule from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"
import decodePng, { init as initPng } from "@jsquash/png/decode.js"
// @ts-expect-error Wrangler imports this generated WASM declaration as a module value.
import pngModule from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm"
import decodeWebp, { init as initWebp } from "@jsquash/webp/decode.js"
import webpModule from "@jsquash/webp/codec/dec/webp_dec.wasm"
import { decode as decodeGifMetadata, decodeFrames as decodeGifFrames } from "modern-gif"

import { MAX_DECODED_IMAGE_PIXELS, type AssetMediaDecoder } from "@canvas/files"

const initialized = Promise.all([
  initAvif(avifModule),
  initJpeg(jpegModule),
  initPng(pngModule),
  initWebp(webpModule),
])

function validateDecodedPixels(
  image: Readonly<{ width: number; height: number; data: Uint8ClampedArray }>,
) {
  const pixelCount = image.width * image.height
  if (
    !Number.isSafeInteger(pixelCount) ||
    pixelCount <= 0 ||
    pixelCount > MAX_DECODED_IMAGE_PIXELS ||
    image.data.byteLength !== pixelCount * 4
  ) {
    throw new Error("Image decoder returned an invalid pixel buffer")
  }
  return Object.freeze({ width: image.width, height: image.height, pixelCount })
}

function decodeGif(bytes: Uint8Array) {
  const input = bytes.slice().buffer as ArrayBuffer
  const parsed = decodeGifMetadata(input)
  const canvasPixels = parsed.width * parsed.height
  const pixelCount = canvasPixels * parsed.frames.length
  if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0 || pixelCount > MAX_DECODED_IMAGE_PIXELS) {
    throw new Error("GIF exceeds the safe decoded-pixel limit")
  }
  const frames = decodeGifFrames(input, { gif: parsed })
  if (frames.length === 0) throw new Error("GIF decoder returned no frames")
  for (const frame of frames) {
    if (
      frame.width !== parsed.width ||
      frame.height !== parsed.height ||
      frame.data.byteLength !== canvasPixels * 4
    ) {
      throw new Error("GIF decoder returned an invalid pixel buffer")
    }
  }
  return Object.freeze({
    width: parsed.width,
    height: parsed.height,
    pixelCount,
  })
}

export const trustedMediaDecoder: AssetMediaDecoder = Object.freeze({
  async decode(
    extension: "avif" | "gif" | "jpeg" | "jpg" | "png" | "webp",
    bytes: Uint8Array,
  ) {
    await initialized
    if (extension === "gif") return decodeGif(bytes)
    const input = bytes.slice().buffer as ArrayBuffer
    const image = extension === "avif" ? await decodeAvif(input)
      : extension === "png" ? await decodePng(input)
        : extension === "webp" ? await decodeWebp(input)
          : await decodeJpeg(input)
    if (!image) throw new Error("Image decoder returned no pixels")
    return validateDecodedPixels(image)
  },
})
