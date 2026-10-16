import { readFile } from 'node:fs/promises'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { canonicalCollaborationJson, collaborationDocumentDigest, collaborationOperationDigest, createPostgresCollaborationPersistence } from '../src/collaboration'
import type { CollaborationJson } from '../src/collaboration'

const fileId = '11111111-1111-4111-8111-111111111111'
const generationId = '22222222-2222-4222-8222-222222222222'

describe('collaboration persistence schema', () => {
  it('CLOUD-SYNC-PG-001 persistence slice stores generations, projections, immutable operations, and immutable checkpoint metadata', async () => {
    const sql = await readFile(new URL('../migrations/0009_collaboration_rooms.sql', import.meta.url), 'utf8')

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_collaboration_generation')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_collaboration_projection')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_collaboration_operation')
    expect(sql).toContain('UNIQUE (file_id, client_id, client_mutation_id)')
    expect(sql).toContain("jsonb_typeof(operation_payload) = 'object'")
    expect(sql).toContain('app_collaboration_operation_reject_update')
    expect(sql).toContain('app_collaboration_checkpoint_reject_update')
    expect(sql).not.toContain('SELECT *')
  })

  it('CLOUD-SYNC-LEASE-001 persistence slice retains one monotonic fence counter while the active generation is cleared', async () => {
    const sql = await readFile(new URL('../migrations/0009_collaboration_rooms.sql', import.meta.url), 'utf8')

    expect(sql).toContain('fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0)')
    expect(sql).toContain('FOREIGN KEY (file_id, active_generation_id, protocol_epoch, fencing_token)')
    expect(sql).toContain('(active_generation_id IS NULL AND protocol_epoch IS NULL AND lease_expires_at IS NULL AND renewed_at IS NULL)')
    expect(sql).toContain("status IN ('candidate', 'active', 'draining', 'released', 'expired', 'failed')")
  })

  it('CLOUD-SYNC-CHECKPOINT-001 persistence slice keeps immutable checkpoint rows behind an atomic head pointer', async () => {
    const sql = await readFile(new URL('../migrations/0009_collaboration_rooms.sql', import.meta.url), 'utf8')

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_collaboration_checkpoint (')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS app_collaboration_checkpoint_head (')
    expect(sql).toContain('UNIQUE (object_key)')
    expect(sql).toContain('FOREIGN KEY (file_id, checkpoint_sequence)')
    expect(sql).toContain('REFERENCES app_collaboration_checkpoint(file_id, checkpoint_sequence)')
    expect(sql).toContain('ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED')
  })
})

