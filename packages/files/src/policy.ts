import type {
  AssetExtension,
  ThumbnailUploadIntentRequest,
  UploadIntentRequest,
} from "./contracts.js"
import { FileAssetError } from "./contracts.js"
import {
  assertAssetDescriptor,
  assertIdentifier,
  contentTypeForExtension,
} from "./keys.js"

export const MAX_ASSET_BYTES = 25 * 1024 * 1024
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
export const MAX_THUMBNAIL_WIDTH = 1024
export const MAX_THUMBNAIL_HEIGHT = 768
export const MAX_DECODED_IMAGE_PIXELS = 16 * 1024 * 1024

export type ImageDimensions = Readonly<{ width: number; height: number }>

const FONT_EXTENSIONS = new Set<AssetExtension>(["woff", "woff2"])

export function validateUploadRequest(
  request: UploadIntentRequest,
): UploadIntentRequest {
  assertAssetDescriptor(request)
  if (!Number.isSafeInteger(request.size) || request.size <= 0) {
    throw new FileAssetError("bad_request", "size must be a positive integer", 400)
  }
  if (request.size > MAX_ASSET_BYTES) {
    throw new FileAssetError(
      "payload_too_large",
      "File is larger than 25 MiB",
      413,
    )
  }
  if (request.contentType !== contentTypeForExtension(request.extension)) {
    throw new FileAssetError(
      "unsupported_media_type",
      "Content type does not match the file extension",
      415,
    )
  }
  return request
}

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => bytes[index] === byte)
}

function asciiAt(bytes: Uint8Array, start: number, text: string): boolean {
  return [...text].every((character, index) => bytes[start + index] === character.charCodeAt(0))
}

function invalidFileContents(): never {
  throw new FileAssetError(
    "unsupported_media_type",
    "File contents do not match the file type",
    415,
  )
}

function u32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) invalidFileContents()
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  ) >>> 0
}

function u16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) invalidFileContents()
  return bytes[offset]! * 0x100 + bytes[offset + 1]!
}

function u32le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) invalidFileContents()
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000 +
    bytes[offset + 3]! * 0x1000000
  ) >>> 0
}

function validatePng(bytes: Uint8Array): Readonly<{ width: number; height: number }> {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    invalidFileContents()
  }
  let offset = 8
  let dimensions: Readonly<{ width: number; height: number }> | null = null
  let sawImageData = false
  let sawEnd = false
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) invalidFileContents()
    const length = u32(bytes, offset)
    const typeOffset = offset + 4
    const dataOffset = offset + 8
    const end = dataOffset + length
    if (!Number.isSafeInteger(end) || end + 4 > bytes.byteLength) invalidFileContents()
    const type = String.fromCharCode(...bytes.subarray(typeOffset, typeOffset + 4))
    if (crc32(bytes, typeOffset, end) !== u32(bytes, end)) invalidFileContents()
    if (dimensions === null) {
      if (type !== "IHDR" || length !== 13) invalidFileContents()
      const width = u32(bytes, dataOffset)
      const height = u32(bytes, dataOffset + 4)
      const bitDepth = bytes[dataOffset + 8]!
      const colorType = bytes[dataOffset + 9]!
      const validDepth = colorType === 0
        ? [1, 2, 4, 8, 16].includes(bitDepth)
        : colorType === 2
          ? [8, 16].includes(bitDepth)
          : colorType === 3
            ? [1, 2, 4, 8].includes(bitDepth)
            : (colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth)
      if (
        width === 0 ||
        height === 0 ||
        !validDepth ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        (bytes[dataOffset + 12] !== 0 && bytes[dataOffset + 12] !== 1)
      ) invalidFileContents()
      dimensions = { width, height }
    } else if (type === "IHDR") {
      invalidFileContents()
    }
    if (type === "IDAT" && length > 0) sawImageData = true
    offset = end + 4
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.byteLength) invalidFileContents()
      sawEnd = true
      break
    }
  }
  if (!dimensions || !sawImageData || !sawEnd) invalidFileContents()
  return dimensions
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]!
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

