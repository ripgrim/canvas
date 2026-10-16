import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { hydratePreviewDocument, previewConnection, previewTransientMoves } from './preview-service'
import { collaborationTransforms, previewResizePresentation } from './preview-transient'
import { projectPreviewPage } from '@canvas/repo-engine/file-preview'
import { isPreviewDocument, type PreviewDocument } from '@canvas/preview-runtime/protocol'
import { sceneGeometry } from './scene-geometry'
import type { ResizePresentation, ResizePresentationItem } from './resize-projection'

const file: FileDocument = {
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: 'file-transient',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 100, 200], width: 300, height: 200 } },
    child: { id: 'child', type: 'rectangle', name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 40, height: 50 } },
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

  it('marks Alt-drag geometry as an optimistic duplicate without exposing that flag to collaboration transforms', () => {
    const transient = { ...move({ child: { x: 132, y: 242, width: 40, height: 50 } }, { x: 12, y: 12 }), duplicate: true }
    const projected = previewTransientMoves(file, 'page-1', transient)
    expect(projected).toEqual([{ nodeId: 'child', dx: 12, dy: 12, duplicate: true }])
    expect(collaborationTransforms(projected)).toEqual([{ nodeId: 'child', dx: 12, dy: 12 }])
  })

  it('returns no preview offset outside a live move', () => {
    expect(previewTransientMoves(file, 'page-1', null)).toEqual([])
    expect(previewTransientMoves(file, 'page-1', { kind: 'pan' })).toEqual([])
  })

  it('never converts the resize phase marker into legacy move geometry', () => {
    expect(previewTransientMoves(file, 'page-1', { kind: 'resize', interactionId: 'resize-1' })).toEqual([])
  })

  it('hydrates fixed image assets without using the retired resize transient adapter', () => {
    const imageFile: FileDocument = {
      ...file,
      nodes: { ...file.nodes, frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 100, 200], width: 300, height: 200 }, appearance: { fills: [{ id: 'image-fill', type: 'image', assetId: 'flowers', fit: 'cover' }] } } },
      assets: { flowers: { id: 'flowers', name: 'flowers.webp', mime: 'image/webp', extension: 'webp', width: 1600, height: 1200, bytes: 3, sha256: 'a'.repeat(64) } },
    }
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
      nodes: { ...file.nodes, child: { id: 'child', type: 'rectangle', name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 40, height: 50 }, appearance: { fills: [{ id: 'avif-fill', type: 'image', assetId: 'portrait', fit: 'contain' }] } } },
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

