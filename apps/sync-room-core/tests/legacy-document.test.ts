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

    expect(migrateLegacyCollaborationDocument(source, 9)).toEqual({
      status: 'migrated',
      document: { ...assetFreeSource, schemaVersion: 9 },
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

    expect(migrateLegacyCollaborationDocument(source, 9)).toEqual({
      status: 'migrated',
      document: {
        ...source,
        schemaVersion: 9,
        nodes: {
          ...source.nodes,
          label: {
            ...source.nodes.label,
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
    expect(migrateLegacyCollaborationDocument({ ...source, nodes: [] }, 9)).toEqual({ status: 'unsupported', reason: 'document-invalid' })
  })

  it('FILE-ASSET-001 fails closed when inline asset bytes still require externalization', () => {
    const source = version6({ photo: { mime: 'image/png', data: 'inline-bytes' } })

    expect(migrateLegacyCollaborationDocument(source, 9)).toEqual({ status: 'unsupported', reason: 'asset-externalization' })
    expect(migrateLegacyCollaborationDocument({ ...source, schemaVersion: 5 }, 9)).toEqual({ status: 'unsupported', reason: 'schema-version' })
  })

  it('CLOUD-SYNC-SCHEMA-001 rejects a malformed schema 6 graph instead of treating it as current', () => {
    const malformed = { schemaVersion: 6, fileId, revision: 4, assets: {} }

    expect(migrateLegacyCollaborationDocument(malformed, 9)).toEqual({ status: 'unsupported', reason: 'document-invalid' })
  })

  it('CLOUD-SYNC-SCHEMA-001 validates current documents and the exact allowed migration result', () => {
    const source = version6()
    const migrated = migrateLegacyCollaborationDocument(source, 9)
    expect(migrated.status).toBe('migrated')
    if (migrated.status !== 'migrated') return

    expect(validateLegacyCollaborationDocument({ sourceDocument: source, document: migrated.document, targetSchemaVersion: 9 })).toEqual({ status: 'valid' })
    expect(validateLegacyCollaborationDocument({ sourceDocument: migrated.document, document: migrated.document, targetSchemaVersion: 9 })).toEqual({ status: 'valid' })
    expect(validateLegacyCollaborationDocument({ sourceDocument: { schemaVersion: 9, fileId, revision: 0, pages: [] }, document: { schemaVersion: 9, fileId, revision: 0, pages: [] }, targetSchemaVersion: 9 })).toEqual({ status: 'invalid', reason: 'document-invalid' })
    expect(validateLegacyCollaborationDocument({ sourceDocument: source, document: { ...migrated.document, revision: 999 }, targetSchemaVersion: 9 })).toEqual({ status: 'invalid', reason: 'document-invalid' })
  })

  it('CLOUD-SYNC-SCHEMA-001 upgrades a valid schema 8 projection with no materialized layout records', () => {
    const version8 = { ...version6(), schemaVersion: 8 }
    expect(migrateLegacyCollaborationDocument(version8, 9)).toEqual({
      status: 'migrated',
      document: { ...version8, schemaVersion: 9 },
    })
  })
})