type MediaBox = Readonly<{
  type: string
  start: number
  payloadStart: number
  end: number
}>

function readBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
): readonly MediaBox[] {
  const boxes: MediaBox[] = []
  let offset = start
  while (offset < end) {
    if (offset + 8 > end) invalidFileContents()
    const size32 = u32(bytes, offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    let headerSize = 8
    let size = size32
    if (size32 === 1) {
      if (offset + 16 > end) invalidFileContents()
      const high = u32(bytes, offset + 8)
      const low = u32(bytes, offset + 12)
      const large = BigInt(high) << 32n | BigInt(low)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) invalidFileContents()
      size = Number(large)
      headerSize = 16
    } else if (size32 === 0) {
      size = end - offset
    }
    if (size < headerSize || offset + size > end) invalidFileContents()
    const payloadStart = offset + headerSize
    const boxEnd = offset + size
    boxes.push({ type, start: offset, payloadStart, end: boxEnd })
    offset = boxEnd
    if (size32 === 0 && offset !== end) invalidFileContents()
  }
  if (offset !== end) invalidFileContents()
  return boxes
}

function onlyBox(boxes: readonly MediaBox[], type: string): MediaBox {
  const matches = boxes.filter(box => box.type === type)
  if (matches.length !== 1) invalidFileContents()
  return matches[0]!
}