describe('collaboration operation identity', () => {
  it('CLOUD-SYNC-PG-001 persistence slice produces a stable digest independent of object key order', () => {
    const first = collaborationOperationDigest({ protocolEpoch: 3, operationType: 'document.edit', operationPayload: { z: 2, a: 1 } })
    const reordered = collaborationOperationDigest({ protocolEpoch: 3, operationType: 'document.edit', operationPayload: { a: 1, z: 2 } })
    const changed = collaborationOperationDigest({ protocolEpoch: 3, operationType: 'document.edit', operationPayload: { a: 1, z: 3 } })

    expect(first).toBe('951cbf737ad56f04a75dde96edcdb6754f3208b9e8c28ee776008aadd3b6eb7b')
    expect(reordered).toBe(first)
    expect(changed).not.toBe(first)
  })

  it('CLOUD-SYNC-PG-001 persistence slice rejects JSON shapes whose stored meaning would differ from the digested bytes', () => {
    const sparse = new Array(2)
    sparse[1] = 'present'
    expect(() => canonicalCollaborationJson(sparse as unknown as CollaborationJson)).toThrow('cannot be sparse')
    expect(() => canonicalCollaborationJson({ value: undefined } as unknown as CollaborationJson)).toThrow('undefined values')
    expect(() => canonicalCollaborationJson({ value: 1n } as unknown as CollaborationJson)).toThrow('bigint values')
    expect(() => canonicalCollaborationJson(new Date() as unknown as CollaborationJson)).toThrow('plain prototype')
    expect(() => canonicalCollaborationJson(new Proxy({ value: 1 }, {}) as CollaborationJson)).toThrow('proxy objects')
    expect(() => collaborationOperationDigest({ protocolEpoch: 3, operationType: 'document.edit', operationPayload: [] as unknown as Record<string, never> })).toThrow('must be a JSON object')
    expect(() => canonicalCollaborationJson(JSON.parse('{"__proto__":{"polluted":true}}') as CollaborationJson)).toThrow('__proto__ key')

    const symbolObject = { value: 1 } as Record<PropertyKey, unknown>
    symbolObject[Symbol('hidden')] = true
    expect(() => canonicalCollaborationJson(symbolObject as unknown as CollaborationJson)).toThrow('symbol keys')

    let accessorRead = false
    const accessorObject = {}
    Object.defineProperty(accessorObject, 'value', { enumerable: true, get: () => { accessorRead = true; return 1 } })
    expect(() => canonicalCollaborationJson(accessorObject as CollaborationJson)).toThrow('accessor properties')
    expect(accessorRead).toBe(false)
  })

  it('CLOUD-SYNC-LEASE-001 persistence slice rejects a stale fence before appending or projecting', async () => {
    const client = scriptedClient((sql, parameters) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result()
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))

    await expect(persistence.appendOperation(appendInput())).resolves.toEqual({ status: 'stale-fence' })
    expect(client.statements.some(sql => sql.includes('INSERT INTO app_collaboration_operation'))).toBe(false)
    expect(client.statements.some(sql => sql.includes('app_collaboration_projection'))).toBe(false)
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('CLOUD-SYNC-PG-001 bootstraps one sequence-zero snapshot without overwriting room authority', async () => {
    const document = { schemaVersion: 12, fileId, revision: 4 }
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_file_document')) return result([{ file_id: fileId, document }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result()
      if (sql.includes('INSERT INTO app_collaboration_projection')) return result([projectionRow({ document, sequence: '0', authority: 'legacy-seed' })])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client), {
      validateLegacyDocument: () => ({ status: 'valid' }),
    })
    await expect(persistence.bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toMatchObject({
      status: 'seeded',
      cutoverAuthority: 'snapshot-seed',
      projection: { sequence: 0n, authority: 'legacy-seed' },
    })

    const authoritativeClient = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_file_document')) return result([{ file_id: fileId, document }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result([projectionRow({ document: { ...document, revision: 5 }, sequence: '2', authority: 'room' })])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const authoritative = createPostgresCollaborationPersistence(poolWith(authoritativeClient))
    await expect(authoritative.bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toMatchObject({
      status: 'existing-projection',
      cutoverAuthority: 'room-authority',
      projection: { sequence: 2n, authority: 'room' },
    })
    expect(authoritativeClient.statements.some(sql => sql.includes('app_file_document'))).toBe(false)
    expect(authoritativeClient.statements.some(sql => sql.includes('INSERT INTO app_collaboration_projection'))).toBe(false)
  })

  it('PAPER-FLEX-001 CLOUD-SYNC-SCHEMA-001 migrates an existing schema 8 room projection before returning it under schema 9', async () => {
    const source = { schemaVersion: 8, fileId, revision: 4 }
    const migrated = { ...source, schemaVersion: 12 }
    const client = scriptedClient((sql, parameters) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result([projectionRow({ document: source, sequence: '2', authority: 'room' })])
      if (sql.startsWith('UPDATE app_collaboration_projection')) {
        expect(parameters?.[1]).toBe(12)
        expect(JSON.parse(String(parameters?.[2]))).toEqual(migrated)
        expect(parameters?.slice(4)).toEqual(['2', 8, collaborationDocumentDigest(source)])
        return result([projectionRow({ document: migrated, sequence: '2', authority: 'room' })])
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client), {
      migrateLegacyDocument(document, targetSchemaVersion) {
        expect(document).toEqual(source)
        expect(targetSchemaVersion).toBe(12)
        return { status: 'migrated', document: migrated }
      },
      validateLegacyDocument(input) {
        expect(input).toEqual({ sourceDocument: source, document: migrated, targetSchemaVersion: 12 })
        return { status: 'valid' }
      },
    })

    await expect(persistence.bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toMatchObject({
      status: 'existing-projection',
      cutoverAuthority: 'room-authority',
      projection: { documentSchemaVersion: 12, document: migrated },
    })
    expect(client.statements.at(-1)).toBe('COMMIT')
    expect(client.statements.some(sql => sql.includes('app_file_document'))).toBe(false)

    const refusedClient = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result([projectionRow({ document: source, sequence: '2', authority: 'room' })])
      throw new Error(`Unexpected query: ${sql}`)
    })
    await expect(createPostgresCollaborationPersistence(poolWith(refusedClient)).bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toEqual({ status: 'invalid-source', reason: 'schema-version' })
    expect(refusedClient.statements.some(sql => sql.startsWith('UPDATE app_collaboration_projection'))).toBe(false)
    expect(refusedClient.statements.at(-1)).toBe('ROLLBACK')
  })

  it('CLOUD-SYNC-PG-001 rejects a persisted projection whose digest does not match its document', async () => {
    const document = { schemaVersion: 12, fileId, revision: 4 }
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) {
        return result([projectionRow({ document, sequence: '2', authority: 'room', documentDigest: 'd'.repeat(64) })])
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))

    await expect(persistence.bootstrapProjectionFromLegacy(bootstrapInput())).rejects.toThrow('Collaboration projection digest does not match its document.')
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('CLOUD-SYNC-SCHEMA-001 fences, validates, and persists an asset-free schema 6 migration before seeding the room', async () => {
    const source = legacyVersion6Document()
    const { assets: _assets, ...assetFreeSource } = source
    const expected = { ...assetFreeSource, schemaVersion: 12 }
    const client = scriptedClient((sql, parameters) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result()
      if (sql.includes('FROM app_file_document')) {
        expect(sql).toContain('FOR UPDATE')
        return result([{ file_id: fileId, document: source }])
      }
      if (sql.startsWith('UPDATE app_file_document')) {
        expect(sql).not.toContain('updated_at')
        expect(JSON.parse(String(parameters?.[1]))).toEqual(expected)
        expect(JSON.parse(String(parameters?.[2]))).toEqual(source)
        return result([{}])
      }
      if (sql.includes('INSERT INTO app_collaboration_projection')) {
        expect(JSON.parse(String(parameters?.[5]))).toEqual(expected)
        return result([projectionRow({ document: expected, sequence: '0', authority: 'legacy-seed' })])
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client), {
      migrateLegacyDocument(document, targetSchemaVersion) {
        expect(document).toEqual(source)
        expect(targetSchemaVersion).toBe(12)
        return { status: 'migrated', document: expected }
      },
      validateLegacyDocument(input) {
        expect(input).toEqual({ sourceDocument: source, document: expected, targetSchemaVersion: 12 })
        return { status: 'valid' }
      },
    })

    await expect(persistence.bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toMatchObject({
      status: 'seeded',
      projection: { documentSchemaVersion: 12, document: expected },
    })
    expect(client.statements.findIndex(sql => sql.startsWith('UPDATE app_file_document'))).toBeLessThan(
      client.statements.findIndex(sql => sql.includes('INSERT INTO app_collaboration_projection')),
    )
    expect(client.statements.at(-1)).toBe('COMMIT')
  })

  it('CLOUD-SYNC-SCHEMA-001 fails closed when a current document has no validator or is rejected', async () => {
    const document = { schemaVersion: 12, fileId, revision: 0, pages: [] }
    const makeClient = () => scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result()
      if (sql.includes('FROM app_file_document')) return result([{ file_id: fileId, document }])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const missingClient = makeClient()
    await expect(createPostgresCollaborationPersistence(poolWith(missingClient)).bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toEqual({ status: 'invalid-source', reason: 'document-invalid' })
    expect(missingClient.statements.some(sql => sql.includes('INSERT INTO app_collaboration_projection'))).toBe(false)
    expect(missingClient.statements.at(-1)).toBe('ROLLBACK')

    const rejectedClient = makeClient()
    const rejected = createPostgresCollaborationPersistence(poolWith(rejectedClient), {
      validateLegacyDocument: input => {
        expect(input).toEqual({ sourceDocument: document, document, targetSchemaVersion: 12 })
        return { status: 'invalid', reason: 'document-invalid' }
      },
    })
    await expect(rejected.bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toEqual({ status: 'invalid-source', reason: 'document-invalid' })
    expect(rejectedClient.statements.some(sql => sql.includes('INSERT INTO app_collaboration_projection'))).toBe(false)
    expect(rejectedClient.statements.at(-1)).toBe('ROLLBACK')
  })

  it('CLOUD-SYNC-SCHEMA-001 rejects a semantically different migrator result before either write', async () => {
    const source = legacyVersion6Document()
    const migrated = { ...source, schemaVersion: 12, revision: 999 }
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result()
      if (sql.includes('FROM app_file_document')) return result([{ file_id: fileId, document: source }])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client), {
      migrateLegacyDocument: () => ({ status: 'migrated', document: migrated }),
      validateLegacyDocument: input => {
        expect(input).toEqual({ sourceDocument: source, document: migrated, targetSchemaVersion: 12 })
        return { status: 'invalid', reason: 'document-invalid' }
      },
    })

    await expect(persistence.bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toEqual({ status: 'invalid-source', reason: 'document-invalid' })
    expect(client.statements.some(sql => sql.startsWith('UPDATE app_file_document'))).toBe(false)
    expect(client.statements.some(sql => sql.includes('INSERT INTO app_collaboration_projection'))).toBe(false)
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('CLOUD-SYNC-SCHEMA-001 isolates the persisted validation baseline from an in-place migrator', async () => {
    const source = legacyVersion6Document()
    const original = structuredClone(source)
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result()
      if (sql.includes('FROM app_file_document')) return result([{ file_id: fileId, document: source }])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client), {
      migrateLegacyDocument(document) {
        const mutable = document as { schemaVersion: number; revision: number }
        mutable.schemaVersion = 12
        mutable.revision = 999
        return { status: 'migrated', document }
      },
      validateLegacyDocument({ sourceDocument, document }) {
        const unchangedBaseline = JSON.stringify(sourceDocument) === JSON.stringify(document)
        return unchangedBaseline ? { status: 'valid' } : { status: 'invalid', reason: 'document-invalid' }
      },
    })

    await expect(persistence.bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toEqual({ status: 'invalid-source', reason: 'document-invalid' })
    expect(source).toEqual(original)
    expect(client.statements.some(sql => sql.startsWith('UPDATE app_file_document'))).toBe(false)
    expect(client.statements.some(sql => sql.includes('INSERT INTO app_collaboration_projection'))).toBe(false)
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('FILE-ASSET-001 rolls back a schema 6 document that still needs asset externalization', async () => {
    const source = legacyVersion6Document({ photo: { mime: 'image/png', data: 'inline-bytes' } })
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result()
      if (sql.includes('FROM app_file_document')) return result([{ file_id: fileId, document: source }])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client), {
      migrateLegacyDocument(document) {
        expect(document).toEqual(source)
        return { status: 'unsupported', reason: 'asset-externalization' }
      },
    })

    await expect(persistence.bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toEqual({ status: 'invalid-source', reason: 'asset-externalization' })
    expect(client.statements.some(sql => sql.startsWith('UPDATE app_file_document'))).toBe(false)
    expect(client.statements.some(sql => sql.includes('INSERT INTO app_collaboration_projection'))).toBe(false)
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('CLOUD-SYNC-SCHEMA-001 rejects a migrator that changes document identity', async () => {
    const source = legacyVersion6Document()
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result()
      if (sql.includes('FROM app_file_document')) return result([{ file_id: fileId, document: source }])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client), {
      migrateLegacyDocument(document) {
        return { status: 'migrated', document: { ...document, schemaVersion: 12, fileId: '55555555-5555-4555-8555-555555555555' } }
      },
    })

    await expect(persistence.bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toEqual({ status: 'invalid-source', reason: 'file-identity' })
    expect(client.statements.some(sql => sql.startsWith('UPDATE app_file_document'))).toBe(false)
    expect(client.statements.some(sql => sql.includes('INSERT INTO app_collaboration_projection'))).toBe(false)
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('CLOUD-SYNC-PG-001 rejects stale or malformed legacy seeds before projection insertion', async () => {
    const staleClient = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result()
      throw new Error(`Unexpected query: ${sql}`)
    })
    const stale = createPostgresCollaborationPersistence(poolWith(staleClient))
    await expect(stale.bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toEqual({ status: 'stale-fence' })
    expect(staleClient.statements.some(sql => sql.includes('app_file_document'))).toBe(false)

    const malformedClient = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result()
      if (sql.includes('FROM app_file_document')) return result([{ file_id: fileId, document: { schemaVersion: 12, fileId: crypto.randomUUID() } }])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const malformed = createPostgresCollaborationPersistence(poolWith(malformedClient))
    await expect(malformed.bootstrapProjectionFromLegacy(bootstrapInput())).resolves.toEqual({ status: 'invalid-source', reason: 'file-identity' })
    expect(malformedClient.statements.some(sql => sql.includes('INSERT INTO app_collaboration_projection'))).toBe(false)
  })

  it('CLOUD-SYNC-PG-001 rejects public bigint inputs outside PostgreSQL signed-int64 bounds before SQL', async () => {
    const client = scriptedClient(() => { throw new Error('SQL must not run') })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))
    await expect(persistence.appendOperation({ ...appendInput(), fencingToken: 9_223_372_036_854_775_808n })).rejects.toThrow('between 1 and')
    await expect(persistence.appendOperation({ ...appendInput(), baseSequence: 9_223_372_036_854_775_808n })).rejects.toThrow('between 0 and')
    expect(client.statements).toEqual([])
  })

  it('CLOUD-SYNC-LEASE-001 persistence slice increments the persisted fence and only activates a fresh candidate', async () => {
    const client = scriptedClient((sql, parameters) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return result()
      if (sql.startsWith('INSERT INTO app_collaboration_lease')) return result()
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('is_active')) return result([{
        file_id: fileId,
        active_generation_id: null,
        protocol_epoch: null,
        fencing_token: '7',
        lease_expires_at: null,
        renewed_at: null,
        is_active: false,
      }])
      if (sql.startsWith('UPDATE app_collaboration_generation')) {
        expect(sql).toContain("status = 'candidate'")
        expect(parameters?.[3]).toBe('8')
        return result([generationRow('8')])
      }
      if (sql.startsWith('UPDATE app_collaboration_lease')) {
        expect(parameters?.[3]).toBe('8')
        return result([leaseRow('8')])
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))

    await expect(persistence.acquireLease({ fileId, generationId, protocolEpoch: 3, leaseDurationMs: 30_000 })).resolves.toMatchObject({
      status: 'acquired',
      lease: { generationId, fencingToken: 8n },
    })
    expect(client.statements.at(-1)).toBe('COMMIT')
  })

  it('CLOUD-SYNC-PG-001 persistence slice rolls back an appended operation when projection persistence fails', async () => {
    const operationDigest = collaborationOperationDigest({ protocolEpoch: 3, operationType: 'document.edit', operationPayload: { kind: 'rename', name: 'Card' } })
    const client = scriptedClient((sql, parameters) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql === 'COMMIT') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([authorizedFileRow()])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_operation') && sql.includes('client_mutation_id')) return result()
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) return result()
      if (sql.includes('INSERT INTO app_collaboration_operation')) {
        expect(parameters?.[9]).toBe('{"kind":"rename","name":"Card"}')
        return result([operationRow(operationDigest)])
      }
      if (sql.includes('INSERT INTO app_collaboration_projection')) {
        expect(parameters?.[7]).toBe(`{"fileId":"${fileId}","revision":1,"schemaVersion":12}`)
        throw new Error('projection write failed')
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))

    await expect(persistence.appendOperation(appendInput())).rejects.toThrow('projection write failed')
    expect(client.statements.findIndex(sql => sql.includes('INSERT INTO app_collaboration_operation'))).toBeLessThan(
      client.statements.findIndex(sql => sql.includes('INSERT INTO app_collaboration_projection')),
    )
    expect(client.statements.findIndex(sql => sql.includes('FROM app_file WHERE id'))).toBeLessThan(
      client.statements.findIndex(sql => sql.includes('FROM app_collaboration_lease')),
    )
    expect(client.statements).toContain('ROLLBACK')
    expect(client.statements).not.toContain('COMMIT')
  })

  it('CLOUD-SYNC-PG-001 persistence slice replays exact mutation content and rejects identifier reuse with different content', async () => {
    const exactInput = appendInput()
    const exactDigest = collaborationOperationDigest(exactInput)
    const replayClient = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([authorizedFileRow()])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_operation') && sql.includes('client_mutation_id')) return result([operationRow(exactDigest)])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const replayPersistence = createPostgresCollaborationPersistence(poolWith(replayClient))
    await expect(replayPersistence.appendOperation(exactInput)).resolves.toMatchObject({ status: 'replayed', operation: { sequence: 1n } })

    const conflictClient = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([authorizedFileRow()])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_operation') && sql.includes('client_mutation_id')) return result([operationRow('f'.repeat(64))])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const conflictPersistence = createPostgresCollaborationPersistence(poolWith(conflictClient))
    await expect(conflictPersistence.appendOperation(exactInput)).resolves.toEqual({ status: 'mutation-conflict' })

    await expect(conflictPersistence.appendOperation({ ...exactInput, operationPayload: { kind: 'rename', name: 'Different' } })).resolves.toEqual({ status: 'mutation-conflict' })
  })

  it('CLOUD-SYNC-AUTH-001 rejects a revoked writer after locking both file and lease without reading mutation state', async () => {
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([authorizedFileRow({ ownerUserId: 'different-owner' })])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))

    await expect(persistence.appendOperation(appendInput())).resolves.toEqual({ status: 'access-revoked' })
    const fileLock = client.statements.findIndex(sql => sql.includes('FROM app_file WHERE id'))
    const leaseLock = client.statements.findIndex(sql => sql.includes('FROM app_collaboration_lease'))
    expect(fileLock).toBeGreaterThan(-1)
    expect(leaseLock).toBeGreaterThan(fileLock)
    expect(client.statements.some(sql => sql.includes('FROM app_collaboration_operation'))).toBe(false)
    expect(client.statements.some(sql => sql.includes('INSERT INTO app_collaboration_operation'))).toBe(false)
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('CLOUD-SYNC-AUTH-001 rejects an epoch changed after prior authorization without appending', async () => {
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([authorizedFileRow({ accessEpoch: '2' })])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))

    await expect(persistence.appendOperation(appendInput())).resolves.toEqual({ status: 'access-conflict', currentAccessEpoch: 2n })
    expect(client.statements.some(sql => sql.includes('FROM app_collaboration_operation'))).toBe(false)
    expect(client.statements.some(sql => sql.includes('INSERT INTO app_collaboration_operation'))).toBe(false)
    expect(client.statements.at(-1)).toBe('ROLLBACK')
  })

  it('CLOUD-SYNC-CHECKPOINT-001 persistence slice does not write checkpoint metadata after a stale fence', async () => {
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result()
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))

    await expect(persistence.commitVerifiedCheckpoint({
      fileId,
      generationId,
      protocolEpoch: 3,
      fencingToken: 4n,
      sequence: 1n,
      objectKey: `checkpoints/${fileId}/1.zst`,
      objectDigest: 'a'.repeat(64),
      documentDigest: 'b'.repeat(64),
      compressedBytes: 128n,
      documentSchemaVersion: 12,
    })).resolves.toEqual({ status: 'stale-fence' })
    expect(client.statements.some(sql => sql.includes('INSERT INTO app_collaboration_checkpoint'))).toBe(false)
    expect(client.statements.some(sql => sql.includes('app_collaboration_checkpoint_head'))).toBe(false)
  })

  it('CLOUD-SYNC-CHECKPOINT-001 persistence slice replays an exact committed checkpoint without rewriting its pointer', async () => {
    const documentDigest = 'b'.repeat(64)
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_checkpoint') && sql.includes('checkpoint_sequence')) return result([checkpointRow(documentDigest)])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))

    await expect(persistence.commitVerifiedCheckpoint({
      fileId,
      generationId,
      protocolEpoch: 3,
      fencingToken: 4n,
      sequence: 1n,
      objectKey: `checkpoints/${fileId}/1.zst`,
      objectDigest: 'a'.repeat(64),
      documentDigest,
      compressedBytes: 128n,
      documentSchemaVersion: 12,
    })).resolves.toMatchObject({ status: 'replayed', checkpoint: { sequence: 1n } })
    expect(client.statements.some(sql => sql.includes('app_collaboration_projection'))).toBe(false)
    expect(client.statements.some(sql => sql.includes('app_collaboration_checkpoint_head'))).toBe(false)
  })

  it('CLOUD-SYNC-CHECKPOINT-001 does not checkpoint a legacy seed before room-authority cutover', async () => {
    const documentDigest = 'b'.repeat(64)
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_checkpoint') && sql.includes('checkpoint_sequence')) return result()
      if (sql.includes('FROM app_collaboration_projection') && sql.includes('FOR UPDATE')) {
        return result([projectionRow({ document: { schemaVersion: 12, fileId, revision: 0 }, sequence: '0', authority: 'legacy-seed' })])
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))
    await expect(persistence.commitVerifiedCheckpoint(checkpointInput({ sequence: 0n, documentDigest }))).resolves.toEqual({ status: 'projection-conflict', currentSequence: 0n })
    expect(client.statements.some(sql => sql.includes('INSERT INTO app_collaboration_checkpoint'))).toBe(false)
  })

  it('CLOUD-SYNC-CHECKPOINT-001 persistence slice refuses pruning without the active fence or a committed checkpoint head', async () => {
    const staleClient = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result()
      throw new Error(`Unexpected query: ${sql}`)
    })
    const stalePersistence = createPostgresCollaborationPersistence(poolWith(staleClient))
    await expect(stalePersistence.pruneCoveredOperations(pruneInput())).resolves.toEqual({ status: 'stale-fence' })
    expect(staleClient.statements.some(sql => sql.includes('DELETE FROM app_collaboration_operation'))).toBe(false)

    const uncommittedClient = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_checkpoint_head') && sql.includes('FOR SHARE')) return result()
      throw new Error(`Unexpected query: ${sql}`)
    })
    const uncommittedPersistence = createPostgresCollaborationPersistence(poolWith(uncommittedClient))
    await expect(uncommittedPersistence.pruneCoveredOperations(pruneInput())).resolves.toEqual({ status: 'no-committed-checkpoint' })
    expect(uncommittedClient.statements.some(sql => sql.includes('DELETE FROM app_collaboration_operation'))).toBe(false)
  })

  it('CLOUD-SYNC-CHECKPOINT-001 persistence slice deletes only the requested range covered by the committed checkpoint', async () => {
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ file_id: fileId }])
      if (sql.includes('FROM app_collaboration_checkpoint_head') && sql.includes('FOR SHARE')) return result([{ checkpoint_sequence: '2' }])
      if (sql.includes('DELETE FROM app_collaboration_operation')) {
        expect(sql).toContain('operation.sequence <= $5')
        expect(sql).toContain('operation.sequence <= active_checkpoint.checkpoint_sequence')
        return result([{ deleted_count: '2' }])
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))

    await expect(persistence.pruneCoveredOperations(pruneInput())).resolves.toEqual({ status: 'pruned', throughSequence: 2n, deletedCount: 2n })
    expect(client.statements.at(-1)).toBe('COMMIT')
  })
})

