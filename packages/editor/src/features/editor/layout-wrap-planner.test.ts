import { describe, expect, it, vi } from 'vitest'
import { applyFileCommand, childrenOf, validateFileDocument } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument, PrimitiveNode, TextSizing, TextStyle } from '@canvas/repo-engine/file-document'
import type { NodeLayout } from '@canvas/repo-engine/layout'
import type { Matrix } from '@canvas/repo-engine/layout-matrix'
import * as layoutMeasure from './layout-measure'
import type { LayoutGeometry } from './layout-measure'
import { planPaperWrap } from './layout-wrap-planner'

const px = (value: number) => ({ kind: 'px' as const, value })
const root = { id: 'root', type: 'root' as const }
const frame = (id: string, left = 0, top = 0, width = 400, height = 300): PrimitiveNode & { type: 'frame' } => ({ id, type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, left, top], width, height, overflow: 'visible' } })
const rect = (id: string, left: number, top: number, width: number, height: number, mode: 'freeform' | 'absolute' | 'flow' = 'freeform'): PrimitiveNode => ({
  id, type: 'rectangle', name: id, styles: { relativeTransform: [1, 0, 0, 1, left, top], width, height },
  ...(mode === 'freeform' ? {} : { layout: { item: { position: mode === 'absolute' ? { mode, left: px(left), right: { kind: 'percent', value: 12 }, top: px(top), bottom: px(7), zIndex: 4 } : { mode } } } }),
})
const textStyle = (): TextStyle => ({
  fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize: 16,
  lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0,
  horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false,
})
const textNode = (id: string, left: number, top: number, width: number, height: number, textSizing: TextSizing, layout?: NodeLayout): PrimitiveNode => ({
  id, type: 'text', name: id, styles: { relativeTransform: [1, 0, 0, 1, left, top], width, height }, text: id,
  textStyle: textStyle(), textSizing,
  ...(layout ? { layout } : {}),
})
const file = (nodes: FileDocument['nodes'], relationships: FileDocument['relationships'], revision = 4): FileDocument => ({ schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'wrap-file', revision, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }], nodes: { root, ...nodes }, relationships, theme: { tokens: {} } })
const validFile = (nodes: FileDocument['nodes'], relationships: FileDocument['relationships'], rootId: string): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: '00000000-0000-4000-8000-000000000001',
  revision: 4,
  pages: [{ id: '00000000-0000-4000-8000-000000000002', name: 'Page', rootNodeId: rootId }],
  nodes: { [rootId]: { id: rootId, type: 'root' }, ...nodes },
  relationships,
  theme: { tokens: {} },
})
const measured = (node: PrimitiveNode, parentId: string | null, revision = 4, generation = 2, extra: Record<string, unknown> = {}) => ({
  canvasKind: node.type,
  documentRevision: revision,
  layoutGeneration: generation,
  rect: { x: node.styles.relativeTransform[4], y: node.styles.relativeTransform[5], width: node.styles.width, height: node.styles.height },
  worldAabb: { x: node.styles.relativeTransform[4], y: node.styles.relativeTransform[5], width: node.styles.width, height: node.styles.height },
  offset: { x: node.styles.relativeTransform[4], y: node.styles.relativeTransform[5], width: node.styles.width, height: node.styles.height, origin: { x: node.styles.width / 2, y: node.styles.height / 2 } },
  offsetParentNodeId: parentId,
  ...(parentId === null ? { offsetParentToRoot: [1, 0, 0, 1, 0, 0] as Matrix } : {}),
  directChild: true,
  ...extra,
})
const geometry = (source: FileDocument, generation = 2): LayoutGeometry => ({
  documentRevision: source.revision,
  layoutGeneration: generation,
  unsupported: {},
  nodes: Object.fromEntries(Object.values(source.nodes).flatMap(node => {
    if (node.type === 'root' || node.type === 'component') return []
    const parent = source.relationships[node.id]?.parentId
    return [[node.id, measured(node, source.nodes[parent!]?.type === 'root' ? null : parent!, source.revision, generation)]]
  })),
})
const setMeasuredSize = (value: LayoutGeometry, nodeId: string, width: number, height: number) => {
  const node = value.nodes[nodeId]!
  node.rect = { ...node.rect, width, height }
  node.worldAabb = { ...node.worldAabb!, width, height }
  node.offset = { ...node.offset!, width, height, origin: { x: width / 2, y: height / 2 } }
}
const ids = (...values: string[]) => { const queue = [...values]; return () => queue.shift() ?? 'exhausted' }
const ready = (source: FileDocument, selected: string[], measuredGeometry = geometry(source), makeId = ids('wrap')) => {
  const result = planPaperWrap({ file: source, geometry: measuredGeometry, selection: selected, layoutGeneration: 2, makeId })
  if (result.status !== 'ready') throw new Error(result.message)
  expect(result.status).toBe('ready')
  return result
}