function readSizedInteger(bytes: Uint8Array, offset: number, size: number): number {
  if (size < 0 || size > 8 || offset + size > bytes.byteLength) invalidFileContents()
  let value = 0n
  for (let index = 0; index < size; index += 1) {
    value = value << 8n | BigInt(bytes[offset + index]!)
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalidFileContents()
  return Number(value)
}

function primaryItemId(bytes: Uint8Array, pitm: MediaBox): number {
  if (pitm.end - pitm.payloadStart < 6) invalidFileContents()
  const version = bytes[pitm.payloadStart]!
  if (version === 0) {
    if (pitm.end - pitm.payloadStart !== 6) invalidFileContents()
    return u16(bytes, pitm.payloadStart + 4)
  }
  if (version === 1) {
    if (pitm.end - pitm.payloadStart !== 8) invalidFileContents()
    return u32(bytes, pitm.payloadStart + 4)
  }
  return invalidFileContents()
}

function primaryItemIsAv1(bytes: Uint8Array, iinf: MediaBox, primaryId: number): boolean {
  if (iinf.end - iinf.payloadStart < 6) invalidFileContents()
  const version = bytes[iinf.payloadStart]!
  const countSize = version === 0 ? 2 : 4
  const countOffset = iinf.payloadStart + 4
  const count = countSize === 2 ? u16(bytes, countOffset) : u32(bytes, countOffset)
  const entries = readBoxes(bytes, countOffset + countSize, iinf.end)
  if (entries.length !== count || entries.some(entry => entry.type !== "infe")) {
    invalidFileContents()
  }
  return entries.some(entry => {
    const entryVersion = bytes[entry.payloadStart]
    if (entryVersion !== 2 && entryVersion !== 3) return false
    const idOffset = entry.payloadStart + 4
    const itemId = entryVersion === 2 ? u16(bytes, idOffset) : u32(bytes, idOffset)
    const typeOffset = idOffset + (entryVersion === 2 ? 4 : 6)
    return itemId === primaryId && asciiAt(bytes, typeOffset, "av01")
  })
}

function primaryItemExtents(
  bytes: Uint8Array,
  iloc: MediaBox,
  primaryId: number,
): readonly Readonly<{ start: number; end: number }>[] {
  const payload = iloc.payloadStart
  if (iloc.end - payload < 8) invalidFileContents()
  const version = bytes[payload]!
  if (version > 2) invalidFileContents()
  const offsetSize = bytes[payload + 4]! >>> 4
  const lengthSize = bytes[payload + 4]! & 0x0f
  const baseOffsetSize = bytes[payload + 5]! >>> 4
  const indexSize = version > 0 ? bytes[payload + 5]! & 0x0f : 0
  if (offsetSize > 8 || lengthSize === 0 || lengthSize > 8 || baseOffsetSize > 8 || indexSize > 8) {
    invalidFileContents()
  }
  let cursor = payload + 6
  const itemCount = version < 2 ? u16(bytes, cursor) : u32(bytes, cursor)
  cursor += version < 2 ? 2 : 4
  let primary: readonly Readonly<{ start: number; end: number }>[] | null = null
  for (let item = 0; item < itemCount; item += 1) {
    const itemId = version < 2 ? u16(bytes, cursor) : u32(bytes, cursor)
    cursor += version < 2 ? 2 : 4
    let constructionMethod = 0
    if (version > 0) {
      constructionMethod = u16(bytes, cursor) & 0x000f
      cursor += 2
    }
    const dataReferenceIndex = u16(bytes, cursor)
    cursor += 2
    const baseOffset = readSizedInteger(bytes, cursor, baseOffsetSize)
    cursor += baseOffsetSize
    const extentCount = u16(bytes, cursor)
    cursor += 2
    const extents: Array<Readonly<{ start: number; end: number }>> = []
    for (let extent = 0; extent < extentCount; extent += 1) {
      cursor += indexSize
      const extentOffset = readSizedInteger(bytes, cursor, offsetSize)
      cursor += offsetSize
      const extentLength = readSizedInteger(bytes, cursor, lengthSize)
      cursor += lengthSize
      const start = baseOffset + extentOffset
      const end = start + extentLength
      if (!extentLength || !Number.isSafeInteger(end)) invalidFileContents()
      extents.push({ start, end })
    }
    if (itemId === primaryId) {
      if (primary || constructionMethod !== 0 || dataReferenceIndex !== 0 || extents.length === 0) {
        invalidFileContents()
      }
      primary = extents
    }
  }
  if (cursor !== iloc.end || !primary) invalidFileContents()
  return primary
}

function primaryItemProperties(
  bytes: Uint8Array,
  iprp: MediaBox,
  primaryId: number,
): Readonly<{ width: number; height: number }> {
  const iprpChildren = readBoxes(bytes, iprp.payloadStart, iprp.end)
  const ipco = onlyBox(iprpChildren, "ipco")
  const ipma = onlyBox(iprpChildren, "ipma")
  const properties = readBoxes(bytes, ipco.payloadStart, ipco.end)
  if (ipma.end - ipma.payloadStart < 8) invalidFileContents()
  const version = bytes[ipma.payloadStart]!
  const flags = u32(bytes, ipma.payloadStart) & 0x00ffffff
  if (version > 1) invalidFileContents()
  let cursor = ipma.payloadStart + 4
  const entryCount = u32(bytes, cursor)
  cursor += 4
  let associations: number[] | null = null
  for (let entry = 0; entry < entryCount; entry += 1) {
    const itemId = version < 1 ? u16(bytes, cursor) : u32(bytes, cursor)
    cursor += version < 1 ? 2 : 4
    if (cursor >= ipma.end) invalidFileContents()
    const associationCount = bytes[cursor++]!
    const indexes: number[] = []
    for (let association = 0; association < associationCount; association += 1) {
      const raw = flags & 1 ? u16(bytes, cursor) : bytes[cursor]!
      cursor += flags & 1 ? 2 : 1
      const index = raw & (flags & 1 ? 0x7fff : 0x7f)
      if (index === 0 || index > properties.length) invalidFileContents()
      indexes.push(index)
    }
    if (itemId === primaryId) {
      if (associations) invalidFileContents()
      associations = indexes
    }
  }
  if (cursor !== ipma.end || !associations) invalidFileContents()
  const associated = associations.map(index => properties[index - 1]!)
  const ispe = onlyBox(associated, "ispe")
  const av1c = onlyBox(associated, "av1C")
  if (
    av1c.end - av1c.payloadStart < 4 ||
    bytes[av1c.payloadStart] !== 0x81 ||
    ispe.end - ispe.payloadStart !== 12 ||
    u32(bytes, ispe.payloadStart) !== 0
  ) {
    invalidFileContents()
  }
  const width = u32(bytes, ispe.payloadStart + 4)
  const height = u32(bytes, ispe.payloadStart + 8)
  if (!width || !height) invalidFileContents()
  return { width, height }
}

function validateAv1Item(bytes: Uint8Array): void {
  let offset = 0
  let sawSequenceHeader = false
  let sawFrame = false
  while (offset < bytes.byteLength) {
    const header = bytes[offset++]!
    const obuType = header >>> 3 & 0x0f
    const extension = Boolean(header & 0x04)
    const hasSize = Boolean(header & 0x02)
    if (header & 0x81 || obuType === 0 || !hasSize) invalidFileContents()
    if (extension) {
      if (offset >= bytes.byteLength || bytes[offset]! & 0x07) invalidFileContents()
      offset += 1
    }
    let size = 0
    let shift = 0
    let terminated = false
    for (let index = 0; index < 8 && offset < bytes.byteLength; index += 1) {
      const byte = bytes[offset++]!
      size += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) {
        terminated = true
        break
      }
      shift += 7
    }
    if (
      !terminated ||
      !Number.isSafeInteger(size) ||
      (size === 0 && obuType !== 2 && obuType !== 15) ||
      offset + size > bytes.byteLength
    ) {
      invalidFileContents()
    }
    sawSequenceHeader ||= obuType === 1
    sawFrame ||= obuType === 3 || obuType === 6
    offset += size
  }
  if (!sawSequenceHeader || !sawFrame) invalidFileContents()
}

