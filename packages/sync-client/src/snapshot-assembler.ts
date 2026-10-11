import { collaborationDocumentSchemaVersion, maxSnapshotBytes, maxSnapshotChunkBytes, maxSnapshotChunks } from '@canvas/sync-protocol'
import type { ServerRoomEnvelope, SnapshotBeginMessage, SnapshotChunkMessage, SnapshotEndMessage } from '@canvas/sync-protocol'

export type SnapshotAssemblerOptions = Readonly<{
  maxBytes?: number
}>

export type SnapshotAssemblerStatus = Readonly<{
  receivedChunkCount: number
  receivedByteLength: number
  stagedCapacityBytes: number
  publicationPeakContentBytesUpperBound: number
  complete: boolean
  verified: boolean
  published: boolean
  disposed: boolean
}>

export const defaultMaxClientSnapshotBytes = maxSnapshotBytes

export type SnapshotPublication = Readonly<{
  requestId: string
  snapshotId: string
  baseSequence: string
  compression: 'none'
  contentEncoding: 'utf-8'
  storedByteLength: number
  documentByteLength: number
  objectDigest: string
  documentDigest: string
  jsonText: string
}>

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const digestPattern = /^[a-f0-9]{64}$/
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const base64Values = new Int16Array(128).fill(-1)
for (let index = 0; index < base64Alphabet.length; index += 1) base64Values[base64Alphabet.charCodeAt(index)] = index

function sameEnvelope(left: ServerRoomEnvelope, right: ServerRoomEnvelope): boolean {
  return left.protocolEpoch === right.protocolEpoch
    && left.schemaVersion === right.schemaVersion
    && left.room.fileId === right.room.fileId
    && left.room.generationId === right.room.generationId
    && left.fenceToken === right.fenceToken
}

function decodedLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function decodeBase64(value: string): Uint8Array {
  if (!value.length || !base64Pattern.test(value)) throw new Error('Snapshot chunk is not valid base64.')
  const result = new Uint8Array(decodedLength(value))
  let output = 0
  for (let input = 0; input < value.length; input += 4) {
    const a = base64Values[value.charCodeAt(input)]!
    const b = base64Values[value.charCodeAt(input + 1)]!
    const third = value[input + 2]
    const fourth = value[input + 3]
    const c = third === '=' ? 0 : base64Values[value.charCodeAt(input + 2)]!
    const d = fourth === '=' ? 0 : base64Values[value.charCodeAt(input + 3)]!
    result[output] = (a << 2) | (b >> 4)
    output += 1
    if (third !== '=') {
      result[output] = ((b & 15) << 4) | (c >> 2)
      output += 1
    }
    if (fourth !== '=') {
      result[output] = ((c & 3) << 6) | d
      output += 1
    }
  }
  return result
}

const roundConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count))
}

class StreamingSha256 {
  private readonly state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  private readonly block = new Uint8Array(64)
  private readonly words = new Uint32Array(64)
  private blockLength = 0
  private byteLength = 0
  private finished = false

