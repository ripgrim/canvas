import { describe, expect, it } from "vitest"

import { FileAssetError } from "../src/contracts.js"
import { validateFileSignature, validateThumbnailImage } from "../src/policy.js"

const AVIF = fixture("AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAdAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAABAAAAAMAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAlbWRhdAoGGBV/vbAIMhMYAAAAUAAAAAoFeVJuQ9k6RgIo")
const JPEG = Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x01, 0xff, 0xd9,
])
const GIF = fixture("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x12, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
  0x05, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00, 0x00,
])

describe("FILE-ASSET-SEC-001 media validation", () => {
  it.each([
    ["jpeg", JPEG],
    ["gif", GIF],
    ["webp", WEBP],
  ] as const)("accepts a complete %s and rejects every one-byte truncation", (extension, complete) => {
    expect(() => validateFileSignature(extension, complete)).not.toThrow()
    for (let length = 0; length < complete.byteLength; length += 1) {
      expectInvalid(() => validateFileSignature(extension, complete.slice(0, length)))
    }
  })

  it("rejects a box-shaped AVIF whose primary item does not point into mdat", () => {
    expect(() => validateThumbnailImage(AVIF)).not.toThrow()
    const malformed = AVIF.slice()
    const extent = find(malformed, [0x00, 0x00, 0x01, 0x21, 0x00, 0x00, 0x00, 0x1d])
    expect(extent).toBeGreaterThan(0)
    malformed.set([0x00, 0x00, 0x00, 0x00], extent)
    expectInvalid(() => validateThumbnailImage(malformed))
  })

  it("rejects an AVIF with an invalid primary AV1 payload while preserving every box", () => {
    const malformed = AVIF.slice()
    const payload = find(malformed, [0x0a, 0x06, 0x18, 0x15, 0x7f])
    expect(payload).toBeGreaterThan(0)
    malformed[payload] = 0x8a
    expectInvalid(() => validateThumbnailImage(malformed))
  })
})

function expectInvalid(run: () => void): void {
  try {
    run()
    throw new Error("validation unexpectedly passed")
  } catch (error) {
    expect(error).toBeInstanceOf(FileAssetError)
    expect((error as FileAssetError).code).toBe("unsupported_media_type")
  }
}

function fixture(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}

function find(bytes: Uint8Array, expected: readonly number[]): number {
  for (let offset = 0; offset <= bytes.byteLength - expected.length; offset += 1) {
    if (expected.every((byte, index) => bytes[offset + index] === byte)) return offset
  }
  return -1
}