function validateAvif(bytes: Uint8Array): Readonly<{ width: number; height: number }> {
  const topLevel = readBoxes(bytes, 0, bytes.byteLength)
  const ftyp = onlyBox(topLevel, "ftyp")
  const meta = onlyBox(topLevel, "meta")
  const mediaData = topLevel.filter(box => box.type === "mdat")
  if (!mediaData.length || ftyp.end - ftyp.payloadStart < 8 || (ftyp.end - ftyp.payloadStart) % 4 !== 0) {
    invalidFileContents()
  }
  let compatible = false
  for (let offset = ftyp.payloadStart; offset < ftyp.end; offset += 4) {
    if (offset !== ftyp.payloadStart + 4) {
      compatible ||= asciiAt(bytes, offset, "avif") || asciiAt(bytes, offset, "avis")
    }
  }
  if (!compatible || meta.end - meta.payloadStart < 4) invalidFileContents()
  const metaChildren = readBoxes(bytes, meta.payloadStart + 4, meta.end)
  const primaryId = primaryItemId(bytes, onlyBox(metaChildren, "pitm"))
  if (!primaryItemIsAv1(bytes, onlyBox(metaChildren, "iinf"), primaryId)) {
    invalidFileContents()
  }
  const dimensions = primaryItemProperties(bytes, onlyBox(metaChildren, "iprp"), primaryId)
  const extents = primaryItemExtents(bytes, onlyBox(metaChildren, "iloc"), primaryId)
  const itemParts = extents.map(extent => {
    const container = mediaData.find(box => (
      extent.start >= box.payloadStart && extent.end <= box.end
    ))
    if (!container) invalidFileContents()
    return bytes.subarray(extent.start, extent.end)
  })
  const itemSize = itemParts.reduce((total, part) => total + part.byteLength, 0)
  const item = new Uint8Array(itemSize)
  let itemOffset = 0
  for (const part of itemParts) {
    item.set(part, itemOffset)
    itemOffset += part.byteLength
  }
  validateAv1Item(item)
  return dimensions
}

