import { describe, expect, it } from 'vitest'
import { migrateLegacyCollaborationDocument, validateLegacyCollaborationDocument } from '../src/legacy-document.js'

const fileId = '11111111-1111-4111-8111-111111111111'
const pageId = '22222222-2222-4222-8222-222222222222'
const rootNodeId = '33333333-3333-4333-8333-333333333333'

const version6 = (assets: Readonly<Record<string, Readonly<{ mime: string; data: string }>>> = {}) => ({
  schemaVersion: 6,
  fileId,
  revision: 4,
  pages: [{ id: pageId, name: 'Page 1', rootNodeId }],
  nodes: { [rootNodeId]: { id: rootNodeId, type: 'root' } },
  relationships: {},
  theme: { tokens: {} },
  assets,
})

describe('cold collaboration document migration', () => {
  it('CLOUD-SYNC-SCHEMA-001 upgrades the exact asset-free schema 6 predecessor to the current schema', () => {
    const source = version6()
    const { assets: _assets, ...assetFreeSource } = source

    expect(migrateLegacyCollaborationDocument(source, 12)).toEqual({
      status: 'migrated',
      document: { ...assetFreeSource, schemaVersion: 12, componentModel: { definitions: {}, instances: {} } },
    })
    expect(source).toEqual(version6())
  })

  it('PAPER-TEXT-001 upgrades a schema 7 cold seed with authoritative text defaults before admission', () => {
    const source = {
      ...version6(),
      schemaVersion: 7,
      nodes: {
        [rootNodeId]: { id: rootNodeId, type: 'root' },
        label: { id: 'label', type: 'text', name: 'Label', styles: { left: 0, top: 0, width: 80, height: 20 }, text: 'Hello', themeMode: 'inherit' },
      },
      relationships: { label: { parentId: rootNodeId, orderKey: 'V' } },
    }

    expect(migrateLegacyCollaborationDocument(source, 12)).toEqual({
      status: 'migrated',
      document: {
        ...source,
        schemaVersion: 12,
        componentModel: { definitions: {}, instances: {} },
        nodes: {
          ...source.nodes,
          label: {
            ...source.nodes.label,
            styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 80, height: 20 },
            textStyle: {
              fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
              fontStyle: 'normal',
              fontWeight: 400,
              fontSize: 16,
              lineHeight: { kind: 'unitless', value: 1.25 },
              letterSpacing: 0,
              horizontalAlign: 'left',
              verticalAlign: 'top',
              case: 'none',
              wrap: 'normal',
              keepWords: false,
            },
            textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
          },
        },
      },
    })
    expect(source.nodes.label).not.toHaveProperty('textStyle')
    expect(migrateLegacyCollaborationDocument({ ...source, nodes: [] }, 12)).toEqual({ status: 'unsupported', reason: 'document-invalid' })
  })

  it('FILE-ASSET-001 fails closed when inline asset bytes still require externalization', () => {
    const source = version6({ photo: { mime: 'image/png', data: 'inline-bytes' } })

    expect(migrateLegacyCollaborationDocument(source, 12)).toEqual({ status: 'unsupported', reason: 'asset-externalization' })
    expect(migrateLegacyCollaborationDocument({ ...source, schemaVersion: 5 }, 12)).toEqual({ status: 'unsupported', reason: 'schema-version' })
  })

  it('CLOUD-SYNC-SCHEMA-001 rejects a malformed schema 6 graph instead of treating it as current', () => {
    const malformed = { schemaVersion: 6, fileId, revision: 4, assets: {} }

    expect(migrateLegacyCollaborationDocument(malformed, 12)).toEqual({ status: 'unsupported', reason: 'document-invalid' })
  })

  it('CLOUD-SYNC-SCHEMA-001 validates current documents and the exact allowed migration result', () => {
    const source = version6()
    const migrated = migrateLegacyCollaborationDocument(source, 12)
    expect(migrated.status).toBe('migrated')
    if (migrated.status !== 'migrated') return

    expect(validateLegacyCollaborationDocument({ sourceDocument: source, document: migrated.document, targetSchemaVersion: 12 })).toEqual({ status: 'valid' })
    expect(validateLegacyCollaborationDocument({ sourceDocument: migrated.document, document: migrated.document, targetSchemaVersion: 12 })).toEqual({ status: 'valid' })
    expect(validateLegacyCollaborationDocument({ sourceDocument: { schemaVersion: 12, fileId, revision: 0, pages: [] }, document: { schemaVersion: 12, fileId, revision: 0, pages: [] }, targetSchemaVersion: 12 })).toEqual({ status: 'invalid', reason: 'document-invalid' })
    expect(validateLegacyCollaborationDocument({ sourceDocument: source, document: { ...migrated.document, revision: 999 }, targetSchemaVersion: 12 })).toEqual({ status: 'invalid', reason: 'document-invalid' })
  })

  it('CLOUD-SYNC-SCHEMA-001 upgrades a valid schema 8 projection with no materialized layout records', () => {
    const version8 = { ...version6(), schemaVersion: 8 }
    expect(migrateLegacyCollaborationDocument(version8, 12)).toEqual({
      status: 'migrated',
      document: { ...version8, schemaVersion: 12, componentModel: { definitions: {}, instances: {} } },
    })
  })

  it('COMP-V2-PERSIST-001 upgrades a schema 9 cold seed with an empty component registry', () => {
    const version9 = { ...version6(), schemaVersion: 9 }
    expect(migrateLegacyCollaborationDocument(version9, 12)).toEqual({
      status: 'migrated',
      document: { ...version9, schemaVersion: 12, componentModel: { definitions: {}, instances: {} } },
    })
  })

  it('upgrades a schema 10 cold seed instead of rejecting the immediate predecessor', () => {
    const { assets: _assets, ...assetFreeSource } = version6()
    const version10 = { ...assetFreeSource, schemaVersion: 10, componentModel: { definitions: {}, instances: {} } }
    expect(migrateLegacyCollaborationDocument(version10, 12)).toEqual({
      status: 'migrated',
      document: { ...version10, schemaVersion: 12 },
    })
  })

  it('upgrades a schema 11 cold seed and rejects a stale target schema', () => {
    const { assets: _assets, ...assetFreeSource } = version6()
    const version11 = { ...assetFreeSource, schemaVersion: 11, componentModel: { definitions: {}, instances: {} } }
    expect(migrateLegacyCollaborationDocument(version11, 12)).toEqual({ status: 'migrated', document: { ...version11, schemaVersion: 12 } })
    expect(migrateLegacyCollaborationDocument(version11, 11)).toEqual({ status: 'unsupported', reason: 'schema-version' })
  })
})
