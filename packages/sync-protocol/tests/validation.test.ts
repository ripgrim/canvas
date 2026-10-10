import { describe, expect, it } from 'vitest'
import { parseClientSyncMessage, syncProtocolVersion } from '../src/index.js'

const subscribe = { type: 'file.subscribe', protocolVersion: syncProtocolVersion, requestId: 'request-1', fileId: 'file-1', clientId: 'tab-1', afterRevision: 2 }

describe('sync protocol validation', () => {
  it('accepts subscriptions, deterministic edits, and ephemeral presence', () => {
    expect(parseClientSyncMessage(JSON.stringify(subscribe))).toEqual(subscribe)
    expect(parseClientSyncMessage(JSON.stringify({ type: 'file.edit.batch', protocolVersion: 1, fileId: 'file-1', clientId: 'tab-1', clientMutationId: 'mutation-1', baseRevision: 2, edits: [{ type: 'set', path: ['nodes', 'node-1', 'name'], value: 'Card' }, { type: 'splice', path: ['pages'], index: 1, deleteCount: 0, values: [{ id: 'page-2' }] }] }))).toMatchObject({ type: 'file.edit.batch', baseRevision: 2 })
    expect(parseClientSyncMessage(JSON.stringify({ type: 'file.presence', protocolVersion: 1, fileId: 'file-1', clientId: 'tab-1', sequence: 3, data: { selection: ['node-1'] } }))).toMatchObject({ type: 'file.presence', sequence: 3 })
  })

  it('rejects unsafe paths, unknown fields, invalid JSON values, and oversized input', () => {
    const edit = (path: unknown, value: unknown = 'x') => JSON.stringify({ type: 'file.edit.batch', protocolVersion: 1, fileId: 'file-1', clientId: 'tab-1', clientMutationId: 'mutation-1', baseRevision: 0, edits: [{ type: 'set', path, value }] })
    expect(() => parseClientSyncMessage(edit(['nodes', '__proto__']))).toThrow('Invalid file edit batch')
    expect(() => parseClientSyncMessage(edit(['nodes']).replace('"x"', '1e999'))).toThrow('Invalid file edit batch')
    expect(() => parseClientSyncMessage(JSON.stringify({ ...subscribe, unexpected: true }))).toThrow('Invalid file subscription')
    expect(() => parseClientSyncMessage(JSON.stringify(subscribe), 10)).toThrow('byte limit')
    expect(() => parseClientSyncMessage(new Uint8Array(11), 10)).toThrow('byte limit')
    expect(() => parseClientSyncMessage(new Uint8Array([0xff]), 10)).toThrow()
  })

  it('rejects incompatible versions and empty edit batches', () => {
    expect(() => parseClientSyncMessage(JSON.stringify({ ...subscribe, protocolVersion: 2 }))).toThrow('Unsupported sync protocol version')
    expect(() => parseClientSyncMessage(JSON.stringify({ type: 'file.edit.batch', protocolVersion: 1, fileId: 'file-1', clientId: 'tab-1', clientMutationId: 'mutation-1', baseRevision: 0, edits: [] }))).toThrow('Invalid file edit batch')
  })
})
