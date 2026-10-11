import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"

import decodeAvif, { init as initAvif } from "@jsquash/avif/decode.js"
import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js"
import decodePng, { init as initPng } from "@jsquash/png/decode.js"
import decodeWebp, { init as initWebp } from "@jsquash/webp/decode.js"
import { decode as decodeGif, decodeFrames as decodeGifFrames } from "modern-gif"
import { describe, expect, it } from "vitest"

const AVIF = fixture("AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAdAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAABAAAAAMAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAlbWRhdAoGGBV/vbAIMhMYAAAAUAAAAAoFeVJuQ9k6RgIo")
const JPEG = fixture("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==")
const PNG = fixture("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6goKBSYeYRwWLQAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMC0xMFQwNTozODozMCswMDowMIU5XnIAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTAtMTBUMDU6Mzg6MzArMDA6MDD0ZObOAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTEwLTEwVDA1OjM4OjMwKzAwOjAwo3HHEQAAAABJRU5ErkJggg==")
const GIF = fixture("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")
const WEBP = fixture("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=")
const STRUCTURAL_ONLY_JPEG = Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x01, 0xff, 0xd9,
])
const require = createRequire(import.meta.url)

describe("trusted Worker media decoders", () => {
  it("FILE-ASSET-SEC-001 decodes pixels and rejects codec-invalid AVIF and JPEG", async () => {
    const [avifWasm, jpegWasm] = await Promise.all([
      compile("@jsquash/avif/codec/dec/avif_dec.wasm"),
      compile("@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"),
    ])
    await Promise.all([initAvif(avifWasm), initJpeg(jpegWasm)])
    await expect(decodeAvif(buffer(AVIF))).resolves.toMatchObject({ width: 64, height: 48 })
    await expect(decodeJpeg(buffer(JPEG))).resolves.toMatchObject({ width: 1, height: 1 })
    const corruptAvif = AVIF.slice()
    corruptAvif[corruptAvif.byteLength - 1] = corruptAvif[corruptAvif.byteLength - 1]! ^ 0xff
    await expect(decodeAvif(buffer(corruptAvif))).rejects.toThrow("Decoding error")
    await expect(decodeJpeg(buffer(STRUCTURAL_ONLY_JPEG))).rejects.toThrow()
  })

  it("FILE-ASSET-SEC-001 decodes PNG, GIF, and WebP pixels and rejects corrupt codec input", async () => {
    const [pngWasm, webpWasm] = await Promise.all([
      compile("@jsquash/png/codec/pkg/squoosh_png_bg.wasm"),
      compile("@jsquash/webp/codec/dec/webp_dec.wasm"),
    ])
    await Promise.all([initPng(pngWasm), initWebp(webpWasm)])
    await expect(decodePng(buffer(PNG))).resolves.toMatchObject({ width: 2, height: 2 })
    const gif = decodeGif(buffer(GIF))
    expect(decodeGifFrames(buffer(GIF), { gif })).toMatchObject([
      { width: 1, height: 1, data: { byteLength: 4 } },
    ])
    await expect(decodeWebp(buffer(WEBP))).resolves.toMatchObject({ width: 2, height: 2 })

    const corruptPng = PNG.slice()
    corruptPng.set([0xff, 0xff], 135)
    await expect(decodePng(buffer(corruptPng))).rejects.toThrow()
    expect(() => decodeGifFrames(buffer(GIF.slice(0, -3)))).toThrow()
    const corruptWebp = WEBP.slice()
    corruptWebp.fill(0, 20)
    await expect(decodeWebp(buffer(corruptWebp))).rejects.toThrow()
  })
})

async function compile(specifier: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await readFile(require.resolve(specifier)))
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

function fixture(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}
