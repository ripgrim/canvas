import { describe, expect, it } from 'vitest'
import { isPreviewDocument } from '../../../../preview-runtime/src/protocol.js'
import { validateFileDocument } from '../../../../repo-engine/src/file-document.js'
import type { FileDocument } from '../../../../repo-engine/src/file-document.js'
import { projectPreviewPage } from '../../../../repo-engine/src/file-preview.js'

const fixture = (): FileDocument => ({
  schemaVersion: 12,
  componentModel: { definitions: {}, instances: {} },
  fileId: 'primitive-sizing-wire',
  revision: 4,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    parent: { id: 'parent', type: 'frame', name: 'Parent', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 300, height: 200 } },
    child: {
      id: 'child', type: 'rectangle', name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 77, height: 66 },
      layout: { item: { position: { mode: 'freeform' }, width: { value: { kind: 'percent', value: 100 } }, height: { value: { kind: 'percent', value: 50 } } } },
    },
  },
  relationships: { parent: { parentId: 'root-1', orderKey: 'V' }, child: { parentId: 'parent', orderKey: 'V' } },
  theme: { tokens: {} },
})

describe('PAPER-FLEX-003 primitive sizing projection boundary', () => {
  it('keeps repo-engine freeform semantic sizing accepted by preview protocol v6', () => {
    const projected = projectPreviewPage(validateFileDocument(fixture(), []), 'page-1')!.document
    expect(projected.canvas.elements.find(element => element.id === 'child')).toMatchObject({
      width: 77,
      height: 66,
      layout: { mode: 'freeform', declarations: { width: '100%', height: '50%' } },
    })
    expect(isPreviewDocument(projected)).toBe(true)
  })
})