describe('PAPER-FLEX-006, PAPER-FLEX-007, and AT-CAN-006 coordinate-explicit resize adapter', () => {
  const preview: PreviewDocument = {
    version: 3 as const,
    revision: 12,
    rootIds: ['component'],
    nodes: {
      component: { id: 'component', componentId: 'atom-card', exportName: 'Card', props: {}, children: {} },
    },
    frame: { width: 800, height: 600, direction: 'column' as const, gap: 0, padding: 0, clip: false },
    canvas: {
      elements: [
        { id: 'frame', kind: 'frame' as const, name: 'Frame', relativeTransform: [1, 0, 0, 1, 0, 0] as const, width: 200, height: 160, parentId: null, clip: false },
        { id: 'selected', kind: 'rectangle' as const, name: 'Selected', relativeTransform: [1, 0, 0, 1, 0, 0] as const, width: 100, height: 50, parentId: 'frame' },
      ],
    },
  }
  const world = {
    quad: [{ x: 30, y: 10 }, { x: 30, y: 80 }, { x: -70, y: 80 }, { x: -70, y: 10 }] as const,
    aabb: { x: -70, y: 10, width: 100, height: 70 },
  }
  const item = (patch: Partial<ResizePresentationItem> = {}): ResizePresentationItem => ({
    nodeId: 'selected', parentId: 'frame', coordinateSpace: 'parent-padding',
    startRect: { x: 0, y: 0, width: 100, height: 50 }, rect: { x: 5, y: -15, width: 35, height: 50 }, world,
    nodeTransform: [1, 0, 0, 1, 0, 0], transformOrigin: { x: 17.5, y: 25 },
    ...patch,
  })
  const presentation = (items: readonly ResizePresentationItem[]): ResizePresentation => ({
    selectedNodeId: items[0]!.nodeId, contentLocked: false, affectedAxes: ['x', 'y'], effectiveHandle: 'bottom-right', items,
    byNodeId: Object.fromEntries(items.map(value => [value.nodeId, value])),
  })
  const fence = Object.freeze({ documentRevision: 12, layoutGeneration: 4, measurementRevision: 9 })

  it('copies the reviewed parent-padding rectangle literally without reprojecting its world quad', () => {
    const projected = presentation([item()])
    const source = JSON.stringify(projected)
    const result = previewResizePresentation({ presentation: projected, document: preview, pageRootNodeId: 'page-root', interactionId: 'resize-1', sampleSequence: 7, fence })

    expect(result).toStrictEqual({
      kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'resize-1', sampleSequence: 7, fence,
      items: [{ nodeId: 'selected', parentNodeId: 'frame', startRect: { x: 0, y: 0, width: 100, height: 50 }, rect: { x: 5, y: -15, width: 35, height: 50 }, nodeTransform: [1, 0, 0, 1, 0, 0], transformOrigin: { x: 17.5, y: 25 } }],
    })
    expect(JSON.stringify(projected)).toBe(source)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result?.items[0]?.rect)).toBe(true)
    expect(result?.items[0]).not.toHaveProperty('world')
  })

  it('maps the file page root to null for both primitive and Component roots while retaining nested parent identity', () => {
    const component = item({ nodeId: 'component', parentId: 'page-root' })
    const rootPrimitive = item({ nodeId: 'frame', parentId: 'page-root' })
    expect(previewResizePresentation({ presentation: presentation([rootPrimitive, component]), document: preview, pageRootNodeId: 'page-root', interactionId: 'resize-roots', sampleSequence: 1, fence })?.items).toStrictEqual([
      { nodeId: 'frame', parentNodeId: null, startRect: { x: 0, y: 0, width: 100, height: 50 }, rect: { x: 5, y: -15, width: 35, height: 50 }, nodeTransform: [1, 0, 0, 1, 0, 0], transformOrigin: { x: 17.5, y: 25 } },
      { nodeId: 'component', parentNodeId: null, startRect: { x: 0, y: 0, width: 100, height: 50 }, rect: { x: 5, y: -15, width: 35, height: 50 }, nodeTransform: [1, 0, 0, 1, 0, 0], transformOrigin: { x: 17.5, y: 25 } },
    ])
    expect(previewResizePresentation({ presentation: presentation([item({ parentId: 'page-root' })]), document: preview, pageRootNodeId: 'page-root', interactionId: 'bad-parent', sampleSequence: 1, fence })).toBeNull()
  })

  it('merges only explicit projector image geometry and omits implicit contain geometry', () => {
    const imagePreview = structuredClone(preview)
    imagePreview.assets = { flowers: { mime: 'image/webp' as const, data: 'AAAA' } }
    imagePreview.canvas!.elements[1]!.appearance = { opacity: 0.75, fills: [{ type: 'image', assetId: 'flowers', fit: 'cover' }] }
    const appearance = { opacity: 0.25, fills: [{ id: 'fill', type: 'image' as const, assetId: 'flowers', fit: 'cover' as const, geometry: { x: 10, y: 5, width: 40, height: 20 } }] }
    const result = previewResizePresentation({ presentation: presentation([item({ appearance })]), document: imagePreview, pageRootNodeId: 'page-root', interactionId: 'image-resize', sampleSequence: 2, fence })
    expect(result?.items[0]?.appearance).toStrictEqual({ opacity: 0.75, fills: [{ type: 'image', assetId: 'flowers', fit: 'cover', geometry: { x: 10, y: 5, width: 40, height: 20 } }] })

    const implicit = structuredClone(imagePreview)
    implicit.canvas!.elements[1]!.appearance = { fills: [{ type: 'image', assetId: 'flowers', fit: 'contain' }] }
    expect(previewResizePresentation({ presentation: presentation([item()]), document: implicit, pageRootNodeId: 'page-root', interactionId: 'implicit-image', sampleSequence: 3, fence })?.items[0]).not.toHaveProperty('appearance')
  })

  it('retains literal rotated content-lock image geometry and fails the whole presentation on node, fill, asset, or fence mismatch', () => {
    const imagePreview = structuredClone(preview)
    imagePreview.assets = { flowers: { mime: 'image/webp' as const, data: 'AAAA' } }
    imagePreview.canvas!.elements[1]!.appearance = { fills: [{ type: 'image', assetId: 'flowers', fit: 'cover' }] }
    const locked = { fills: [{ id: 'fill', type: 'image' as const, assetId: 'flowers', fit: 'cover' as const, geometry: { x: -37.5, y: 12.5, width: 100, height: 200 } }] }
    expect(previewResizePresentation({ presentation: presentation([item({ appearance: locked })]), document: imagePreview, pageRootNodeId: 'page-root', interactionId: 'locked-image', sampleSequence: 4, fence })?.items[0]?.appearance?.fills).toStrictEqual([
      { type: 'image', assetId: 'flowers', fit: 'cover', geometry: { x: -37.5, y: 12.5, width: 100, height: 200 } },
    ])
    expect(previewResizePresentation({ presentation: presentation([item({ nodeId: 'missing' })]), document: imagePreview, pageRootNodeId: 'page-root', interactionId: 'missing', sampleSequence: 4, fence })).toBeNull()
    expect(previewResizePresentation({ presentation: presentation([item({ appearance: { fills: [{ id: 'fill', type: 'image', assetId: 'missing', fit: 'cover', geometry: { x: 0, y: 0, width: 10, height: 10 } }] } })]), document: imagePreview, pageRootNodeId: 'page-root', interactionId: 'asset', sampleSequence: 4, fence })).toBeNull()
    expect(previewResizePresentation({ presentation: presentation([item({ appearance: { fills: [] } })]), document: imagePreview, pageRootNodeId: 'page-root', interactionId: 'fill', sampleSequence: 4, fence })).toBeNull()
    expect(previewResizePresentation({ presentation: presentation([item()]), document: imagePreview, pageRootNodeId: 'page-root', interactionId: 'stale', sampleSequence: 4, fence: Object.freeze({ ...fence, documentRevision: 11 }) })).toBeNull()
    expect(previewResizePresentation({ presentation: presentation([item()]), document: imagePreview, pageRootNodeId: 'page-root', interactionId: 'mutable', sampleSequence: 4, fence: { ...fence } })).toBeNull()
  })
})