describe('collaboration admission generation resolution', () => {
  it('CLOUD-SYNC-LEASE-001 atomically reuses the active generation under the lease lock', async () => {
    const client = scriptedClient((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.startsWith('INSERT INTO app_collaboration_lease')) return result()
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([{ ...leaseRow('4'), is_active: true }])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))

    await expect(persistence.resolveAdmissionGeneration({ fileId, generationId: crypto.randomUUID(), protocolEpoch: 3, candidateTtlMs: 30_000 }))
      .resolves.toEqual({ status: 'active', generationId })
    const fileLock = client.statements.findIndex(sql => sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE'))
    const leaseLock = client.statements.findIndex(sql => sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE'))
    expect(fileLock).toBeGreaterThan(-1)
    expect(leaseLock).toBeGreaterThan(fileLock)
    expect(client.statements.at(-1)).toBe('COMMIT')
  })

  it('CLOUD-SYNC-LEASE-001 reuses one recent candidate and expires stale candidates before considering a new one', async () => {
    const client = scriptedClient((sql, parameters) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.startsWith('INSERT INTO app_collaboration_lease')) return result()
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([emptyLeaseRow()])
      if (sql.startsWith('UPDATE app_collaboration_generation')) {
        expect(parameters).toEqual([fileId, 3, 30_000])
        return result()
      }
      if (sql.startsWith('SELECT file_id, generation_id') && sql.includes("status = 'candidate'")) return result([candidateGenerationRow()])
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))
    const proposed = crypto.randomUUID()

    await expect(persistence.resolveAdmissionGeneration({ fileId, generationId: proposed, protocolEpoch: 3, candidateTtlMs: 30_000 }))
      .resolves.toEqual({ status: 'candidate', generationId })
    expect(client.statements.filter(sql => sql.startsWith('INSERT INTO app_collaboration_generation'))).toHaveLength(0)
  })

  it('CLOUD-SYNC-LEASE-001 inserts the proposed candidate only when no reusable generation exists', async () => {
    const proposed = '55555555-5555-4555-8555-555555555555'
    const client = scriptedClient((sql, parameters) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return result()
      if (sql.includes('FROM app_file WHERE id') && sql.includes('FOR UPDATE')) return result([{ id: fileId }])
      if (sql.startsWith('INSERT INTO app_collaboration_lease')) return result()
      if (sql.includes('FROM app_collaboration_lease') && sql.includes('FOR UPDATE')) return result([emptyLeaseRow()])
      if (sql.startsWith('UPDATE app_collaboration_generation')) return result()
      if (sql.startsWith('SELECT file_id, generation_id') && sql.includes("status = 'candidate'")) return result()
      if (sql.startsWith('INSERT INTO app_collaboration_generation')) {
        expect(parameters).toEqual([fileId, proposed, 3])
        return result([candidateGenerationRow(proposed)])
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const persistence = createPostgresCollaborationPersistence(poolWith(client))

    await expect(persistence.resolveAdmissionGeneration({ fileId, generationId: proposed, protocolEpoch: 3, candidateTtlMs: 30_000 }))
      .resolves.toEqual({ status: 'candidate', generationId: proposed })
  })
})

function appendInput() {
  return {
    fileId,
    generationId,
    protocolEpoch: 3,
    fencingToken: 4n,
    expectedSubjectId: 'user-1',
    expectedAccessEpoch: 1n,
    clientId: 'client-1',
    clientMutationId: 'mutation-1',
    operationType: 'document.edit',
    operationPayload: { kind: 'rename', name: 'Card' } as const,
    baseSequence: 0n,
    projection: { documentSchemaVersion: 12, document: { schemaVersion: 12, fileId, revision: 1 } as const },
  }
}

function authorizedFileRow({ ownerUserId = 'user-1', accessEpoch = '1' }: { ownerUserId?: string; accessEpoch?: string } = {}) {
  return { id: fileId, owner_user_id: ownerUserId, access_epoch: accessEpoch }
}

function pruneInput() {
  return { fileId, generationId, protocolEpoch: 3, fencingToken: 4n, throughSequence: 2n }
}

function bootstrapInput() {
  return { fileId, generationId, protocolEpoch: 3, fencingToken: 4n, documentSchemaVersion: 12 }
}

function legacyVersion6Document(assets: Record<string, CollaborationJson> = {}) {
  const pageId = '33333333-3333-4333-8333-333333333333'
  const rootNodeId = '44444444-4444-4444-8444-444444444444'
  return {
    schemaVersion: 6,
    fileId,
    revision: 4,
    pages: [{ id: pageId, name: 'Page 1', rootNodeId }],
    nodes: { [rootNodeId]: { id: rootNodeId, type: 'root' } },
    relationships: {},
    theme: { tokens: {} },
    assets,
  }
}

function projectionRow({ document, sequence, authority, documentDigest = collaborationDocumentDigest(document as Readonly<Record<string, CollaborationJson>>) }: { document: Record<string, unknown>; sequence: string; authority: 'legacy-seed' | 'room'; documentDigest?: string }) {
  return {
    file_id: fileId,
    sequence,
    document_schema_version: Number(document.schemaVersion),
    document,
    document_digest: documentDigest,
    generation_id: generationId,
    fencing_token: '4',
    authority,
    updated_at: new Date('2026-10-10T00:00:00.000Z'),
  }
}

function checkpointInput({ sequence = 1n, documentDigest = 'b'.repeat(64) }: { sequence?: bigint; documentDigest?: string } = {}) {
  return {
    fileId,
    generationId,
    protocolEpoch: 3,
    fencingToken: 4n,
    sequence,
    objectKey: `checkpoints/${fileId}/${sequence}.zst`,
    objectDigest: 'a'.repeat(64),
    documentDigest,
    compressedBytes: 128n,
    documentSchemaVersion: 12,
  }
}

function operationRow(contentDigest: string) {
  return {
    file_id: fileId,
    sequence: '1',
    generation_id: generationId,
    protocol_epoch: 3,
    fencing_token: '4',
    subject_id: 'user-1',
    client_id: 'client-1',
    client_mutation_id: 'mutation-1',
    operation_type: 'document.edit',
    operation_payload: { kind: 'rename', name: 'Card' },
    content_digest: contentDigest,
    committed_at: new Date('2026-10-10T00:00:00.000Z'),
  }
}

function generationRow(fencingToken: string) {
  return {
    file_id: fileId,
    generation_id: generationId,
    protocol_epoch: 3,
    status: 'active',
    fencing_token: fencingToken,
    created_at: new Date('2026-10-10T00:00:00.000Z'),
    activated_at: new Date('2026-10-10T00:00:01.000Z'),
    ended_at: null,
  }
}

function candidateGenerationRow(candidateGenerationId = generationId) {
  return {
    file_id: fileId,
    generation_id: candidateGenerationId,
    protocol_epoch: 3,
    status: 'candidate',
    fencing_token: null,
    created_at: new Date('2026-10-10T00:00:00.000Z'),
    activated_at: null,
    ended_at: null,
  }
}

function emptyLeaseRow() {
  return {
    file_id: fileId,
    active_generation_id: null,
    protocol_epoch: null,
    fencing_token: '0',
    lease_expires_at: null,
    renewed_at: null,
    is_active: false,
  }
}

function leaseRow(fencingToken: string) {
  return {
    file_id: fileId,
    active_generation_id: generationId,
    protocol_epoch: 3,
    fencing_token: fencingToken,
    lease_expires_at: new Date('2026-10-10T00:01:00.000Z'),
    renewed_at: new Date('2026-10-10T00:00:01.000Z'),
  }
}

function checkpointRow(documentDigest: string) {
  return {
    file_id: fileId,
    checkpoint_sequence: '1',
    object_key: `checkpoints/${fileId}/1.zst`,
    object_digest: 'a'.repeat(64),
    document_digest: documentDigest,
    compressed_bytes: '128',
    document_schema_version: 12,
    generation_id: generationId,
    fencing_token: '4',
    committed_at: new Date('2026-10-10T00:00:02.000Z'),
  }
}

type QueryResultLike = Pick<QueryResult, 'rows' | 'rowCount'>

function result(rows: readonly Record<string, unknown>[] = []): QueryResultLike {
  return { rows: [...rows], rowCount: rows.length }
}

function scriptedClient(respond: (sql: string, parameters: readonly unknown[] | undefined) => QueryResultLike | Promise<QueryResultLike>): PoolClient & { statements: string[] } {
  const statements: string[] = []
  return {
    statements,
    query: vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      return respond(normalized, parameters)
    }),
    release: vi.fn(),
  } as unknown as PoolClient & { statements: string[] }
}

function poolWith(client: PoolClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool
}
