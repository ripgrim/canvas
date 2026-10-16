import { describe, expect, it, vi } from 'vitest'
import { applyFileCommand } from '@canvas/repo-engine/file-document'
import type { ComponentNode, FileDocument, PrimitiveNode, TextStyle } from '@canvas/repo-engine/file-document'
import type { LayoutGeometry } from './layout-measure'
import * as layoutMeasure from './layout-measure'
import { paperRemoveFlexCopy, planPaperRemoveFlex } from './layout-remove-planner'

const px = (value: number) => ({ kind: 'px' as const, value })
const textStyle = (): TextStyle => ({
  fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize: 16,
  lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0,
  horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false,
})

function frameFixture(): { file: FileDocument; geometry: LayoutGeometry } {
  const parent: PrimitiveNode = {
    id: 'parent', type: 'frame', name: 'Parent', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 300, height: 180, overflow: 'clip' },
    layout: {
      item: {
        position: { mode: 'absolute', left: px(10), top: px(20) },
        width: { value: { kind: 'intrinsic', value: 'fit-content' } },
        height: { value: { kind: 'intrinsic', value: 'fit-content' } },
        aspectRatio: 2,
      },
      container: { display: 'flex', gap: { x: 12, y: 8 }, flex: { direction: 'row', wrap: 'wrap', justify: 'space-between', align: 'center', alignContent: 'end' } },
      spacing: { padding: { x: 16, y: 12 }, margin: { top: 1, right: 2, bottom: 3, left: 4 } },
    },
  }
  const fill: PrimitiveNode = {
    id: 'fill', type: 'rectangle', name: 'Fill', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 30, height: 20 },
    layout: { item: { position: { mode: 'flow' }, width: { value: { kind: 'percent', value: 100 } }, flex: { grow: 1 } } },
  }
  const absolute: PrimitiveNode = {
    id: 'absolute', type: 'shape', name: 'Absolute', styles: { relativeTransform: [0.978147600734, 0.207911690818, -0.207911690818, 0.978147600734, 202.40690289717, 117.099848630396], width: 30, height: 20 },
    layout: { item: { position: { mode: 'absolute', left: px(200), top: px(120), zIndex: 3 } } },
  }
  const copy: PrimitiveNode = {
    id: 'copy', type: 'text', name: 'Copy', text: 'Two lines', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 80, height: 40 },
    textStyle: textStyle(), textSizing: { width: { mode: 'fill' }, height: { mode: 'fill' } },
    layout: { item: { position: { mode: 'flow' }, flex: { shrink: 0 } } },
  }
  const file: FileDocument = {
    schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'remove-flex', revision: 9,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: { root: { id: 'root', type: 'root' }, parent, absolute, copy, fill },
    relationships: {
      parent: { parentId: 'root', orderKey: 'V' },
      copy: { parentId: 'parent', orderKey: 'X' },
      absolute: { parentId: 'parent', orderKey: 'W' },
      fill: { parentId: 'parent', orderKey: 'V' },
    },
    theme: { tokens: {} },
  }
  const geometry: LayoutGeometry = {
    documentRevision: 9, layoutGeneration: 5, unsupported: {},
    nodes: {
      parent: {
        canvasKind: 'frame', documentRevision: 9, layoutGeneration: 5,
        rect: { x: 10, y: 20, width: 320, height: 210 },
        offset: { x: 10, y: 20, width: 320, height: 210, origin: { x: 160, y: 105 } },
        box: { border: { top: 1, right: 2, bottom: 3, left: 4 }, padding: { top: 30, right: 24, bottom: 18, left: 12 } },
        offsetParentNodeId: null, directChild: true,
      },
      fill: {
        canvasKind: 'rectangle', documentRevision: 9, layoutGeneration: 5,
        rect: { x: -15, y: 22, width: 90, height: 20 },
        offset: { x: -15, y: 22, width: 90, height: 20, origin: { x: 45, y: 10 } },
        offsetParentNodeId: 'parent', directChild: true,
      },
      copy: {
        canvasKind: 'text', documentRevision: 9, layoutGeneration: 5,
        rect: { x: 760, y: 24, width: 110, height: 40 },
        offset: { x: 760, y: 24, width: 110, height: 40, origin: { x: 55, y: 20 } },
        offsetParentNodeId: 'parent', directChild: true, text: { resolvedLineHeight: 20 },
      },
    },
  }
  return { file, geometry }
}

function emptyFrame(id: string, orderKey: string, x: number): { node: PrimitiveNode; relationship: FileDocument['relationships'][string]; measurement: LayoutGeometry['nodes'][string] } {
  return {
    node: {
      id, type: 'frame', name: id, styles: { relativeTransform: [1, 0, 0, 1, x, 0], width: 100, height: 80 },
      layout: { item: { position: { mode: 'absolute', left: px(x), top: px(0) } }, container: { display: 'flex', flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } } },
    },
    relationship: { parentId: 'root', orderKey },
    measurement: {
      canvasKind: 'frame', documentRevision: 2, layoutGeneration: 3, rect: { x, y: 0, width: 100, height: 80 },
      offset: { x, y: 0, width: 100, height: 80, origin: { x: 50, y: 40 } },
      box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      offsetParentNodeId: null, directChild: true,
    },
  }
}

