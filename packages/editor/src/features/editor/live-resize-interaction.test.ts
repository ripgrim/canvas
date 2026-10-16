import { describe, expect, it } from 'vitest'
import type { FileDocument, PrimitiveNode } from '@canvas/repo-engine/file-document'
import { captureGestureAuthority } from './gesture-authority'
import { resizeGeometryAuthority } from './layout-measure'
import { beginLiveResizeInteraction, sampleLiveResizeInteraction } from './live-resize-interaction'
import type { SceneGeometry } from './scene-geometry'

const file: FileDocument = {
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: 'live-resize-file',
  revision: 4,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    selected: {
      id: 'selected', type: 'rectangle', name: 'Selected',
      styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 50 },
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } } } },
    },
  },
  relationships: { selected: { parentId: 'root', orderKey: 'V' } },
  theme: { tokens: {} },
}

const geometry: SceneGeometry = {
  revision: 12,
  documentRevision: 4,
  layoutGeneration: 8,
  nodes: {
    selected: {
      canvasKind: 'rectangle', documentRevision: 4, layoutGeneration: 8,
      rect: { x: -100, y: 0, width: 100, height: 200 },
      worldAabb: { x: -100, y: 0, width: 100, height: 200 },
      offset: { x: 0, y: 0, width: 100, height: 50, origin: { x: 50, y: 25 } },
      offsetParentNodeId: null,
      directChild: true,
      transform: [1, 0, 0, 1, 0, 0],
      offsetParentToRoot: [0, 2, -2, 0, 0, 0],
      box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    },
  },
  unsupported: {},
  themeUnsupported: {},
  unownedPortals: 0,
}

function authority() {
  const captured = captureGestureAuthority(() => ({
    file,
    pageId: 'page',
    atoms: [],
    layoutGeneration: 8,
    viewport: { x: 0, y: 0, zoom: 2 },
    viewportSize: { width: 800, height: 600 },
    selection: ['selected'],
  }), () => geometry)
  if (!captured) throw new Error('Expected a coherent gesture authority.')
  const resize = resizeGeometryAuthority(captured, 'selected')
  if (!resize) throw new Error('Expected strict resize geometry authority.')
  return { captured, resize }
}

const plain = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, spaceHeld: false }

describe('live resize interaction controller math', () => {
  it('maps the literal transformed-parent world sample into parent padding before projecting its quad and AABB', () => {
    const { captured, resize } = authority()
    const interaction = beginLiveResizeInteraction(captured, resize, 'top-left', { x: 0, y: 0 }, 'presentation-1')
    expect(interaction).not.toBeNull()

    const sampled = sampleLiveResizeInteraction(interaction!, { x: 30, y: 10 }, plain)
    expect(sampled?.sample).toEqual({
      coordinateSpace: 'parent-padding',
      rect: { x: 5, y: -15, width: 95, height: 65 },
      contentLocked: false,
      affectedAxes: ['x', 'y'],
      effectiveHandle: 'top-left',
    })
    expect(sampled?.presentation.byNodeId.selected?.world).toEqual({
      quad: [{ x: 30, y: 10 }, { x: 30, y: 200 }, { x: -100, y: 200 }, { x: -100, y: 10 }],
      aabb: { x: -100, y: 10, width: 130, height: 190 },
    })
    expect(sampled?.interaction.sampleSequence).toBe(0)
    expect(Object.isFrozen(sampled?.sample)).toBe(true)
    expect(Object.isFrozen(sampled?.presentation)).toBe(true)

    // Negative control: treating the raw world coordinates as parent-padding values produces this wrong rectangle.
    expect(sampled?.sample.rect).not.toEqual({ x: 30, y: 10, width: 70, height: 40 })
  })

  it('keeps modifier meaning and effective handle in the one sample that is also projected', () => {
    const { captured, resize } = authority()
    const interaction = beginLiveResizeInteraction(captured, resize, 'right', { x: -50, y: 200 }, 'presentation-2')!
    const modified = sampleLiveResizeInteraction(interaction, { x: -50, y: 240 }, {
      shiftKey: true, altKey: true, ctrlKey: false, metaKey: true, spaceHeld: false,
    })
    expect(modified?.sample).toEqual({
      coordinateSpace: 'parent-padding',
      rect: { x: -20, y: -10, width: 140, height: 70 },
      contentLocked: true,
      affectedAxes: ['x', 'y'],
      effectiveHandle: 'right',
    })
    expect(modified?.presentation).toMatchObject({
      contentLocked: true,
      affectedAxes: ['x', 'y'],
      effectiveHandle: 'right',
      byNodeId: { selected: { rect: modified?.sample.rect } },
    })

    const crossed = sampleLiveResizeInteraction(interaction, { x: -50, y: -50 }, plain)
    expect(crossed?.sample.effectiveHandle).toBe('left')
    expect(crossed?.sample.rect).toEqual({ x: -25, y: 0, width: 25, height: 50 })
  })

  it('fails closed if a caller substitutes a raw-world inverse for captured resize authority', () => {
    const { captured, resize } = authority()
    const altered = { ...resize, worldToGroup: [1, 0, 0, 1, 0, 0] as const }
    const interaction = beginLiveResizeInteraction(captured, altered, 'top-left', { x: 0, y: 0 }, 'presentation-invalid')
    expect(interaction).not.toBeNull()
    expect(sampleLiveResizeInteraction(interaction!, { x: 30, y: 10 }, plain)).toBeNull()
  })

  it('freezes controller-owned samples without freezing the shared store file or geometry inputs', () => {
    const { captured, resize } = authority()
    const interaction = beginLiveResizeInteraction(captured, resize, 'right', { x: -50, y: 200 }, 'presentation-owned')!
    const sampled = sampleLiveResizeInteraction(interaction, { x: -50, y: 240 }, plain)
    const selected = file.nodes.selected as PrimitiveNode
    const measured = geometry.nodes.selected!

    expect(Object.isFrozen(file)).toBe(false)
    expect(Object.isFrozen(selected)).toBe(false)
    expect(Object.isFrozen(geometry)).toBe(false)
    expect(Object.isFrozen(measured)).toBe(false)
    selected.name = 'Writable source'
    measured.rect.x = -99
    expect(selected.name).toBe('Writable source')
    expect(measured.rect.x).toBe(-99)
    selected.name = 'Selected'
    measured.rect.x = -100
    expect(Object.isFrozen(sampled?.interaction)).toBe(true)
    expect(Object.isFrozen(sampled?.interaction.state)).toBe(true)
    expect(Object.isFrozen(sampled?.sample)).toBe(true)
  })
})
