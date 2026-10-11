import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  collaborationDocumentSchemaVersion,
  collaborationEnvelopeSchemaVersion,
  collaborationProtocolEpoch,
  maxSnapshotBytes,
  maxSnapshotChunkBytes,
} from '@canvas/sync-protocol'
import type { ServerRoomEnvelope, SnapshotBeginMessage, SnapshotChunkMessage, SnapshotEndMessage } from '@canvas/sync-protocol'
import { createSnapshotAssembler, defaultMaxClientSnapshotBytes } from '../src/snapshot-assembler.js'

const roomEnvelope: ServerRoomEnvelope = {
  protocolEpoch: collaborationProtocolEpoch,
  schemaVersion: collaborationEnvelopeSchemaVersion,
  room: { fileId: '11111111-1111-4111-8111-111111111111', generationId: '22222222-2222-4222-8222-222222222222' },
  fenceToken: '9',
}

function beginFor(bytes: Uint8Array, envelope = roomEnvelope): SnapshotBeginMessage {
  const digest = createHash('sha256').update(bytes).digest('hex')
  return {
    type: 'snapshot.begin',
    envelope,
    requestId: 'request-1',
    snapshotId: 'snapshot-1',
    documentSchemaVersion: collaborationDocumentSchemaVersion,
    baseSequence: '41',
    compression: 'none',
    contentEncoding: 'utf-8',
    storedByteLength: bytes.byteLength,
    documentByteLength: bytes.byteLength,
    objectDigest: digest,
    documentDigest: digest,
    chunkCount: Math.ceil(bytes.byteLength / maxSnapshotChunkBytes),
  }
}

function chunkFor(bytes: Uint8Array, index: number, begin = beginFor(bytes)): SnapshotChunkMessage {
  const start = index * maxSnapshotChunkBytes
  const chunk = bytes.subarray(start, Math.min(start + maxSnapshotChunkBytes, bytes.byteLength))
  return {
    type: 'snapshot.chunk',
    envelope: begin.envelope,
    requestId: begin.requestId,
    snapshotId: begin.snapshotId,
    chunkIndex: index,
    chunkCount: begin.chunkCount,
    data: Buffer.from(chunk).toString('base64'),
  }
}

function endFor(bytes: Uint8Array, begin = beginFor(bytes)): SnapshotEndMessage {
  void bytes
  return {
    type: 'snapshot.end',
    envelope: begin.envelope,
    requestId: begin.requestId,
    snapshotId: begin.snapshotId,
  }
}