  update(bytes: Uint8Array): void {
    if (this.finished) throw new Error('Snapshot digest is already finalized.')
    this.byteLength += bytes.byteLength
    let offset = 0
    if (this.blockLength > 0) {
      const copied = Math.min(64 - this.blockLength, bytes.byteLength)
      this.block.set(bytes.subarray(0, copied), this.blockLength)
      this.blockLength += copied
      offset += copied
      if (this.blockLength === 64) {
        this.compress(this.block, 0)
        this.blockLength = 0
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.compress(bytes, offset)
      offset += 64
    }
    if (offset < bytes.byteLength) {
      this.block.set(bytes.subarray(offset), 0)
      this.blockLength = bytes.byteLength - offset
    }
  }

  digestHex(): string {
    if (this.finished) throw new Error('Snapshot digest is already finalized.')
    this.finished = true
    const bitLength = BigInt(this.byteLength) * 8n
    this.block[this.blockLength] = 0x80
    this.blockLength += 1
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength)
      this.compress(this.block, 0)
      this.blockLength = 0
    }
    this.block.fill(0, this.blockLength, 56)
    for (let index = 0; index < 8; index += 1) this.block[63 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn)
    this.compress(this.block, 0)
    return Array.from(this.state, value => value.toString(16).padStart(8, '0')).join('')
  }

  dispose(): void {
    this.state.fill(0)
    this.block.fill(0)
    this.words.fill(0)
    this.blockLength = 0
    this.byteLength = 0
    this.finished = true
  }

  private compress(block: Uint8Array, blockOffset: number): void {
    const words = this.words
    for (let index = 0; index < 16; index += 1) {
      const offset = blockOffset + index * 4
      words[index] = ((block[offset]! << 24) | (block[offset + 1]! << 16) | (block[offset + 2]! << 8) | block[offset + 3]!) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const before15 = words[index - 15]!
      const before2 = words[index - 2]!
      const small0 = rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3)
      const small1 = rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10)
      words[index] = (words[index - 16]! + small0 + words[index - 7]! + small1) >>> 0
    }
    let a = this.state[0]!
    let b = this.state[1]!
    let c = this.state[2]!
    let d = this.state[3]!
    let e = this.state[4]!
    let f = this.state[5]!
    let g = this.state[6]!
    let h = this.state[7]!
    for (let index = 0; index < 64; index += 1) {
      const big1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const first = (h + big1 + choice + roundConstants[index]! + words[index]!) >>> 0
      const big0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const second = (big0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + first) >>> 0
      d = c
      c = b
      b = a
      a = (first + second) >>> 0
    }
    this.state[0] = (this.state[0]! + a) >>> 0
    this.state[1] = (this.state[1]! + b) >>> 0
    this.state[2] = (this.state[2]! + c) >>> 0
    this.state[3] = (this.state[3]! + d) >>> 0
    this.state[4] = (this.state[4]! + e) >>> 0
    this.state[5] = (this.state[5]! + f) >>> 0
    this.state[6] = (this.state[6]! + g) >>> 0
    this.state[7] = (this.state[7]! + h) >>> 0
  }
}