function validateJpeg(bytes: Uint8Array): ImageDimensions {
  if (!startsWith(bytes, [0xff, 0xd8])) invalidFileContents()
  let offset = 2
  let sawFrame = false
  let sawScan = false
  let dimensions: ImageDimensions | null = null
  while (offset < bytes.byteLength) {
    if (bytes[offset++] !== 0xff) invalidFileContents()
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.byteLength) invalidFileContents()
    const marker = bytes[offset++]!
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || offset !== bytes.byteLength) invalidFileContents()
      return dimensions!
    }
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      invalidFileContents()
    }
    const length = u16(bytes, offset)
    if (length < 2 || offset + length > bytes.byteLength) invalidFileContents()
    const dataStart = offset + 2
    const dataEnd = offset + length
    const isFrame = (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isFrame) {
      const height = u16(bytes, dataStart + 1)
      const width = u16(bytes, dataStart + 3)
      if (length < 8 || !width || !height) invalidFileContents()
      dimensions = { width, height }
      sawFrame = true
    }
    offset = dataEnd
    if (marker === 0xda) {
      sawScan = true
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          offset += 1
          continue
        }
        if (offset + 1 >= bytes.byteLength) invalidFileContents()
        const next = bytes[offset + 1]!
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2
          continue
        }
        break
      }
    }
  }
  invalidFileContents()
}

function skipGifSubBlocks(bytes: Uint8Array, offset: number): number {
  while (true) {
    if (offset >= bytes.byteLength) invalidFileContents()
    const length = bytes[offset++]!
    if (length === 0) return offset
    if (offset + length > bytes.byteLength) invalidFileContents()
    offset += length
  }
}

function validateGif(bytes: Uint8Array): ImageDimensions {
  if (!(asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) || bytes.byteLength < 14) {
    invalidFileContents()
  }
  const dimensions = { width: u16le(bytes, 6), height: u16le(bytes, 8) }
  if (!dimensions.width || !dimensions.height) invalidFileContents()
  let offset = 13
  const packed = bytes[10]!
  if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1)
  if (offset > bytes.byteLength) invalidFileContents()
  let sawImage = false
  while (offset < bytes.byteLength) {
    const introducer = bytes[offset++]!
    if (introducer === 0x3b) {
      if (!sawImage || offset !== bytes.byteLength) invalidFileContents()
      return dimensions
    }
    if (introducer === 0x21) {
      if (offset >= bytes.byteLength) invalidFileContents()
      offset += 1
      offset = skipGifSubBlocks(bytes, offset)
      continue
    }
    if (introducer !== 0x2c || offset + 9 > bytes.byteLength) invalidFileContents()
    const width = u16le(bytes, offset + 4)
    const height = u16le(bytes, offset + 6)
    const imagePacked = bytes[offset + 8]!
    if (!width || !height) invalidFileContents()
    offset += 9
    if (imagePacked & 0x80) offset += 3 * 2 ** ((imagePacked & 0x07) + 1)
    if (offset >= bytes.byteLength) invalidFileContents()
    const minimumCodeSize = bytes[offset++]!
    if (minimumCodeSize < 2 || minimumCodeSize > 8) invalidFileContents()
    const dataStart = offset
    offset = skipGifSubBlocks(bytes, offset)
    if (offset <= dataStart + 1) invalidFileContents()
    sawImage = true
  }
  invalidFileContents()
}