describe('unit coverage for CLOUD-SYNC-CHECKPOINT-001 snapshot assembly', () => {
  it('verifies SHA-256 incrementally and publishes one immutable value', () => {
    const bytes = new TextEncoder().encode('{"hello":"world"}')
    const begin = beginFor(bytes)
    const assembler = createSnapshotAssembler(begin)

    assembler.push(chunkFor(bytes, 0, begin))
    assembler.finish(endFor(bytes, begin))
    const published = assembler.publish()

    expect(published).toEqual({
      requestId: 'request-1',
      snapshotId: 'snapshot-1',
      baseSequence: '41',
      compression: 'none',
      contentEncoding: 'utf-8',
      storedByteLength: 17,
      documentByteLength: 17,
      objectDigest: '93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588',
      documentDigest: '93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588',
      jsonText: '{"hello":"world"}',
    })
    expect(Object.isFrozen(published)).toBe(true)
    expect(assembler.getStatus()).toMatchObject({
      receivedChunkCount: 1,
      receivedByteLength: 17,
      stagedCapacityBytes: 0,
      publicationPeakContentBytesUpperBound: 51,
      complete: true,
      verified: true,
      published: true,
    })
    expect(() => assembler.publish()).toThrow('already published')
  })

  it('rejects duplicate, out-of-order, and out-of-range chunks', () => {
    const bytes = new Uint8Array(maxSnapshotChunkBytes + 1).fill(97)
    const begin = beginFor(bytes)

    const duplicate = createSnapshotAssembler(begin)
    duplicate.push(chunkFor(bytes, 0, begin))
    expect(() => duplicate.push(chunkFor(bytes, 0, begin))).toThrow('duplicated')
    expect(duplicate.getStatus()).toMatchObject({ disposed: true, stagedCapacityBytes: 0 })

    const outOfOrder = createSnapshotAssembler(begin)
    expect(() => outOfOrder.push(chunkFor(bytes, 1, begin))).toThrow('out of order')
    expect(outOfOrder.getStatus()).toMatchObject({ disposed: true, stagedCapacityBytes: 0 })

    const outOfRange = createSnapshotAssembler(begin)
    expect(() => outOfRange.push({ ...chunkFor(bytes, 0, begin), chunkIndex: begin.chunkCount })).toThrow('out of order')
    expect(outOfRange.getStatus()).toMatchObject({ disposed: true, stagedCapacityBytes: 0 })
  })

  it('rejects missing chunks and publication before completion', () => {
    const bytes = new Uint8Array(maxSnapshotChunkBytes + 1).fill(98)
    const begin = beginFor(bytes)
    const assembler = createSnapshotAssembler(begin)
    assembler.push(chunkFor(bytes, 0, begin))

    expect(() => assembler.finish(endFor(bytes, begin))).toThrow('incomplete')
    expect(assembler.getStatus()).toMatchObject({ disposed: true, stagedCapacityBytes: 0 })

    const publishEarly = createSnapshotAssembler(begin)
    expect(() => publishEarly.publish()).toThrow('not ready to publish')
    expect(publishEarly.getStatus()).toMatchObject({ disposed: false, stagedCapacityBytes: bytes.byteLength })
  })

  it('rejects request, snapshot, envelope, and chunk-count mismatches', () => {
    const bytes = new TextEncoder().encode('{}')
    const begin = beginFor(bytes)
    const base = chunkFor(bytes, 0, begin)

    expect(() => createSnapshotAssembler(begin).push({ ...base, requestId: 'request-2' })).toThrow('request does not match')
    expect(() => createSnapshotAssembler(begin).push({ ...base, snapshotId: 'snapshot-2' })).toThrow('id does not match')
    expect(() => createSnapshotAssembler(begin).push({ ...base, envelope: { ...roomEnvelope, fenceToken: '10' } })).toThrow('envelope does not match')
    expect(() => createSnapshotAssembler(begin).push({ ...base, chunkCount: 2 })).toThrow('chunk count does not match')
  })

  it('captures immutable begin metadata before receiving chunks', () => {
    const bytes = new TextEncoder().encode('{}')
    const begin = beginFor(bytes, { ...roomEnvelope, room: { ...roomEnvelope.room } })
    const original = chunkFor(bytes, 0, begin)
    const originalChunk = { ...original, envelope: { ...original.envelope, room: { ...original.envelope.room } } }
    const assembler = createSnapshotAssembler(begin)

    Reflect.set(begin, 'requestId', 'request-mutated')
    Reflect.set(begin.envelope.room, 'generationId', '33333333-3333-4333-8333-333333333333')

    expect(() => assembler.push(originalChunk)).not.toThrow()
    expect(assembler.getStatus()).toMatchObject({ receivedChunkCount: 1, complete: true })
  })

  it('rejects object digest, document digest, and exact decoded-length mismatches', () => {
    const bytes = new TextEncoder().encode('{"ok":true}')
    const begin = beginFor(bytes)

    const wrongLength = createSnapshotAssembler(begin)
    const shortChunk = { ...chunkFor(bytes, 0, begin), data: Buffer.from(bytes.subarray(0, bytes.byteLength - 1)).toString('base64') }
    expect(() => wrongLength.push(shortChunk)).toThrow('byte length does not match')

    const wrongObjectBegin = { ...begin, objectDigest: '0'.repeat(64) }
    const wrongObject = createSnapshotAssembler(wrongObjectBegin)
    wrongObject.push(chunkFor(bytes, 0, wrongObjectBegin))
    expect(() => wrongObject.finish(endFor(bytes, wrongObjectBegin))).toThrow('object digest does not match')
    expect(wrongObject.getStatus()).toMatchObject({ disposed: true, stagedCapacityBytes: 0, published: false })

    const wrongDocumentBegin = { ...begin, documentDigest: '0'.repeat(64) }
    const wrongDocument = createSnapshotAssembler(wrongDocumentBegin)
    wrongDocument.push(chunkFor(bytes, 0, wrongDocumentBegin))
    expect(() => wrongDocument.finish(endFor(bytes, wrongDocumentBegin))).toThrow('document digest does not match')
    expect(() => wrongDocument.publish()).toThrow('disposed')
  })

  it('makes decode and invalid UTF-8 failures terminal', () => {
    const validBytes = new TextEncoder().encode('{}')
    const validBegin = beginFor(validBytes)
    const decodeFailure = createSnapshotAssembler(validBegin)
    expect(() => decodeFailure.push({ ...chunkFor(validBytes, 0, validBegin), data: 'not base64' })).toThrow('not valid base64')
    expect(decodeFailure.getStatus()).toMatchObject({ disposed: true, stagedCapacityBytes: 0 })
    expect(() => decodeFailure.push(chunkFor(validBytes, 0, validBegin))).toThrow('disposed')

    const invalidUtf8 = new Uint8Array([0xc3, 0x28])
    const invalidBegin = beginFor(invalidUtf8)
    const utf8Failure = createSnapshotAssembler(invalidBegin)
    utf8Failure.push(chunkFor(invalidUtf8, 0, invalidBegin))
    utf8Failure.finish(endFor(invalidUtf8, invalidBegin))
    expect(() => utf8Failure.publish()).toThrow('not valid UTF-8')
    expect(utf8Failure.getStatus()).toMatchObject({ disposed: true, stagedCapacityBytes: 0, published: false })
    expect(() => utf8Failure.publish()).toThrow('disposed')
  })

  it('accounts for content buffers, bounds declared bytes, and prevents publish after dispose', () => {
    const bytes = new TextEncoder().encode('{"offline":true}')
    const begin = beginFor(bytes)
    expect(() => createSnapshotAssembler(begin, { maxBytes: bytes.byteLength - 1 })).toThrow('exceeds the supported client byte limit')

    expect(defaultMaxClientSnapshotBytes).toBe(maxSnapshotBytes)

    const assembler = createSnapshotAssembler(begin)
    expect(assembler.getStatus()).toMatchObject({
      stagedCapacityBytes: bytes.byteLength,
      publicationPeakContentBytesUpperBound: bytes.byteLength * 3,
    })
    assembler.push(chunkFor(bytes, 0, begin))
    assembler.finish(endFor(bytes, begin))
    assembler.dispose()

    expect(assembler.getStatus()).toMatchObject({ disposed: true, published: false })
    expect(() => assembler.publish()).toThrow('disposed')
  })
})
