import { describe, expect, it } from 'vitest'
import { validateFileDocument } from '@canvas/repo-engine/file-document'
import type { FileDocument, PrimitiveNode } from '@canvas/repo-engine/file-document'
import type { Atom } from '@canvas/repo-engine/contracts'
import type { GestureAuthorityDocumentState, GestureAuthoritySnapshot } from './gesture-authority'
import { captureGestureAuthority } from './gesture-authority'
import { resizeGeometryAuthority } from './layout-measure'
import { projectResizePresentation } from './resize-projection'
import type { ResizeProjectionSample } from './resize-projection'
import type { MeasuredNode, SceneGeometry } from './scene-geometry'

const revision = 4, layoutGeneration = 8, measurementRevision = 12
const zeroBox = { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } }
const asset = { id: 'flowers', name: 'flowers.webp', mime: 'image/webp' as const, extension: 'webp' as const, width: 1600, height: 1200, bytes: 8, sha256: 'a'.repeat(64) }

function rectangle(id: string, left: number, top: number, width: number, height: number): PrimitiveNode {
  return { id, type: 'rectangle', name: id, styles: { left, top, width, height }, layout: { item: { position: { mode: 'freeform' } } } }
}

function baseFile(node: PrimitiveNode = rectangle('selected', 0, 0, 100, 50)): FileDocument {
  return {
    schemaVersion: 9, fileId: 'projection-file', revision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: { root: { id: 'root', type: 'root' }, [node.id]: node },
    relationships: { [node.id]: { parentId: 'root', orderKey: 'V' } },
    assets: { flowers: asset }, theme: { tokens: {} },
  }
}

function measured(
  kind: NonNullable<MeasuredNode['canvasKind']>,
  rect: { x: number; y: number; width: number; height: number },
  offset: { x: number; y: number; width: number; height: number },
  parentId: string | null,
  worldAabb = rect,
): MeasuredNode {
  return {
    canvasKind: kind, documentRevision: revision, layoutGeneration,
    rect, worldAabb,
    offset: { ...offset, origin: { x: offset.width / 2, y: offset.height / 2 } },
    offsetParentNodeId: parentId, directChild: true,
    transform: [1, 0, 0, 1, 0, 0],
    box: structuredClone(zeroBox),
  }
}

function baseGeometry(node: MeasuredNode): SceneGeometry {
  return { revision: measurementRevision, documentRevision: revision, layoutGeneration, nodes: { selected: node }, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 }
}

function snapshot(file: FileDocument, geometry: SceneGeometry, selected = 'selected', atoms: Atom[] = []): GestureAuthoritySnapshot {
  const state: GestureAuthorityDocumentState = {
    file, pageId: 'page', atoms, layoutGeneration,
    viewport: { x: 0, y: 0, zoom: 1 }, viewportSize: { width: 800, height: 600 }, selection: [selected],
  }
  const result = captureGestureAuthority(() => state, () => geometry)
  if (!result) throw new Error('Fixture did not produce gesture authority.')
  return result
}

function authorityFor(captured: GestureAuthoritySnapshot, id = 'selected') {
  const authority = resizeGeometryAuthority(captured, id)
  if (!authority) throw new Error('Fixture did not produce resize authority.')
  return authority
}

const sample = (rect: { x: number; y: number; width: number; height: number }, contentLocked = false): ResizeProjectionSample => ({
  coordinateSpace: 'parent-padding', rect, contentLocked, affectedAxes: ['x', 'y'], effectiveHandle: 'bottom-right',
})

