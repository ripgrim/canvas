import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { previewConnection, previewTransientMoves } from './preview-service'
import { sceneGeometry } from './scene-geometry'

const file: FileDocument = {
  schemaVersion: 6,
  fileId: 'file-transient',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 100, top: 200, width: 300, height: 200 } },
    child: { id: 'child', type: 'rectangle', name: 'Child', styles: { left: 20, top: 30, width: 40, height: 50 } },
    button: { id: 'button', type: 'component', componentId: 'atom-button', exportName: 'Button', props: {} },
  },
  relationships: {
    frame: { parentId: 'root-1', orderKey: 'V' },
    child: { parentId: 'frame', orderKey: 'V' },
    button: { parentId: 'root-1', orderKey: 'W' },
  },
  theme: { tokens: {} },
}
const move = (rects: Record<string, { x: number; y: number; width: number; height: number }>, offset: { x: number; y: number }) => ({ kind: 'move' as const, rects, offset, guides: [], targetFrameId: null, insertion: null })

describe('AT-CAN-005 preview transient move projection', () => {
  it('projects the gesture offset for primitive and mounted component roots', () => {
    expect(previewTransientMoves(file, 'page-1', move({ child: { x: 132, y: 242, width: 40, height: 50 }, button: { x: -38, y: -13, width: 100, height: 50 } }, { x: 12, y: 12 }))).toEqual([
      { nodeId: 'child', dx: 12, dy: 12 },
      { nodeId: 'button', dx: 12, dy: 12 },
    ])
  })

  it('moves only the highest selected root when a parent and descendant are both selected', () => {
    expect(previewTransientMoves(file, 'page-1', move({ frame: { x: 110, y: 205, width: 300, height: 200 }, child: { x: 130, y: 235, width: 40, height: 50 } }, { x: 10, y: 5 }))).toEqual([
      { nodeId: 'frame', dx: 10, dy: 5 },
    ])
  })

  it('returns no preview offset outside a live move', () => {
    expect(previewTransientMoves(file, 'page-1', null)).toEqual([])
    expect(previewTransientMoves(file, 'page-1', { kind: 'pan' })).toEqual([])
  })

  it('clears measured component geometry while the preview is disconnected', () => {
    sceneGeometry.update({ ghost: { componentId: 'atom-card', rect: { x: 10, y: 20, width: 300, height: 200 } } })
    expect(sceneGeometry.getSnapshot().nodes.ghost).toBeDefined()
    previewConnection.sync()
    expect(sceneGeometry.getSnapshot().nodes).toEqual({})
  })
})