describe('Paper Remove Flex planner', () => {
  it('PAPER-FLEX-001/003/008 emits one closed Frame transaction with exact geometry and sizing authority', () => {
    const { file, geometry } = frameFixture()
    const fileBefore = structuredClone(file), geometryBefore = structuredClone(geometry)
    const fileBytes = JSON.stringify(file), geometryBytes = JSON.stringify(geometry)
    const result = planPaperRemoveFlex({ file, geometry, selection: ['parent', 'parent'], layoutGeneration: 5 })
    expect(result).toStrictEqual({
      status: 'ready', parentIds: ['parent'], command: {
        type: 'node.removeFlex', groups: [{
          parent: {
            nodeId: 'parent', relationship: { parentId: 'root', orderKey: 'V' },
            layout: {
              item: { position: { mode: 'absolute', left: px(10), top: px(20) }, aspectRatio: 2 },
              container: { display: 'freeform' },
              spacing: { padding: { x: 16, y: 12 }, margin: { top: 1, right: 2, bottom: 3, left: 4 } },
            },
            primitiveSize: { width: 320, height: 210 },
          },
          children: [
            {
              nodeId: 'fill', relationship: { parentId: 'parent', orderKey: 'V' },
              layout: { item: { position: { mode: 'absolute', left: px(-15), top: px(22) } } },
              primitiveSize: { width: 90, height: 20 },
            },
            {
              nodeId: 'copy', relationship: { parentId: 'parent', orderKey: 'X' },
              layout: { item: { position: { mode: 'absolute', left: px(760), top: px(24) } } },
              primitiveSize: { width: 110, height: 40 },
              textProperties: { textStyle: textStyle(), textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } } },
            },
          ],
        }],
      },
    })
    expect(file).toStrictEqual(fileBefore); expect(geometry).toStrictEqual(geometryBefore)
    expect(JSON.stringify(file)).toBe(fileBytes); expect(JSON.stringify(geometry)).toBe(geometryBytes)

    if (result.status !== 'ready') throw new Error(result.message)
    const applied = applyFileCommand(file, result.command, [])
    expect(applied.relationships).toStrictEqual(file.relationships)
    expect(applied.nodes.absolute).toStrictEqual(file.nodes.absolute)
    expect(applied.nodes.parent).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 320, height: 210, overflow: 'clip' } })
    expect((applied.nodes.parent as PrimitiveNode).layout).toStrictEqual(result.command.groups[0]!.parent.layout)
  })

  it('PAPER-FLEX-001 orders multiple empty parents by the tree and invokes geometry once per parent', () => {
    const first = emptyFrame('first', 'V', 0), second = emptyFrame('second', 'W', 200)
    const file: FileDocument = {
      schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'multi', revision: 2, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: { root: { id: 'root', type: 'root' }, second: second.node, first: first.node },
      relationships: { second: second.relationship, first: first.relationship }, theme: { tokens: {} },
    }
    const geometry: LayoutGeometry = { documentRevision: 2, layoutGeneration: 3, unsupported: {}, nodes: { second: second.measurement, first: first.measurement } }
    const spy = vi.spyOn(layoutMeasure, 'paperRemoveFlexGeometry')
    const result = planPaperRemoveFlex({ file, geometry, selection: ['second', 'first', 'second'], layoutGeneration: 3 })
    expect(result).toMatchObject({ status: 'ready', parentIds: ['first', 'second'] })
    if (result.status !== 'ready') throw new Error(result.message)
    expect(result.command.groups.map(group => [group.parent.nodeId, group.children])).toStrictEqual([['first', []], ['second', []]])
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it('PAPER-FLEX-001 supports a Component parent and Component child without primitive sizing authority', () => {
    const card: ComponentNode = {
      id: 'card', type: 'component', componentId: 'card-source', exportName: 'Card', props: {},
      layout: { item: { position: { mode: 'flow' }, width: { value: { kind: 'intrinsic', value: 'fit-content' } } }, container: { display: 'flex', overflow: 'hidden', flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } } },
    }
    const child: ComponentNode = { id: 'child', type: 'component', componentId: 'label-source', exportName: 'Label', props: {}, layout: { item: { position: { mode: 'flow' }, width: { value: { kind: 'percent', value: 100 } } } } }
    const file: FileDocument = {
      schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'components', revision: 4, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: { root: { id: 'root', type: 'root' }, card, child }, relationships: { card: { parentId: 'root', orderKey: 'V' }, child: { parentId: 'card', orderKey: 'V', slot: 'children' } }, theme: { tokens: {} },
    }
    const geometry: LayoutGeometry = {
      documentRevision: 4, layoutGeneration: 8, unsupported: {}, nodes: {
        card: { componentId: 'card-source', documentRevision: 4, layoutGeneration: 8, rect: { x: 0, y: 0, width: 220, height: 120 }, offset: { x: 0, y: 0, width: 220, height: 120, origin: { x: 110, y: 60 } }, box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } }, offsetParentNodeId: null, parentInstanceId: null, directChild: true },
        child: { componentId: 'label-source', documentRevision: 4, layoutGeneration: 8, rect: { x: 12, y: 16, width: 100, height: 24 }, offset: { x: 12, y: 16, width: 100, height: 24, origin: { x: 50, y: 12 } }, offsetParentNodeId: 'card', parentInstanceId: 'card', directChild: true },
      },
    }
    const result = planPaperRemoveFlex({ file, geometry, selection: ['card'], layoutGeneration: 8 })
    expect(result).toStrictEqual({
      status: 'ready', parentIds: ['card'], command: { type: 'node.removeFlex', groups: [{
        parent: { nodeId: 'card', relationship: { parentId: 'root', orderKey: 'V' }, layout: { item: { position: { mode: 'flow' }, width: { value: px(220) }, height: { value: { kind: 'auto' } } }, container: { display: 'freeform', overflow: 'hidden' } } },
        children: [{ nodeId: 'child', relationship: { parentId: 'card', orderKey: 'V', slot: 'children' }, layout: { item: { position: { mode: 'absolute', left: px(12), top: px(16) }, width: { value: px(100) }, height: { value: px(24) } } } }],
      }] },
    })
  })

  it('PAPER-FLEX-001 rejects nested selection before any geometry call', () => {
    const { file, geometry } = frameFixture()
    const inner: PrimitiveNode = {
      id: 'inner', type: 'frame', name: 'Inner', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 40, height: 30 },
      layout: { item: { position: { mode: 'flow' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } },
    }
    file.nodes.inner = inner
    file.relationships.inner = { parentId: 'parent', orderKey: 'Y' }
    const spy = vi.spyOn(layoutMeasure, 'paperRemoveFlexGeometry')
    expect(planPaperRemoveFlex({ file, geometry, selection: ['inner', 'parent'], layoutGeneration: 5 })).toStrictEqual({ status: 'unavailable', reason: 'topology', message: paperRemoveFlexCopy.topology })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('PAPER-FLEX-008 fails closed for empty, missing, stale, source-identity, topology, measurement, and editability evidence', () => {
    const base = frameFixture()
    expect(planPaperRemoveFlex({ ...base, selection: [], layoutGeneration: 5 })).toStrictEqual({ status: 'unavailable', reason: 'empty', message: paperRemoveFlexCopy.empty })
    expect(planPaperRemoveFlex({ ...base, selection: ['missing'], layoutGeneration: 5 })).toStrictEqual({ status: 'unavailable', reason: 'missing', message: paperRemoveFlexCopy.missing })
    const mutations: Array<(geometry: LayoutGeometry) => void> = [
      geometry => { geometry.documentRevision = 8 },
      geometry => { geometry.layoutGeneration = 4 },
      geometry => { geometry.nodes.parent!.canvasKind = 'shape' },
      geometry => { geometry.nodes.fill!.offsetParentNodeId = 'other' },
      geometry => { geometry.nodes.fill!.offset!.width = 0 },
      geometry => { delete geometry.nodes.copy!.text },
    ]
    for (const mutate of mutations) {
      const { file, geometry } = frameFixture()
      mutate(geometry)
      const beforeFile = structuredClone(file), beforeGeometry = structuredClone(geometry)
      const fileBytes = JSON.stringify(file), geometryBytes = JSON.stringify(geometry)
      expect(planPaperRemoveFlex({ file, geometry, selection: ['parent'], layoutGeneration: 5 })).toStrictEqual({ status: 'unavailable', reason: 'geometry', message: paperRemoveFlexCopy.geometry })
      expect(file).toStrictEqual(beforeFile); expect(geometry).toStrictEqual(beforeGeometry)
      expect(JSON.stringify(file)).toBe(fileBytes); expect(JSON.stringify(geometry)).toBe(geometryBytes)
    }
  })

  it('PAPER-FLEX-003 maps an invalid captured sizing snapshot to sizing without mutating inputs', () => {
    const { file, geometry } = frameFixture()
    const captured = layoutMeasure.paperRemoveFlexGeometry(file, geometry, 'parent', 5)!
    const invalid = structuredClone(captured)
    invalid.flowChildren[0]!.snapshot.measured.width = -1
    const spy = vi.spyOn(layoutMeasure, 'paperRemoveFlexGeometry').mockReturnValue(invalid)
    const fileBytes = JSON.stringify(file), geometryBytes = JSON.stringify(geometry)
    expect(planPaperRemoveFlex({ file, geometry, selection: ['parent'], layoutGeneration: 5 })).toStrictEqual({ status: 'unavailable', reason: 'sizing', message: paperRemoveFlexCopy.sizing })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(file)).toBe(fileBytes); expect(JSON.stringify(geometry)).toBe(geometryBytes)
    spy.mockRestore()
  })
})
