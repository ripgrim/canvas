import { describe, expect, it } from 'vitest'
import { validateFileDocument } from '../src/file-document.js'
import { isFileDocumentShape, upgradeFileDocument } from '../src/file-migration.js'

const version6 = () => ({
  schemaVersion: 6,
  fileId: 'file-1',
  revision: 4,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' } },
  relationships: {},
  theme: { tokens: {} },
})

describe('CLOUD-SYNC-SCHEMA-001 version 6 to 7 asset externalization boundary', () => {
  it('purely upgrades a version 6 file with no inline assets', () => {
    const input = version6()
    const before = structuredClone(input)
    const upgraded = upgradeFileDocument(input)

    expect(upgraded).toStrictEqual({ ...input, schemaVersion: 7 })
    expect(upgraded).not.toBe(input)
    expect(input).toStrictEqual(before)
    expect(validateFileDocument(upgraded, [])).toStrictEqual(upgraded)
    expect(isFileDocumentShape(input)).toBe(true)
    expect(isFileDocumentShape(upgraded)).toBe(true)
  })

  it('drops an empty legacy asset map instead of preserving the old storage shape', () => {
    const input = { ...version6(), assets: {} }
    const upgraded = upgradeFileDocument(input)
    expect(upgraded).toStrictEqual({ ...version6(), schemaVersion: 7 })
    expect(upgraded).not.toHaveProperty('assets')
    expect(input).toHaveProperty('assets', {})
  })

  it('fails closed when version 6 contains bytes that require trusted externalization', () => {
    const inline = {
      ...version6(),
      assets: { image: { id: 'image', name: 'image.png', mime: 'image/png', width: 1, height: 1, bytes: 3, data: 'AAAA' } },
    }
    const before = structuredClone(inline)

    expect(() => upgradeFileDocument(inline)).toThrow('Image assets require externalization before schema 7 migration')
    expect(inline).toStrictEqual(before)
  })

  it('does not mistake reference-looking assets for an in-process migration authority', () => {
    const reference = { id: 'image', name: 'image.png', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, sha256: 'a'.repeat(64) }
    expect(() => upgradeFileDocument({ ...version6(), assets: { image: reference } })).toThrow('Image assets require externalization before schema 7 migration')
  })
})
