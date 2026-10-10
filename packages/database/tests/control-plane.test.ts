import { describe, expect, it } from 'vitest'
import { validateFileDocument } from '../../repo-engine/src/file-document'
import { createMemoryControlPlane } from '../src/memory'

describe('control-plane file documents', () => {
  it('creates a canonical blank document accepted by the editor validator', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile('owner', 'Blank', null)
    const opened = await store.getFileDocument('owner', file.id)
    expect(opened).not.toBeNull()
    const document = validateFileDocument(opened!.document, [])
    expect(document).toMatchObject({ schemaVersion: 6, fileId: file.id, revision: 0, pages: [{ name: 'Page 1' }], theme: { tokens: {} } })
    expect(Object.values(document.nodes)).toEqual([{ id: document.pages[0]!.rootNodeId, type: 'root' }])
  })
})