describe('immutable resize projection', () => {
  it('keeps the selected rectangle parent-local and projects the literal rotated/scaled group exactly once', () => {
    const file = baseFile()
    ;(file.nodes.selected as PrimitiveNode).layout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } } } }
    const geometry = baseGeometry({
      ...measured('rectangle', { x: -100, y: 75, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null, { x: -100, y: 0, width: 100, height: 200 }),
      offsetParentToRoot: [0, 2, -2, 0, 0, 0],
    })
    const captured = snapshot(file, geometry)
    const authority = authorityFor(captured)
    const result = projectResizePresentation(captured, authority, sample({ x: 5, y: -15, width: 35, height: 50 }))

    expect(result?.items[0]).toMatchObject({
      nodeId: 'selected', parentId: 'root', coordinateSpace: 'parent-padding',
      startRect: { x: 0, y: 0, width: 100, height: 50 },
      rect: { x: 5, y: -15, width: 35, height: 50 },
      world: {
        quad: [{ x: 30, y: 10 }, { x: 30, y: 80 }, { x: -70, y: 80 }, { x: -70, y: 10 }],
        aabb: { x: -70, y: 10, width: 100, height: 70 },
      },
    })
    expect(result?.items[0]).toBe(result?.byNodeId.selected)
    expect(result).toMatchObject({ affectedAxes: ['x', 'y'], effectiveHandle: 'bottom-right' })
    expect(Object.isFrozen(result?.affectedAxes)).toBe(true)
    expect(Object.keys(result?.byNodeId ?? {})).toEqual(['selected'])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result?.items)).toBe(true)
    expect(Object.isFrozen(result?.items[0]?.world.quad)).toBe(true)

    // Negative controls: a raw-world authority and a second selected rotation are not the captured authority.
    expect(projectResizePresentation(captured, { ...authority, groupToWorld: [1, 0, 0, 1, 0, 0] }, sample({ x: 5, y: -15, width: 35, height: 50 }))).toBeNull()
    expect(projectResizePresentation(captured, { ...authority, rotationDegrees: 90 }, sample({ x: 5, y: -15, width: 35, height: 50 }))).toBeNull()
  })

  it('scales explicit image geometry in local axes and leaves ordinary implicit fits implicit', () => {
    const explicit = baseFile()
    explicit.nodes.selected = {
      ...explicit.nodes.selected as PrimitiveNode,
      appearance: { fills: [{ id: 'image', type: 'image', assetId: 'flowers', fit: 'cover', geometry: { x: 10, y: 5, width: 40, height: 20 } }] },
    }
    const explicitGeometry = baseGeometry({ ...measured('rectangle', { x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null), offsetParentToRoot: [1, 0, 0, 1, 0, 0] })
    const explicitSnapshot = snapshot(explicit, explicitGeometry)
    const scaled = projectResizePresentation(explicitSnapshot, authorityFor(explicitSnapshot), sample({ x: 0, y: 0, width: 200, height: 100 }))
    expect(scaled?.items[0]?.appearance?.fills?.[0]).toMatchObject({ geometry: { x: 20, y: 10, width: 80, height: 40 } })
    expect(Object.isFrozen((explicit.nodes.selected as PrimitiveNode).appearance)).toBe(false)
    expect(Object.isFrozen((explicit.nodes.selected as PrimitiveNode).appearance?.fills?.[0])).toBe(false)

    const implicit = baseFile()
    implicit.nodes.selected = { ...implicit.nodes.selected as PrimitiveNode, appearance: { fills: [{ id: 'image', type: 'image', assetId: 'flowers', fit: 'contain' }] } }
    const implicitSnapshot = snapshot(implicit, structuredClone(explicitGeometry))
    const fitted = projectResizePresentation(implicitSnapshot, authorityFor(implicitSnapshot), sample({ x: 0, y: 0, width: 200, height: 100 }))
    expect(fitted?.items[0]?.appearance).toBeUndefined()
    expect((implicit.nodes.selected as PrimitiveNode).appearance?.fills?.[0]).not.toHaveProperty('geometry')
  })

  it('materializes and counter-moves rotated content-lock image geometry in node-local space', () => {
    const file = baseFile(rectangle('selected', 10, 20, 100, 50))
    const selected = file.nodes.selected as PrimitiveNode
    selected.styles.rotation = 90
    selected.appearance = { fills: [{ id: 'image', type: 'image', assetId: 'flowers', fit: 'cover', geometry: { x: 10, y: 5, width: 40, height: 20 } }] }
    const node = measured('rectangle', { x: 10, y: 20, width: 100, height: 50 }, { x: 10, y: 20, width: 100, height: 50 }, null, { x: 35, y: -5, width: 50, height: 100 })
    node.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    node.transform = [0, 1, -1, 0, 0, 0]
    const captured = snapshot(file, baseGeometry(node))
    const result = projectResizePresentation(captured, authorityFor(captured), sample({ x: 20, y: 20, width: 120, height: 50 }, true))
    expect(result?.items[0]?.appearance?.fills?.[0]).toMatchObject({ geometry: { x: 20, y: 25, width: 40, height: 20 } })
    const rotate90 = (point: { x: number; y: number }, center: { x: number; y: number }) => ({ x: center.x - (point.y - center.y), y: center.y + point.x - center.x })
    const oldWorld = [{ x: 20, y: 25 }, { x: 60, y: 25 }, { x: 60, y: 45 }, { x: 20, y: 45 }].map(point => rotate90(point, { x: 60, y: 45 }))
    const newWorld = [{ x: 40, y: 45 }, { x: 80, y: 45 }, { x: 80, y: 65 }, { x: 40, y: 65 }].map(point => rotate90(point, { x: 80, y: 45 }))
    expect(oldWorld).toEqual([{ x: 80, y: 5 }, { x: 80, y: 45 }, { x: 60, y: 45 }, { x: 60, y: 5 }])
    expect(newWorld).toEqual(oldWorld)
    // Raw start-next subtraction yields x=0, which does not preserve the old rotated world quad.
    expect({ x: 10 + 10 - 20, y: 5 + 20 - 20, width: 40, height: 20 }).not.toEqual({ x: 20, y: 25, width: 40, height: 20 })

    selected.appearance = { fills: [{ id: 'implicit', type: 'image', assetId: 'flowers', fit: 'contain' }] }
    const implicitCaptured = snapshot(file, baseGeometry(structuredClone(node)))
    const implicit = projectResizePresentation(implicitCaptured, authorityFor(implicitCaptured), sample({ x: 20, y: 20, width: 120, height: 50 }, true))
    expect(implicit?.items[0]?.appearance?.fills?.[0]).toHaveProperty('geometry')
  })

  it('holds a direct freeform child world-fixed under a rotated and scaled selected ancestor', () => {
    const frame: PrimitiveNode = { id: 'selected', type: 'frame', name: 'Frame', styles: { left: 0, top: 0, width: 100, height: 50 }, layout: { item: { position: { mode: 'freeform' } } } }
    const file = baseFile(frame)
    frame.layout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } } } }
    file.nodes.child = rectangle('child', 10, 5, 20, 10)
    file.nodes.child.isLocked = true
    file.relationships.child = { parentId: 'selected', orderKey: 'V' }
    const selected = measured('frame', { x: -100, y: 75, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null, { x: -100, y: 0, width: 100, height: 200 })
    selected.offsetParentToRoot = [0, 2, -2, 0, 0, 0]
    const child = measured('rectangle', { x: 10, y: 5, width: 20, height: 10 }, { x: 10, y: 5, width: 20, height: 10 }, 'selected', { x: -30, y: 20, width: 20, height: 40 })
    const geometry = baseGeometry(selected); geometry.nodes.child = child
    const captured = snapshot(file, geometry)
    const result = projectResizePresentation(captured, authorityFor(captured), sample({ x: 5, y: -15, width: 35, height: 50 }, true))

    expect(result?.items.map(item => item.nodeId)).toEqual(['selected', 'child'])
    expect(result?.byNodeId.child?.rect).toEqual({ x: 5, y: 20, width: 20, height: 10 })
    expect(result?.byNodeId.child?.world).toEqual({
      quad: [{ x: -10, y: 20 }, { x: -10, y: 60 }, { x: -30, y: 60 }, { x: -30, y: 20 }],
      aabb: { x: -30, y: 20, width: 20, height: 40 },
    })
    const directlySelectedChild = snapshot(file, structuredClone(geometry), 'child')
    expect(resizeGeometryAuthority(directlySelectedChild, 'child')).toBeNull()
  })

  it('scales a locked nested subtree once in each local padding space', () => {
    const selected: PrimitiveNode = { id: 'selected', type: 'frame', name: 'Selected', styles: { left: 0, top: 0, width: 100, height: 100 }, layout: { item: { position: { mode: 'freeform' } } } }
    const file = baseFile(selected)
    file.nodes.child = { id: 'child', type: 'frame', name: 'Child', styles: { left: 10, top: 20, width: 40, height: 50 }, layout: { item: { position: { mode: 'freeform' } } } }
    file.nodes.child.isLocked = true
    file.nodes.grand = rectangle('grand', 5, 6, 10, 20)
    ;(file.nodes.grand as PrimitiveNode).appearance = { fills: [{ id: 'image', type: 'image', assetId: 'flowers', fit: 'cover', geometry: { x: 1, y: 2, width: 4, height: 5 } }] }
    file.relationships.child = { parentId: 'selected', orderKey: 'V' }
    file.relationships.grand = { parentId: 'child', orderKey: 'V' }

    const parent = measured('frame', { x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }, null)
    parent.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    parent.box = { border: { top: 10, right: 10, bottom: 10, left: 10 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } }
    const child = measured('frame', { x: 10, y: 20, width: 40, height: 50 }, { x: 10, y: 20, width: 40, height: 50 }, 'selected', { x: 20, y: 30, width: 40, height: 50 })
    child.box = { border: { top: 5, right: 5, bottom: 5, left: 5 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } }
    const grand = measured('rectangle', { x: 15, y: 26, width: 10, height: 20 }, { x: 5, y: 6, width: 10, height: 20 }, 'child', { x: 30, y: 41, width: 10, height: 20 })
    const geometry = baseGeometry(parent); geometry.nodes.child = child; geometry.nodes.grand = grand
    const captured = snapshot(file, geometry)
    const result = projectResizePresentation(captured, authorityFor(captured), sample({ x: 0, y: 0, width: 200, height: 200 }))

    expect(result?.items.map(item => item.nodeId)).toEqual(['selected', 'child', 'grand'])
    expect(result?.byNodeId.child?.rect).toEqual({ x: 22.5, y: 45, width: 90, height: 112.5 })
    expect(result?.byNodeId.grand?.rect).toEqual({ x: 13.333333333333332, y: 15.375, width: 26.666666666666664, height: 51.25 })
    expect(result?.byNodeId.grand?.appearance?.fills?.[0]).toMatchObject({ geometry: { x: 2.6666666666666665, y: 5.125, width: 10.666666666666666, height: 12.8125 } })
    // Mutation control: applying only the selected parent's 2.25 ratio ignores the nested parent's fixed border.
    expect(result?.byNodeId.grand?.rect).not.toEqual({ x: 11.25, y: 13.5, width: 22.5, height: 45 })
    const directlySelectedChild = snapshot(file, structuredClone(geometry), 'child')
    expect(resizeGeometryAuthority(directlySelectedChild, 'child')).toBeNull()
  })

  it('omits flow subtrees but rejects a missing or unsupported represented child', () => {
    const frame: PrimitiveNode = { id: 'selected', type: 'frame', name: 'Frame', styles: { left: 0, top: 0, width: 100, height: 100 }, layout: { item: { position: { mode: 'freeform' } } } }
    const file = baseFile(frame)
    file.nodes.flow = { ...rectangle('flow', 0, 0, 20, 20), layout: { item: { position: { mode: 'flow' } } } }
    file.relationships.flow = { parentId: 'selected', orderKey: 'V' }
    const selected = measured('frame', { x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }, null)
    selected.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    const geometry = baseGeometry(selected)
    geometry.nodes.flow = measured('rectangle', { x: 0, y: 0, width: 20, height: 20 }, { x: 0, y: 0, width: 20, height: 20 }, 'selected')
    const captured = snapshot(file, geometry)
    const projected = projectResizePresentation(captured, authorityFor(captured), sample({ x: 0, y: 0, width: 200, height: 200 }))
    expect(projected?.items.map(item => item.nodeId)).toEqual(['selected'])

    const missingFile = structuredClone(file)
    missingFile.nodes.free = rectangle('free', 10, 10, 20, 20)
    missingFile.relationships.free = { parentId: 'selected', orderKey: 'k' }
    const missing = snapshot(missingFile, structuredClone(geometry))
    expect(projectResizePresentation(missing, authorityFor(missing), sample({ x: 0, y: 0, width: 200, height: 200 }))).toBeNull()

    const unsupportedFile = structuredClone(missingFile)
    const unsupportedGeometry = structuredClone(geometry)
    unsupportedGeometry.nodes.free = measured('rectangle', { x: 10, y: 10, width: 20, height: 20 }, { x: 10, y: 10, width: 20, height: 20 }, 'selected')
    ;(unsupportedFile.nodes.free as PrimitiveNode).layout = { item: { position: { mode: 'absolute', right: { kind: 'px', value: 1 }, top: { kind: 'px', value: 10 } } } }
    const unsupported = snapshot(unsupportedFile, unsupportedGeometry)
    expect(projectResizePresentation(unsupported, authorityFor(unsupported), sample({ x: 0, y: 0, width: 200, height: 200 }))).toBeNull()

    const exactAbsoluteFile = structuredClone(unsupportedFile)
    ;(exactAbsoluteFile.nodes.free as PrimitiveNode).layout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 10 }, top: { kind: 'px', value: 10 } } } }
    const exactAbsolute = snapshot(exactAbsoluteFile, structuredClone(unsupportedGeometry))
    expect(projectResizePresentation(exactAbsolute, authorityFor(exactAbsolute), sample({ x: 0, y: 0, width: 200, height: 200 }))?.items.map(item => item.nodeId)).toEqual(['selected', 'free'])

    const anchoredSelectedFile = baseFile()
    const anchoredSelected = anchoredSelectedFile.nodes.selected
    if (!anchoredSelected || anchoredSelected.type === 'root' || anchoredSelected.type === 'component') throw new Error('Fixture primitive is missing.')
    anchoredSelected.layout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, right: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } } } }
    const anchoredSelectedGeometry = baseGeometry({ ...measured('rectangle', { x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null), offsetParentToRoot: [1, 0, 0, 1, 0, 0] })
    const anchoredSelectedSnapshot = snapshot(anchoredSelectedFile, anchoredSelectedGeometry)
    expect(projectResizePresentation(anchoredSelectedSnapshot, authorityFor(anchoredSelectedSnapshot), sample({ x: 0, y: 0, width: 120, height: 60 }))).toBeNull()

    const flowSelectedFile = baseFile()
    const flowSelected = flowSelectedFile.nodes.selected
    if (!flowSelected || flowSelected.type === 'root' || flowSelected.type === 'component') throw new Error('Fixture primitive is missing.')
    flowSelected.layout = { item: { position: { mode: 'flow' } } }
    const flowSelectedGeometry = baseGeometry({ ...measured('rectangle', { x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null), offsetParentToRoot: [1, 0, 0, 1, 0, 0] })
    const flowSelectedSnapshot = snapshot(flowSelectedFile, flowSelectedGeometry)
    expect(projectResizePresentation(flowSelectedSnapshot, authorityFor(flowSelectedSnapshot), sample({ x: 0, y: 0, width: 120, height: 60 }))).toBeNull()
  })

  it('projects only representable root Component geometry without changing identity or props', () => {
    const file = baseFile()
    file.nodes.selected = {
      id: 'selected', type: 'component', componentId: 'card-source', exportName: 'Card',
      props: { heading: 'Welcome', variant: 'primary' },
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 10 }, top: { kind: 'px', value: 20 } } } },
    }
    const componentMeasure = measured('rectangle', { x: 10, y: 20, width: 100, height: 50 }, { x: 10, y: 20, width: 100, height: 50 }, null)
    delete componentMeasure.canvasKind
    componentMeasure.componentId = 'card-source'
    componentMeasure.parentInstanceId = null
    componentMeasure.offsetParentInstanceId = null
    componentMeasure.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    const geometry = baseGeometry(componentMeasure)
    const captured = snapshot(file, geometry)
    const before = structuredClone(file.nodes.selected)
    const projected = projectResizePresentation(captured, authorityFor(captured), sample({ x: 15, y: 25, width: 120, height: 60 }))

    expect(projected?.items).toHaveLength(1)
    expect(projected?.items[0]).toMatchObject({ nodeId: 'selected', parentId: 'root', rect: { x: 15, y: 25, width: 120, height: 60 } })
    expect(file.nodes.selected).toEqual(before)
    expect(projected?.items[0]).not.toHaveProperty('componentId')
    expect(projected?.items[0]).not.toHaveProperty('props')

    const anchoredFile = structuredClone(file)
    const component = anchoredFile.nodes.selected
    if (!component || component.type !== 'component') throw new Error('Fixture component is missing.')
    component.layout = { item: { position: { mode: 'absolute', right: { kind: 'px', value: 10 }, top: { kind: 'px', value: 20 } } } }
    const anchoredSnapshot = snapshot(anchoredFile, structuredClone(geometry))
    expect(projectResizePresentation(anchoredSnapshot, authorityFor(anchoredSnapshot), sample({ x: 15, y: 20, width: 120, height: 60 }))).toBeNull()
  })

  it('preserves every nested Component identity and relationship field while projecting its local rectangle', () => {
    const atoms: Atom[] = [
      {
        name: 'Panel', kind: 'atom', componentId: 'panel-source', path: 'src/Panel.tsx', exportName: 'Panel',
        fingerprint: 'panel', sourceHash: 'panel', status: 'bound', candidates: [], slots: ['body'],
        props: [{ name: 'tone', type: 'string', optional: true }, { name: 'body', type: 'ReactNode', optional: true }],
      },
      {
        name: 'Button', kind: 'atom', componentId: 'button-source', path: 'src/Button.tsx', exportName: 'Button',
        fingerprint: 'button', sourceHash: 'button', status: 'bound', candidates: [], slots: [],
        props: [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'variant', type: 'string', optional: true }],
      },
    ]
    const file: FileDocument = {
      schemaVersion: 9, fileId: 'projection-file', revision,
      pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: {
        root: { id: 'root', type: 'root' },
        parent: {
          id: 'parent', type: 'component', componentId: 'panel-source', exportName: 'Panel', props: { tone: 'dark' },
          layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 50 }, top: { kind: 'px', value: 60 } } } },
        },
        selected: {
          id: 'selected', type: 'component', componentId: 'button-source', exportName: 'Button', props: { children: 'Continue', variant: 'primary' },
          layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 20 }, top: { kind: 'px', value: 30 } } } },
        },
      },
      relationships: {
        parent: { parentId: 'root', orderKey: 'F' },
        selected: { parentId: 'parent', orderKey: 'V', slot: 'body' },
      },
      theme: { tokens: {} },
    }
    const parent = measured('rectangle', { x: 50, y: 60, width: 200, height: 160 }, { x: 50, y: 60, width: 200, height: 160 }, null)
    delete parent.canvasKind
    parent.componentId = 'panel-source'; parent.parentInstanceId = null; parent.offsetParentInstanceId = null
    parent.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    const child = measured('rectangle', { x: 70, y: 90, width: 100, height: 50 }, { x: 20, y: 30, width: 100, height: 50 }, 'parent')
    delete child.canvasKind
    child.componentId = 'button-source'; child.parentInstanceId = 'parent'; child.offsetParentInstanceId = 'parent'
    const geometry: SceneGeometry = {
      revision: measurementRevision, documentRevision: revision, layoutGeneration,
      nodes: { parent, selected: child }, unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    }
    const beforeNode = structuredClone(file.nodes.selected)
    const beforeRelationship = structuredClone(file.relationships.selected)
    expect(validateFileDocument(structuredClone(file), atoms)).toStrictEqual(file)
    const captured = snapshot(file, geometry, 'selected', atoms)
    const projected = projectResizePresentation(captured, authorityFor(captured), sample({ x: 25, y: 35, width: 120, height: 60 }))

    expect(projected?.items[0]?.rect).toEqual({ x: 25, y: 35, width: 120, height: 60 })
    expect(file.nodes.selected).toStrictEqual(beforeNode)
    expect(file.relationships.selected).toStrictEqual(beforeRelationship)
    expect(file.relationships.selected).toStrictEqual({ parentId: 'parent', orderKey: 'V', slot: 'body' })

    const missingSlot = snapshot(structuredClone(file), structuredClone(geometry), 'selected', atoms)
    delete missingSlot.file.relationships.selected!.slot
    expect(resizeGeometryAuthority(missingSlot, 'selected')).toBeNull()

    const wrongSlot = snapshot(structuredClone(file), structuredClone(geometry), 'selected', atoms)
    wrongSlot.file.relationships.selected!.slot = 'footer'
    expect(resizeGeometryAuthority(wrongSlot, 'selected')).toBeNull()

    const undeclaredAtoms = structuredClone(atoms)
    undeclaredAtoms[0]!.slots = []
    const undeclaredSlot = snapshot(structuredClone(file), structuredClone(geometry), 'selected', undeclaredAtoms)
    expect(resizeGeometryAuthority(undeclaredSlot, 'selected')).toBeNull()

    const componentUnderFrame = snapshot(structuredClone(file), structuredClone(geometry), 'selected', atoms)
    componentUnderFrame.file.nodes.parent = { id: 'parent', type: 'frame', name: 'Parent', styles: { left: 50, top: 60, width: 200, height: 160 } }
    expect(resizeGeometryAuthority(componentUnderFrame, 'selected')).toBeNull()

    const primitiveUnderComponent = snapshot(structuredClone(file), structuredClone(geometry), 'selected', atoms)
    primitiveUnderComponent.file.nodes.selected = rectangle('selected', 20, 30, 100, 50)
    expect(resizeGeometryAuthority(primitiveUnderComponent, 'selected')).toBeNull()
  })

  it('fails closed for stale, invalid, or partial inputs without mutating snapshot, authority, or sample', () => {
    const file = baseFile()
    const geometry = baseGeometry({ ...measured('rectangle', { x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null), offsetParentToRoot: [1, 0, 0, 1, 0, 0] })
    const captured = snapshot(file, geometry)
    const authority = authorityFor(captured)
    const terminal = sample({ x: 5, y: 5, width: 120, height: 60 })
    const before = { file: JSON.stringify(captured.file), geometry: JSON.stringify(captured.geometry), authority: JSON.stringify(authority), sample: JSON.stringify(terminal) }
    expect(projectResizePresentation(captured, authority, terminal)).not.toBeNull()
    const vertical = projectResizePresentation(captured, authority, { ...terminal, affectedAxes: ['y'], effectiveHandle: 'top' })
    expect(vertical).toMatchObject({ affectedAxes: ['y'], effectiveHandle: 'top' })
    expect({ file: JSON.stringify(captured.file), geometry: JSON.stringify(captured.geometry), authority: JSON.stringify(authority), sample: JSON.stringify(terminal) }).toEqual(before)

    expect(projectResizePresentation(captured, authority, sample({ x: 0, y: 0, width: 0, height: 1 }))).toBeNull()
    const { contentLocked: _contentLocked, ...withoutContentLock } = terminal
    expect(projectResizePresentation(captured, authority, withoutContentLock as ResizeProjectionSample)).toBeNull()
    expect(projectResizePresentation(captured, authority, { ...terminal, contentLocked: undefined as unknown as boolean })).toBeNull()
    expect(projectResizePresentation(captured, authority, { ...terminal, contentLocked: 'false' as unknown as boolean })).toBeNull()
    expect(projectResizePresentation(captured, authority, { ...terminal, contentLocked: 0 as unknown as boolean })).toBeNull()
    expect(projectResizePresentation(captured, authority, { ...terminal, affectedAxes: [] })).toBeNull()
    expect(projectResizePresentation(captured, authority, { ...terminal, affectedAxes: ['x', 'x'] })).toBeNull()
    expect(projectResizePresentation(captured, authority, { ...terminal, affectedAxes: ['z'] as unknown as ['x'] })).toBeNull()
    expect(projectResizePresentation(captured, authority, { ...terminal, effectiveHandle: 'center' as unknown as 'right' })).toBeNull()
    expect(projectResizePresentation(captured, { ...authority, fence: { ...authority.fence, layoutGeneration: 7 } }, terminal)).toBeNull()
    delete captured.geometry.nodes.selected!.offset
    expect(projectResizePresentation(captured, authority, terminal)).toBeNull()

    const missingAssetFile = baseFile()
    ;(missingAssetFile.nodes.selected as PrimitiveNode).appearance = { fills: [{ id: 'image', type: 'image', assetId: 'missing', fit: 'cover', geometry: { x: 0, y: 0, width: 10, height: 10 } }] }
    const missingAssetGeometry = baseGeometry({ ...measured('rectangle', { x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null), offsetParentToRoot: [1, 0, 0, 1, 0, 0] })
    const missingAsset = snapshot(missingAssetFile, missingAssetGeometry)
    expect(projectResizePresentation(missingAsset, authorityFor(missingAsset), terminal)).toBeNull()
  })
})
