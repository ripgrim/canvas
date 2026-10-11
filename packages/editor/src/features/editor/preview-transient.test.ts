import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { hydratePreviewDocument, previewConnection, previewTransientMoves } from './preview-service'
import { projectPreviewPage } from '@canvas/repo-engine/file-preview'
import { isPreviewDocument } from '@canvas/preview-runtime/protocol'
import { sceneGeometry } from './scene-geometry'

const file: FileDocument = {
  schemaVersion: 7,
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

  it('projects live resize bounds relative to the pointer-down rectangle', () => {
    expect(previewTransientMoves(file, 'page-1', {
      kind: 'resize',
      starts: { child: { x: 120, y: 230, width: 40, height: 50 } },
      rects: { child: { x: 110, y: 225, width: 80, height: 70 } },
      appearances: {},
      contentLocked: false,
    })).toEqual([{ nodeId: 'child', dx: -10, dy: -5, width: 80, height: 70 }])
  })

  it('projects fixed image geometry and counter-moves freeform children during Mod resize', () => {
    const imageFile: FileDocument = {
      ...file,
      nodes: { ...file.nodes, frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 100, top: 200, width: 300, height: 200 }, appearance: { fills: [{ id: 'image-fill', type: 'image', assetId: 'flowers', fit: 'cover' }] } } },
      assets: { flowers: { id: 'flowers', name: 'flowers.webp', mime: 'image/webp', extension: 'webp', width: 1600, height: 1200, bytes: 3, sha256: 'a'.repeat(64) } },
    }
    const appearance = { fills: [{ id: 'image-fill', type: 'image' as const, assetId: 'flowers', fit: 'cover' as const, geometry: { x: 10, y: 5, width: 400, height: 300 } }] }
    const preview = { version: 1 as const, revision: 0, rootIds: [], nodes: {}, frame: { width: 1200, height: 800, direction: 'column' as const, gap: 0, padding: 0, clip: false }, canvas: { elements: [{ id: 'frame', kind: 'frame' as const, name: 'Frame', x: 100, y: 200, width: 300, height: 200, rotation: 0, parentId: null, appearance: { fills: [{ type: 'image' as const, assetId: 'flowers', fit: 'cover' as const }] } }] }, assets: { flowers: { mime: 'image/webp' as const, data: 'AAAA' } } }
    expect(previewTransientMoves(imageFile, 'page-1', {
      kind: 'resize', starts: { frame: { x: 100, y: 200, width: 300, height: 200 } }, rects: { frame: { x: 80, y: 200, width: 320, height: 200 } }, appearances: { frame: appearance }, contentLocked: true,
    }, preview)).toEqual([
      { nodeId: 'frame', dx: -20, dy: 0, width: 320, height: 200, appearance: { fills: [{ type: 'image', assetId: 'flowers', fit: 'cover', geometry: { x: 10, y: 5, width: 400, height: 300 } }] } },
      { nodeId: 'child', dx: 20, dy: 0 },
    ])

    const projected = projectPreviewPage(imageFile, 'page-1')!.document
    expect(projected.assets?.flowers).toEqual({ name: 'flowers.webp', mime: 'image/webp', extension: 'webp', width: 1600, height: 1200, bytes: 3, sha256: 'a'.repeat(64) })
    const hydrated = hydratePreviewDocument(projected, assetId => assetId === 'flowers' ? { mime: 'image/webp', data: 'AAAA' } : null)
    expect(hydrated.assets).toEqual({ flowers: { mime: 'image/webp', data: 'AAAA' } })
    expect(isPreviewDocument(hydrated)).toBe(true)
    expect(() => hydratePreviewDocument(projected, () => null)).toThrow('Image "flowers.webp" is unavailable in this session. Reattach it to preview this file.')
    expect(() => hydratePreviewDocument(projected, () => ({ mime: 'image/webp', data: 'AA==' }))).toThrow('Image "flowers.webp" has incomplete preview bytes. Reattach it to preview this file.')
  })

  it('FILE-ASSET-001 hydrates AVIF bytes without removing the image fill', () => {
    const avifFile: FileDocument = {
      ...file,
      nodes: { ...file.nodes, child: { id: 'child', type: 'rectangle', name: 'Child', styles: { left: 20, top: 30, width: 40, height: 50 }, appearance: { fills: [{ id: 'avif-fill', type: 'image', assetId: 'portrait', fit: 'contain' }] } } },
      assets: { portrait: { id: 'portrait', name: 'portrait.avif', mime: 'image/avif', extension: 'avif', width: 40, height: 30, bytes: 3, sha256: 'b'.repeat(64) } },
    }
    const projected = projectPreviewPage(avifFile, 'page-1')!.document
    const hydrated = hydratePreviewDocument(projected, () => ({ mime: 'image/avif', data: 'AAAA' }))
    expect(hydrated.assets).toEqual({ portrait: { mime: 'image/avif', data: 'AAAA' } })
    expect(hydrated.canvas?.elements.find(element => element.id === 'child')?.appearance?.fills).toEqual([{ type: 'image', assetId: 'portrait', fit: 'contain' }])
    expect(isPreviewDocument(hydrated)).toBe(true)
  })

  it('clears measured component geometry while the preview is disconnected', () => {
    sceneGeometry.update({ ghost: { componentId: 'atom-card', rect: { x: 10, y: 20, width: 300, height: 200 } } })
    expect(sceneGeometry.getSnapshot().nodes.ghost).toBeDefined()
    previewConnection.sync()
    expect(sceneGeometry.getSnapshot().nodes).toEqual({})
  })
})