export function createSnapshotAssembler(begin: SnapshotBeginMessage, options: SnapshotAssemblerOptions = {}) {
  const expected = Object.freeze({
    requestId: begin.requestId,
    snapshotId: begin.snapshotId,
    envelope: Object.freeze({
      protocolEpoch: begin.envelope.protocolEpoch,
      schemaVersion: begin.envelope.schemaVersion,
      room: Object.freeze({ fileId: begin.envelope.room.fileId, generationId: begin.envelope.room.generationId }),
      fenceToken: begin.envelope.fenceToken,
    }),
    documentSchemaVersion: begin.documentSchemaVersion,
    baseSequence: begin.baseSequence,
    compression: begin.compression,
    contentEncoding: begin.contentEncoding,
    storedByteLength: begin.storedByteLength,
    documentByteLength: begin.documentByteLength,
    objectDigest: begin.objectDigest,
    documentDigest: begin.documentDigest,
    chunkCount: begin.chunkCount,
  })
  const limit = options.maxBytes ?? defaultMaxClientSnapshotBytes
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxSnapshotBytes) throw new Error('Invalid snapshot byte limit.')
  if (expected.documentSchemaVersion !== collaborationDocumentSchemaVersion || expected.compression !== 'none' || expected.contentEncoding !== 'utf-8') throw new Error('Snapshot compression, content encoding, or document schema is unsupported.')
  if (expected.storedByteLength < 1 || expected.documentByteLength < 1 || expected.storedByteLength > limit || expected.documentByteLength > limit) throw new Error('Snapshot exceeds the supported client byte limit.')
  if (expected.storedByteLength !== expected.documentByteLength) throw new Error('Uncompressed snapshot byte lengths must match.')
  if (!digestPattern.test(expected.objectDigest) || !digestPattern.test(expected.documentDigest)) throw new Error('Snapshot digest is invalid.')
  if (expected.chunkCount < 1 || expected.chunkCount > maxSnapshotChunks || expected.chunkCount !== Math.ceil(expected.storedByteLength / maxSnapshotChunkBytes)) {
    throw new Error('Snapshot chunk count is inconsistent with its byte length.')
  }

  let bytes: Uint8Array | null = new Uint8Array(expected.storedByteLength)
  const hash = new StreamingSha256()
  let receivedChunkCount = 0
  let receivedByteLength = 0
  let verifiedDigest: string | null = null
  let published = false
  let disposed = false

  const wipe = (terminal: boolean) => {
    bytes?.fill(0)
    bytes = null
    hash.dispose()
    if (terminal) {
      verifiedDigest = null
      disposed = true
    }
  }

  const terminalFailure = (error: unknown): never => {
    wipe(true)
    throw error instanceof Error ? error : new Error('Snapshot assembly failed.')
  }

  const status = (): SnapshotAssemblerStatus => Object.freeze({
    receivedChunkCount,
    receivedByteLength,
    stagedCapacityBytes: bytes?.byteLength ?? 0,
    // Byte staging plus a worst-case two-byte JS code unit per validated UTF-8 byte. Runtime and object overhead are excluded.
    publicationPeakContentBytesUpperBound: expected.documentByteLength * 3,
    complete: receivedChunkCount === expected.chunkCount && receivedByteLength === expected.storedByteLength,
    verified: verifiedDigest !== null,
    published,
    disposed,
  })

  const requireActive = () => {
    if (disposed) throw new Error('Snapshot assembler is disposed.')
    if (published) throw new Error('Snapshot was already published.')
  }

  const assertContext = (message: SnapshotChunkMessage | SnapshotEndMessage) => {
    if (message.requestId !== expected.requestId) throw new Error('Snapshot request does not match.')
    if (message.snapshotId !== expected.snapshotId) throw new Error('Snapshot id does not match.')
    if (!sameEnvelope(message.envelope, expected.envelope)) throw new Error('Snapshot room envelope does not match.')
  }

  return Object.freeze({
    getStatus: status,
    push(message: SnapshotChunkMessage) {
      requireActive()
      try {
        if (verifiedDigest) throw new Error('Snapshot digest is already verified.')
        assertContext(message)
        if (message.chunkCount !== expected.chunkCount) throw new Error('Snapshot chunk count does not match.')
        if (message.chunkIndex !== receivedChunkCount) {
          throw new Error(message.chunkIndex < receivedChunkCount ? 'Snapshot chunk is duplicated.' : 'Snapshot chunk is out of order.')
        }
        const chunk = decodeBase64(message.data)
        const expectedLength = message.chunkIndex === expected.chunkCount - 1
          ? expected.storedByteLength - maxSnapshotChunkBytes * (expected.chunkCount - 1)
          : maxSnapshotChunkBytes
        if (chunk.byteLength !== expectedLength) throw new Error('Snapshot chunk byte length does not match.')
        if (receivedByteLength + chunk.byteLength > expected.storedByteLength) throw new Error('Snapshot exceeds its declared stored byte length.')
        bytes!.set(chunk, receivedByteLength)
        hash.update(chunk)
        receivedByteLength += chunk.byteLength
        receivedChunkCount += 1
        return status()
      } catch (error) {
        return terminalFailure(error)
      }
    },
    finish(message: SnapshotEndMessage) {
      requireActive()
      try {
        assertContext(message)
        if (receivedChunkCount !== expected.chunkCount || receivedByteLength !== expected.storedByteLength) throw new Error('Snapshot is incomplete.')
        const actual = hash.digestHex()
        if (actual !== expected.objectDigest) throw new Error('Snapshot object digest does not match.')
        if (actual !== expected.documentDigest) throw new Error('Snapshot document digest does not match.')
        verifiedDigest = actual
        hash.dispose()
        return status()
      } catch (error) {
        return terminalFailure(error)
      }
    },
    publish(): SnapshotPublication {
      requireActive()
      if (!verifiedDigest || receivedChunkCount !== expected.chunkCount || receivedByteLength !== expected.storedByteLength) throw new Error('Snapshot is not ready to publish.')
      let jsonText: string
      try {
        jsonText = new TextDecoder('utf-8', { fatal: true }).decode(bytes!)
      } catch {
        return terminalFailure(new Error('Snapshot is not valid UTF-8.'))
      }
      const publication = Object.freeze({
        requestId: expected.requestId,
        snapshotId: expected.snapshotId,
        baseSequence: expected.baseSequence,
        compression: expected.compression,
        contentEncoding: expected.contentEncoding,
        storedByteLength: expected.storedByteLength,
        documentByteLength: expected.documentByteLength,
        objectDigest: expected.objectDigest,
        documentDigest: expected.documentDigest,
        jsonText,
      })
      wipe(false)
      published = true
      return publication
    },
    dispose() {
      if (disposed) return status()
      wipe(true)
      return status()
    },
  })
}