function validateWebp(bytes: Uint8Array): ImageDimensions {
  if (!asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP") || bytes.byteLength < 20) {
    invalidFileContents()
  }
  if (u32le(bytes, 4) !== bytes.byteLength - 8) invalidFileContents()
  let offset = 12
  let imageChunks = 0
  let imageDimensions: ImageDimensions | null = null
  let canvasDimensions: ImageDimensions | null = null
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) invalidFileContents()
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const size = u32le(bytes, offset + 4)
    const payload = offset + 8
    const end = payload + size
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) invalidFileContents()
    if (type === "VP8 ") {
      if (size < 10 || !startsWith(bytes.subarray(payload + 3), [0x9d, 0x01, 0x2a])) invalidFileContents()
      const width = u16le(bytes, payload + 6) & 0x3fff
      const height = u16le(bytes, payload + 8) & 0x3fff
      if (!width || !height) invalidFileContents()
      imageDimensions = { width, height }
      imageChunks += 1
    } else if (type === "VP8L") {
      if (size < 5 || bytes[payload] !== 0x2f) invalidFileContents()
      const packed = u32le(bytes, payload + 1)
      if ((packed >>> 28) !== 0) invalidFileContents()
      imageDimensions = {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      }
      imageChunks += 1
    } else if (type === "VP8X") {
      if (size !== 10 || bytes[payload]! & 0xc1) {
        invalidFileContents()
      }
      if (canvasDimensions) invalidFileContents()
      canvasDimensions = {
        width: u24le(bytes, payload + 4) + 1,
        height: u24le(bytes, payload + 7) + 1,
      }
    }
    offset = end + (size & 1)
    if (offset > bytes.byteLength) invalidFileContents()
  }
  if (offset !== bytes.byteLength || imageChunks !== 1 || !imageDimensions) {
    invalidFileContents()
  }
  if (
    canvasDimensions &&
    (imageDimensions.width > canvasDimensions.width ||
      imageDimensions.height > canvasDimensions.height)
  ) invalidFileContents()
  return canvasDimensions ?? imageDimensions
}

function u16le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) invalidFileContents()
  return bytes[offset]! + bytes[offset + 1]! * 0x100
}

function u24le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 3 > bytes.byteLength) invalidFileContents()
  return bytes[offset]! + bytes[offset + 1]! * 0x100 + bytes[offset + 2]! * 0x10000
}

export function validateFileSignature(
  extension: AssetExtension,
  bytes: Uint8Array,
): ImageDimensions | null {
  const result = (() => {
    switch (extension) {
      case "png":
        return validatePng(bytes)
      case "jpg":
      case "jpeg":
        return validateJpeg(bytes)
      case "gif":
        return validateGif(bytes)
      case "webp":
        return validateWebp(bytes)
      case "avif":
        return validateAvif(bytes)
      case "woff":
        if (!asciiAt(bytes, 0, "wOFF")) invalidFileContents()
        return null
      case "woff2":
        if (!asciiAt(bytes, 0, "wOF2")) invalidFileContents()
        return null
    }
  })()
  return result
}

export function validateThumbnailImage(bytes: Uint8Array): ImageDimensions {
  const dimensions = validateAvif(bytes)
  if (
    dimensions.width > MAX_THUMBNAIL_WIDTH ||
    dimensions.height > MAX_THUMBNAIL_HEIGHT
  ) {
    throw new FileAssetError(
      "unsupported_media_type",
      `Thumbnail dimensions must not exceed ${MAX_THUMBNAIL_WIDTH} by ${MAX_THUMBNAIL_HEIGHT}`,
      415,
    )
  }
  return dimensions
}

export function cacheControlForExtension(extension: AssetExtension): string {
  return FONT_EXTENSIONS.has(extension)
    ? "private, max-age=31536000, immutable"
    : "private, max-age=31536000, immutable"
}

export function validateThumbnail(size: number, contentType: string): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new FileAssetError("bad_request", "Content-Length is required", 411)
  }
  if (size > MAX_THUMBNAIL_BYTES) {
    throw new FileAssetError(
      "payload_too_large",
      "Thumbnail is larger than 2 MiB",
      413,
    )
  }
  if (contentType !== "image/avif") {
    throw new FileAssetError(
      "unsupported_media_type",
      "Thumbnail must be AVIF",
      415,
    )
  }
}

export function validateThumbnailUploadRequest(
  request: ThumbnailUploadIntentRequest,
): ThumbnailUploadIntentRequest {
  assertIdentifier(request.fileId, "fileId")
  if (
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0 ||
    request.expectedRevision === Number.MAX_SAFE_INTEGER
  ) {
    throw new FileAssetError("bad_request", "expectedRevision is invalid", 400)
  }
  validateThumbnail(request.size, request.contentType)
  return request
}