describe('Paper Wrap planner', () => {
  it('WRAP-01 deduplicates selection, analyzes selected siblings only, and uses spatial order', () => {
    const a = rect('a', 100, 0, 10, 10), b = rect('b', 0, 0, 10, 10), c = rect('c', 50, 0, 10, 10), ignored = rect('ignored', 500, 0, 10, 10)
    const source = file({ a, b, c, ignored }, { a: { parentId: 'root', orderKey: 'V' }, b: { parentId: 'root', orderKey: 'W' }, c: { parentId: 'root', orderKey: 'X' }, ignored: { parentId: 'root', orderKey: 'Y' } })
    const before = structuredClone(source)
    const result = ready(source, ['c', 'b', 'a', 'b'])
    expect(result.command).toStrictEqual({
      type: 'node.wrap',
      groups: [{
        parentId: 'root',
        wrapper: {
          id: 'wrap', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 110, height: 10, overflow: 'visible' },
          layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', gap: 40, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } },
        },
        children: [
          { nodeId: 'b', targetLayout: { item: { position: { mode: 'flow' } } } },
          { nodeId: 'c', targetLayout: { item: { position: { mode: 'flow' } } } },
          { nodeId: 'a', targetLayout: { item: { position: { mode: 'flow' } } } },
        ],
      }],
    })
    expect(source).toStrictEqual(before)
  })

  it('PAPER-FLEX-003 keeps fixed primitive geometry unchanged while moving the child into flow', () => {
    const box = rect('box', 12, 18, 64, 32)
    const source = file({ box }, { box: { parentId: 'root', orderKey: 'V' } })
    const sourceBytes = JSON.stringify(source)
    const geometryInput = geometry(source)
    const geometryBytes = JSON.stringify(geometryInput)

    expect(ready(source, ['box'], geometryInput).command.groups[0]!.children).toStrictEqual([{
      nodeId: 'box',
      targetLayout: { item: { position: { mode: 'flow' } } },
    }])
    expect(JSON.stringify(source)).toBe(sourceBytes)
    expect(JSON.stringify(geometryInput)).toBe(geometryBytes)
  })

  it('PAPER-FLEX-002/003 bakes absolute Fill, Relative, and Constrained widths to measured fixed geometry', () => {
    const fill = rect('fill', 0, 0, 40, 20, 'absolute')
    fill.layout!.item.width = { value: { kind: 'percent', value: 100 } }
    const relative = rect('relative', 150, 0, 50, 20, 'absolute')
    relative.layout!.item.width = { value: { kind: 'percent', value: 40 } }
    const constrained = rect('constrained', 260, 0, 60, 20, 'absolute')
    constrained.layout!.item.position = { mode: 'absolute', left: px(260), right: px(10), top: px(0), bottom: px(7), zIndex: 4 }
    const source = validateFileDocument(file(
      { fill, relative, constrained },
      { fill: { parentId: 'root', orderKey: 'V' }, relative: { parentId: 'root', orderKey: 'W' }, constrained: { parentId: 'root', orderKey: 'X' } },
    ), [])
    const geometryInput = geometry(source)
    setMeasuredSize(geometryInput, 'fill', 137, 20)
    setMeasuredSize(geometryInput, 'relative', 96, 20)
    setMeasuredSize(geometryInput, 'constrained', 88, 20)
    const sourceBytes = JSON.stringify(source)
    const geometryBytes = JSON.stringify(geometryInput)
    const result = ready(source, ['fill', 'relative', 'constrained'], geometryInput)

    expect(result.command.groups[0]!.children).toStrictEqual([
      { nodeId: 'fill', targetLayout: { item: { position: { mode: 'flow' } } }, targetPrimitiveSize: { width: 137, height: 20 } },
      { nodeId: 'relative', targetLayout: { item: { position: { mode: 'flow' } } }, targetPrimitiveSize: { width: 96, height: 20 } },
      { nodeId: 'constrained', targetLayout: { item: { position: { mode: 'flow' } } }, targetPrimitiveSize: { width: 88, height: 20 } },
    ])
    const final = applyFileCommand(source, result.command, [])
    expect(validateFileDocument(final, [])).toStrictEqual(final)
    expect((final.nodes.fill as PrimitiveNode).styles).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 0, 0], width: 137, height: 20 })
    expect((final.nodes.relative as PrimitiveNode).styles).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 150, 0], width: 96, height: 20 })
    expect((final.nodes.constrained as PrimitiveNode).styles).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 260, 0], width: 88, height: 20 })
    expect(JSON.stringify(source)).toBe(sourceBytes)
    expect(JSON.stringify(geometryInput)).toBe(geometryBytes)
  })

  it('PAPER-FLEX-003 uses the strict multiline threshold and emits both text fields for row-Flex multiline text', () => {
    const fixedHeight = { mode: 'fixed' as const }
    const exact = textNode('exact', 0, 0, 100, 30, { width: { mode: 'fit' }, height: fixedHeight })
    const over = textNode('over', 140, 0, 100, 30.002, { width: { mode: 'fit' }, height: fixedHeight })
    const source = validateFileDocument(file(
      { exact, over },
      { exact: { parentId: 'root', orderKey: 'V' }, over: { parentId: 'root', orderKey: 'W' } },
    ), [])
    const geometryInput = geometry(source)
    geometryInput.nodes.exact!.text = { resolvedLineHeight: 20 }
    geometryInput.nodes.over!.text = { resolvedLineHeight: 20 }
    setMeasuredSize(geometryInput, 'over', 110, 30.002)
    const result = ready(source, ['exact', 'over'], geometryInput)

    expect(result.command.groups[0]!.wrapper.layout!.container!.flex!.direction).toBe('row')
    expect(result.command.groups[0]!.children).toStrictEqual([
      { nodeId: 'exact', targetLayout: { item: { position: { mode: 'flow' } } } },
      {
        nodeId: 'over', targetLayout: { item: { position: { mode: 'flow' } } },
        targetPrimitiveSize: { width: 110, height: 30.002 },
        targetTextProperties: { textStyle: textStyle(), textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } } },
      },
    ])
    const final = applyFileCommand(source, result.command, [])
    expect(validateFileDocument(final, [])).toStrictEqual(final)
    expect((final.nodes.over as PrimitiveNode).styles).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 140, 0], width: 110, height: 30.002 })
  })

  it('PAPER-FLEX-003 gives multiline text Fill width in a column Flex target', () => {
    const copy = textNode('copy', 0, 0, 100, 40, { width: { mode: 'fit' }, height: { mode: 'fixed' } })
    const box = rect('box', 0, 80, 100, 20)
    const source = validateFileDocument(file(
      { copy, box },
      { copy: { parentId: 'root', orderKey: 'V' }, box: { parentId: 'root', orderKey: 'W' } },
    ), [])
    const geometryInput = geometry(source)
    geometryInput.nodes.copy!.text = { resolvedLineHeight: 20 }
    const result = ready(source, ['copy', 'box'], geometryInput)

    expect(result.command.groups[0]!.wrapper.layout!.container!.flex!.direction).toBe('column')
    expect(result.command.groups[0]!.children[0]).toStrictEqual({
      nodeId: 'copy', targetLayout: { item: { position: { mode: 'flow' } } },
      targetTextProperties: { textStyle: textStyle(), textSizing: { width: { mode: 'fill' }, height: { mode: 'fixed' } } },
    })
    const final = applyFileCommand(source, result.command, [])
    expect(validateFileDocument(final, [])).toStrictEqual(final)
  })

  it('PAPER-FLEX-003 converts editable dependent text height to Fit', () => {
    const parent = frame('parent')
    const copy = textNode('copy', 0, 0, 100, 40, { width: { mode: 'fixed' }, height: { mode: 'fill' } })
    const source = validateFileDocument(file(
      { parent, copy },
      { parent: { parentId: 'root', orderKey: 'V' }, copy: { parentId: 'parent', orderKey: 'V' } },
    ), [])
    const geometryInput = geometry(source)
    geometryInput.nodes.copy!.text = { resolvedLineHeight: 20 }
    const result = ready(source, ['copy'], geometryInput)

    expect(result.command.groups[0]!.children).toStrictEqual([{
      nodeId: 'copy', targetLayout: { item: { position: { mode: 'flow' } } },
      targetTextProperties: { textStyle: textStyle(), textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } } },
    }])
    const final = applyFileCommand(source, result.command, [])
    expect(validateFileDocument(final, [])).toStrictEqual(final)
  })

  it('WRAP-05 preserves the average child centroid rather than the union center', () => {
    const a = rect('a', 0, 0, 10, 10), b = rect('b', 100, 0, 10, 10), c = rect('c', 200, 0, 10, 10)
    const source = file({ a, b, c }, { a: { parentId: 'root', orderKey: 'V' }, b: { parentId: 'root', orderKey: 'W' }, c: { parentId: 'root', orderKey: 'X' } })
    const measuredGeometry = geometry(source)
    measuredGeometry.nodes.c!.worldAabb = { x: 500, y: 0, width: 10, height: 10 }
    const group = ready(source, ['a', 'b', 'c'], measuredGeometry).command.groups[0]!
    // Source centers average to 205. Synthetic centers average to 105. A union-center placement would be 150.
    expect(group.wrapper.styles.relativeTransform[4]).toBe(100)
    expect(group.wrapper.styles.relativeTransform[5]).toBe(0)
    expect(group.wrapper.styles.width).toBe(210)
  })

  it('WRAP-06 keeps source tree order when authored main-axis positions tie', () => {
    const first = rect('first', 20, 0, 30, 10), second = rect('second', 20, 0, 30, 10)
    const source = file({ first, second }, { first: { parentId: 'root', orderKey: 'V' }, second: { parentId: 'root', orderKey: 'W' } })
    expect(ready(source, ['second', 'first']).command.groups[0]!.children.map(child => child.nodeId)).toStrictEqual(['first', 'second'])
  })

  it('WRAP-07 orders parent groups by their first member and allocates one deterministic identity per group', () => {
    const left = frame('left'), right = frame('right', 500)
    const la = rect('la', 0, 0, 20, 10), lb = rect('lb', 30, 0, 20, 10), ra = rect('ra', 0, 0, 20, 10), rb = rect('rb', 30, 0, 20, 10)
    const source = file({ left, right, la, lb, ra, rb }, {
      left: { parentId: 'root', orderKey: 'V' }, la: { parentId: 'left', orderKey: 'V' }, lb: { parentId: 'left', orderKey: 'W' },
      right: { parentId: 'root', orderKey: 'W' }, ra: { parentId: 'right', orderKey: 'V' }, rb: { parentId: 'right', orderKey: 'W' },
    })
    const result = ready(source, ['rb', 'ra', 'lb', 'la'], geometry(source), ids('left-wrap', 'right-wrap'))
    expect(result.wrapperIds).toStrictEqual(['left-wrap', 'right-wrap'])
    expect(result.command.groups.map(group => [group.parentId, group.wrapper.id])).toStrictEqual([['left', 'left-wrap'], ['right', 'right-wrap']])
  })

  it('WRAP-08 transforms the centroid origin through a verified parent padding matrix', () => {
    const parent = frame('parent', 100, 50), a = rect('a', 0, 0, 10, 10), b = rect('b', 20, 0, 10, 10)
    const source = validateFileDocument(file({ parent, a, b }, { parent: { parentId: 'root', orderKey: 'V' }, a: { parentId: 'parent', orderKey: 'V' }, b: { parentId: 'parent', orderKey: 'W' } }), [])
    const measuredGeometry = geometry(source)
    measuredGeometry.nodes.parent = measured(parent, null, 4, 2, {
      offset: { x: 100, y: 50, width: 400, height: 300, origin: { x: 0, y: 0 } },
      transform: [0, 1, -1, 0, 0, 0],
      box: { border: { top: 7, right: 3, bottom: 5, left: 11 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    })
    measuredGeometry.nodes.a!.worldAabb = { x: 83, y: 61, width: 10, height: 10 }
    measuredGeometry.nodes.b!.worldAabb = { x: 83, y: 81, width: 10, height: 10 }
    const wrapper = ready(source, ['a', 'b'], measuredGeometry).command.groups[0]!.wrapper
    // World centroid is (88,76). Subtracting the synthetic centroid (5,10) gives (83,66).
    // The inverse padding-box matrix includes the rotated 11px left and 7px top border, yielding (5,10), not (16,17).
    expect(wrapper.styles).toStrictEqual({ relativeTransform: [1, 0, 0, 1, 5, 10], width: 10, height: 20, overflow: 'visible' })

    const missing = structuredClone(measuredGeometry); delete missing.nodes.parent
    expect(planPaperWrap({ file: source, geometry: missing, selection: ['a', 'b'], layoutGeneration: 2, makeId: ids('unused') })).toMatchObject({ status: 'unavailable', reason: 'geometry' })
    const singular = structuredClone(measuredGeometry); singular.nodes.parent!.transform = [0, 0, 0, 0, 0, 0]
    expect(planPaperWrap({ file: source, geometry: singular, selection: ['a', 'b'], layoutGeneration: 2, makeId: ids('unused') })).toMatchObject({ status: 'unavailable', reason: 'geometry' })
  })

  it('WRAP-09 rejects stale, missing, indirect, mixed-host, and incomplete geometry without allocating identities', () => {
    const a = rect('a', 0, 0, 10, 10), b = rect('b', 20, 0, 10, 10)
    const source = file({ a, b }, { a: { parentId: 'root', orderKey: 'V' }, b: { parentId: 'root', orderKey: 'W' } })
    const mutations: ((value: LayoutGeometry) => void)[] = [
      value => { value.documentRevision = 3 },
      value => { value.layoutGeneration = null },
      value => { delete value.nodes.a },
      value => { value.nodes.a!.directChild = false },
      value => { value.nodes.a!.layoutGeneration = 1 },
      value => { value.nodes.b!.offsetParentToRoot = [1, 0, 0, 1, 1, 0] },
      value => { delete value.nodes.a!.offsetParentNodeId },
    ]
    for (const mutate of mutations) {
      const candidate = geometry(source)
      mutate(candidate)
      let allocations = 0
      const result = planPaperWrap({ file: source, geometry: candidate, selection: ['a', 'b'], layoutGeneration: 2, makeId: () => { allocations++; return 'unused' } })
      expect(result).toMatchObject({ status: 'unavailable', reason: 'geometry' })
      expect(allocations).toBe(0)
    }
  })

  it('PAPER-FLEX-003 rejects an incomplete sizing capture before allocating a wrapper identity', () => {
    const box = rect('box', 0, 0, 20, 10)
    const source = file({ box }, { box: { parentId: 'root', orderKey: 'V' } })
    const geometryInput = geometry(source)
    const sourceBytes = JSON.stringify(source)
    const geometryBytes = JSON.stringify(geometryInput)
    const captured = layoutMeasure.paperWrapGeometry(source, geometryInput, 'root', ['box'], 2)
    if (!captured) throw new Error('Expected the sizing fixture to capture')
    const captureSpy = vi.spyOn(layoutMeasure, 'paperWrapGeometry').mockReturnValue({ ...captured, childSnapshots: {} })
    let allocations = 0
    try {
      expect(planPaperWrap({
        file: source,
        geometry: geometryInput,
        selection: ['box'],
        layoutGeneration: 2,
        makeId: () => { allocations++; return 'unused' },
      })).toStrictEqual({
        status: 'unavailable',
        reason: 'sizing',
        message: 'Wrap needs complete current sizing information. Wait for the canvas to finish updating, then try again.',
      })
      expect(allocations).toBe(0)
      expect(JSON.stringify(source)).toBe(sourceBytes)
      expect(JSON.stringify(geometryInput)).toBe(geometryBytes)
    } finally {
      captureSpy.mockRestore()
    }
  })

  it('PAPER-FLEX-003 prevalidates every parent sizing group before allocating identities or mutating inputs', () => {
    const left = frame('left', 0)
    const right = frame('right', 500)
    const leftChild = rect('left-child', 10, 20, 20, 10)
    const rightChild = rect('right-child', 10, 20, 20, 10)
    const source = validateFileDocument(file(
      { left, right, 'left-child': leftChild, 'right-child': rightChild },
      {
        left: { parentId: 'root', orderKey: 'V' },
        'left-child': { parentId: 'left', orderKey: 'V' },
        right: { parentId: 'root', orderKey: 'W' },
        'right-child': { parentId: 'right', orderKey: 'V' },
      },
    ), [])
    const geometryInput = geometry(source)
    const sourceBefore = structuredClone(source)
    const geometryBefore = structuredClone(geometryInput)
    const sourceBytes = JSON.stringify(source)
    const geometryBytes = JSON.stringify(geometryInput)
    const capture = layoutMeasure.paperWrapGeometry
    const captureSpy = vi.spyOn(layoutMeasure, 'paperWrapGeometry').mockImplementation((fileValue, geometryValue, parentId, selectedIds, generation) => {
      const result = capture(fileValue, geometryValue, parentId, selectedIds, generation)
      return parentId === 'right' && result ? { ...result, childSnapshots: {} } : result
    })
    let allocations = 0
    try {
      expect(planPaperWrap({
        file: source,
        geometry: geometryInput,
        selection: ['left-child', 'right-child'],
        layoutGeneration: 2,
        makeId: () => { allocations++; return `unused-${allocations}` },
      })).toStrictEqual({
        status: 'unavailable',
        reason: 'sizing',
        message: 'Wrap needs complete current sizing information. Wait for the canvas to finish updating, then try again.',
      })
      expect(allocations).toBe(0)
      expect(source).toStrictEqual(sourceBefore)
      expect(geometryInput).toStrictEqual(geometryBefore)
      expect(JSON.stringify(source)).toBe(sourceBytes)
      expect(JSON.stringify(geometryInput)).toBe(geometryBytes)
    } finally {
      captureSpy.mockRestore()
    }
  })

  it('PAPER-FLEX-003 fails closed when a captured sizing snapshot cannot be reconciled', () => {
    const box = rect('box', 0, 0, 20, 10)
    const source = file({ box }, { box: { parentId: 'root', orderKey: 'V' } })
    const geometryInput = geometry(source)
    const captured = layoutMeasure.paperWrapGeometry(source, geometryInput, 'root', ['box'], 2)
    if (!captured) throw new Error('Expected the sizing fixture to capture')
    const invalid = structuredClone(captured.childSnapshots.box!)
    invalid.measured.width = -1
    invalid.axes.width.measured = -1
    const captureSpy = vi.spyOn(layoutMeasure, 'paperWrapGeometry').mockReturnValue({ ...captured, childSnapshots: { box: invalid } })
    let allocations = 0
    try {
      expect(planPaperWrap({
        file: source,
        geometry: geometryInput,
        selection: ['box'],
        layoutGeneration: 2,
        makeId: () => { allocations++; return 'unused' },
      })).toMatchObject({ status: 'unavailable', reason: 'sizing' })
      expect(allocations).toBe(0)
    } finally {
      captureSpy.mockRestore()
    }
  })

  it('WRAP-10 rejects roots, missing nodes, components, slots, invalid parents, and nested selection atomically', () => {
    const parent = frame('parent'), child = rect('child', 0, 0, 10, 10), nested = rect('nested', 0, 0, 5, 5), loose = rect('loose', 30, 0, 10, 10)
    const component = { id: 'component', type: 'component' as const, componentId: 'card', exportName: 'Card', props: {} }
    const source = file({ parent, child, nested, loose, component }, {
      parent: { parentId: 'root', orderKey: 'V' }, child: { parentId: 'parent', orderKey: 'V' }, nested: { parentId: 'child', orderKey: 'V' }, loose: { parentId: 'root', orderKey: 'W', slot: 'children' }, component: { parentId: 'root', orderKey: 'X' },
    })
    const before = structuredClone(source)
    const cases = [
      { selection: [] as string[], reason: 'empty' }, { selection: ['missing'], reason: 'missing' }, { selection: ['root'], reason: 'root' },
      { selection: ['component'], reason: 'topology' }, { selection: ['loose'], reason: 'topology' }, { selection: ['child', 'nested'], reason: 'nested' }, { selection: ['nested'], reason: 'topology' },
    ]
    for (const candidate of cases) expect(planPaperWrap({ file: source, geometry: geometry(source), selection: candidate.selection, layoutGeneration: 2, makeId: ids('unused') })).toMatchObject({ status: 'unavailable', reason: candidate.reason })
    expect(source).toStrictEqual(before)
  })

  it('uses absolute, freeform, and flow wrapper placement and canonical inactive flow coordinates', () => {
    const freeParent = frame('free-parent'), flowParent = { ...frame('flow-parent'), layout: { item: { position: { mode: 'freeform' as const } }, container: { display: 'flex' as const, flex: { direction: 'row' as const, wrap: 'nowrap' as const, justify: 'start' as const, align: 'start' as const } } } }
    const absolute = rect('absolute', 12, 18, 20, 10, 'absolute'), free = rect('free', 40, 20, 20, 10), flow = rect('flow', 0, 0, 20, 10, 'flow')
    const source = file({ 'free-parent': freeParent, 'flow-parent': flowParent, absolute, free, flow }, {
      'free-parent': { parentId: 'root', orderKey: 'V' }, absolute: { parentId: 'free-parent', orderKey: 'V' }, free: { parentId: 'free-parent', orderKey: 'W' },
      'flow-parent': { parentId: 'root', orderKey: 'W' }, flow: { parentId: 'flow-parent', orderKey: 'V' },
    })
    expect(childrenOf(source, 'root')).toStrictEqual(['free-parent', 'flow-parent'])
    expect(childrenOf(source, 'free-parent')).toStrictEqual(['absolute', 'free'])
    expect(ready(source, ['absolute']).command.groups[0]!.wrapper.layout!.item.position).toStrictEqual({ mode: 'absolute', left: px(12), top: px(18) })
    expect(ready(source, ['absolute', 'free']).command.groups[0]!.wrapper.layout!.item.position).toStrictEqual({ mode: 'freeform' })
    const flowWrapper = ready(source, ['flow']).command.groups[0]!.wrapper
    expect(flowWrapper.layout!.item.position).toStrictEqual({ mode: 'flow' })
    expect({ left: flowWrapper.styles.relativeTransform[4], top: flowWrapper.styles.relativeTransform[5] }).toStrictEqual({ left: 0, top: 0 })
  })

  it('preserves compatible flex-child sizing, flex item data, child container, and spacing through node.wrap', () => {
    const rootId = '00000000-0000-4000-8000-000000000010'
    const parentId = '00000000-0000-4000-8000-000000000011'
    const childId = '00000000-0000-4000-8000-000000000012'
    const wrapperId = '00000000-0000-4000-8000-000000000013'
    const parent = frame(parentId)
    parent.layout = {
      item: { position: { mode: 'freeform' } },
      container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' }, gap: 9 },
    }
    const child = frame(childId, 10, 20, 80, 60)
    child.layout = {
      item: {
        position: { mode: 'flow' },
        width: { value: { kind: 'percent', value: 50 } },
        height: { value: { kind: 'auto' } },
        flex: { grow: 2, shrink: 0, basis: { kind: 'percent', value: 25 } },
      },
      container: { display: 'block' },
      spacing: { padding: { x: 6, y: 8 }, margin: { top: 1, right: 2, bottom: 3, left: 4 } },
    }
    const source = validateFileDocument(validFile({ [parentId]: parent, [childId]: child }, {
      [parentId]: { parentId: rootId, orderKey: 'V' }, [childId]: { parentId, orderKey: 'V' },
    }, rootId), [])
    const result = ready(source, [childId], geometry(source), ids(wrapperId))
    const expectedLayout: NodeLayout = {
      item: {
        position: { mode: 'flow' },
        width: { value: { kind: 'percent', value: 50 } },
        height: { value: { kind: 'auto' } },
        flex: { grow: 2, shrink: 0, basis: { kind: 'percent', value: 25 } },
      },
      container: { display: 'block' },
      spacing: { padding: { x: 6, y: 8 }, margin: { top: 1, right: 2, bottom: 3, left: 4 } },
    }
    expect(result.command.groups[0]!.children[0]!.targetLayout).toStrictEqual(expectedLayout)
    const final = applyFileCommand(source, result.command, [])
    expect(validateFileDocument(final, [])).toStrictEqual(final)
    expect((final.nodes[childId] as PrimitiveNode).layout).toStrictEqual(expectedLayout)
  })

  it('clears Grid item placement before reparenting a valid grid child under the flex wrapper', () => {
    const rootId = '00000000-0000-4000-8000-000000000020'
    const parentId = '00000000-0000-4000-8000-000000000021'
    const childId = '00000000-0000-4000-8000-000000000022'
    const wrapperId = '00000000-0000-4000-8000-000000000023'
    const parent = frame(parentId)
    parent.layout = {
      item: { position: { mode: 'freeform' } },
      container: { display: 'grid', grid: { columns: [{ kind: 'fr', value: 1 }], rows: [{ kind: 'auto' }], autoFlow: 'row' } },
    }
    const child = rect(childId, 10, 20, 80, 60, 'flow')
    child.layout = {
      item: {
        position: { mode: 'flow' },
        width: { value: { kind: 'percent', value: 75 } },
        grid: { columnStart: 1, rowStart: 1, columnSpan: 1, rowSpan: 1, justifySelf: 'end', alignSelf: 'center' },
      },
    }
    const source = validateFileDocument(validFile({ [parentId]: parent, [childId]: child }, {
      [parentId]: { parentId: rootId, orderKey: 'V' }, [childId]: { parentId, orderKey: 'V' },
    }, rootId), [])
    const result = ready(source, [childId], geometry(source), ids(wrapperId))
    const expectedLayout: NodeLayout = {
      item: { position: { mode: 'flow' }, width: { value: { kind: 'percent', value: 75 } } },
    }
    expect(result.command.groups[0]!.children[0]!.targetLayout).toStrictEqual(expectedLayout)
    const final = applyFileCommand(source, result.command, [])
    expect(validateFileDocument(final, [])).toStrictEqual(final)
    expect((final.nodes[childId] as PrimitiveNode).layout).toStrictEqual(expectedLayout)

    const retainedGrid = structuredClone(result.command) as Extract<FileCommand, { type: 'node.wrap' }>
    retainedGrid.groups[0]!.children[0]!.targetLayout = child.layout!
    expect(() => applyFileCommand(source, retainedGrid, [])).toThrow('Grid item properties need a grid parent')

    const retainedAbsoluteData = structuredClone(result.command) as Extract<FileCommand, { type: 'node.wrap' }>
    retainedAbsoluteData.groups[0]!.children[0]!.targetLayout = {
      item: { position: { mode: 'flow', left: px(10), zIndex: 3 } },
    } as unknown as NodeLayout
    expect(() => applyFileCommand(source, retainedAbsoluteData, [])).toThrow('Invalid Wrap group')
  })

  it('rejects duplicate generated identities after all semantic validation without mutating the file', () => {
    const a = rect('a', 0, 0, 10, 10)
    const source = file({ a }, { a: { parentId: 'root', orderKey: 'V' } })
    const before = structuredClone(source)
    expect(planPaperWrap({ file: source, geometry: geometry(source), selection: ['a'], layoutGeneration: 2, makeId: ids('a') })).toMatchObject({ status: 'unavailable', reason: 'identity' })
    expect(source).toStrictEqual(before)
  })
})
