import { describe, expect, it, vi } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory } from '@canvas/repo-engine/file-document'
import type { FileDocument, PrimitiveNode } from '@canvas/repo-engine/file-document'
import type { Atom } from '@canvas/repo-engine/contracts'
import type { GestureAuthorityDocumentState, GestureAuthoritySnapshot, ResizeGeometryAuthority } from './gesture-authority'
import { captureGestureAuthority } from './gesture-authority'
import { planGestureCommand } from './gesture-command-planner'
import type { GestureFinalIntent } from './gesture-command-planner'
import { resizeGeometryAuthority } from './layout-measure'
import type { ResizeProjectionSample } from './resize-projection'
import type { MeasuredNode, SceneGeometry } from './scene-geometry'

const revision = 9, layoutGeneration = 14, measurementRevision = 22
const zeroBox = { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } }
const flowers = { id: 'flowers', name: 'flowers.webp', mime: 'image/webp' as const, extension: 'webp' as const, width: 1600, height: 1200, bytes: 8, sha256: 'a'.repeat(64) }
const textStyle = {
  fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize: 18, lineHeight: { kind: 'unitless', value: 1.4 }, letterSpacing: 0,
  horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false, maxLines: 3,
} as const

function rectangle(id = 'selected', left = 0, top = 0, width = 100, height = 50): PrimitiveNode {
  return { id, type: 'rectangle', name: id, styles: { left, top, width, height }, layout: { item: { position: { mode: 'freeform' } } } }
}

function fileWith(node: PrimitiveNode = rectangle()): FileDocument {
  return {
    schemaVersion: 9, fileId: 'resize-plan-file', revision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: { root: { id: 'root', type: 'root' }, [node.id]: node },
    relationships: { [node.id]: { parentId: 'root', orderKey: 'A7' } },
    assets: { flowers }, theme: { tokens: {} },
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
    canvasKind: kind, documentRevision: revision, layoutGeneration, rect, worldAabb,
    offset: { ...offset, origin: { x: offset.width / 2, y: offset.height / 2 } },
    offsetParentNodeId: parentId, directChild: true, transform: [1, 0, 0, 1, 0, 0], box: structuredClone(zeroBox),
  }
}

function geometry(selected: MeasuredNode): SceneGeometry {
  return { revision: measurementRevision, documentRevision: revision, layoutGeneration, nodes: { selected }, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 }
}

function snapshot(source: FileDocument, measuredGeometry: SceneGeometry, selected = 'selected', atoms: Atom[] = []): GestureAuthoritySnapshot {
  const state: GestureAuthorityDocumentState = {
    file: source, pageId: 'page', atoms, layoutGeneration, viewport: { x: 0, y: 0, zoom: 1 }, viewportSize: { width: 800, height: 600 }, selection: [selected],
  }
  const captured = captureGestureAuthority(() => state, () => measuredGeometry)
  if (!captured) throw new Error('Fixture did not capture gesture authority.')
  return captured
}

function authority(captured: GestureAuthoritySnapshot, nodeId = 'selected'): ResizeGeometryAuthority {
  const result = resizeGeometryAuthority(captured, nodeId)
  if (!result) throw new Error('Fixture did not derive resize authority.')
  return result
}

function sample(rect: { x: number; y: number; width: number; height: number }, axes: readonly ('x' | 'y')[] = ['x', 'y'], contentLocked = false): ResizeProjectionSample {
  return { coordinateSpace: 'parent-padding', rect, contentLocked, affectedAxes: axes, effectiveHandle: axes.length === 1 && axes[0] === 'x' ? 'right' : axes.length === 1 ? 'bottom' : 'bottom-right' }
}

function intent(captured: GestureAuthoritySnapshot, terminal: ResizeProjectionSample, supplied = authority(captured)): GestureFinalIntent {
  return { kind: 'resize', nodeId: supplied.nodeId, authority: supplied, sample: terminal }
}

function withoutRevision(source: FileDocument): FileDocument {
  return { ...structuredClone(source), revision: 0 }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

describe('AT-DOC-003, PAPER-FLEX-006, and PAPER-TEXT-006 resize planner prerequisites', () => {
  it('AT-DOC-003 emits one direct checked leaf for a freeform frame and closes exact history', () => {
    const frame: PrimitiveNode = {
      id: 'selected', type: 'frame', name: 'Frame', styles: { left: 10, top: 20, width: 100, height: 80, rotation: 0, overflow: 'visible' },
      layout: { item: { position: { mode: 'freeform' } }, container: { display: 'block' }, spacing: { padding: 8 } },
    }
    const source = fileWith(frame)
    const selected = measured('frame', { x: 10, y: 20, width: 100, height: 80 }, { x: 10, y: 20, width: 100, height: 80 }, null)
    selected.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    const captured = snapshot(source, geometry(selected))
    const resizeAuthority = authority(captured)
    const terminal = sample({ x: -5, y: 12, width: 140, height: 96 })
    const allocate = vi.fn(() => 'never')
    const before = { file: structuredClone(source), snapshot: JSON.stringify(captured), authority: JSON.stringify(resizeAuthority), sample: JSON.stringify(terminal) }
    const plan = planGestureCommand(captured, [intent(captured, terminal, resizeAuthority)], allocate)

    expect(plan).toStrictEqual({
      command: {
        type: 'node.resizePresentation', entries: [{
          expected: {
            nodeId: 'selected', relationship: { parentId: 'root', orderKey: 'A7' },
            primitiveGeometry: { left: 10, top: 20, width: 100, height: 80 }, layout: frame.layout,
          },
          source: {
            nodeId: 'selected', relationship: { parentId: 'root', orderKey: 'A7' },
            primitiveGeometry: { left: -5, top: 12, width: 140, height: 96 }, layout: frame.layout,
          },
        }],
      },
      selection: ['selected'], duplicateIds: {},
    })
    expect(allocate).not.toHaveBeenCalled()
    expect(source).toStrictEqual(before.file)
    expect(JSON.stringify(captured)).toBe(before.snapshot)
    expect(JSON.stringify(resizeAuthority)).toBe(before.authority)
    expect(JSON.stringify(terminal)).toBe(before.sample)

    const history = applyFileCommandWithHistory(source, plan!.command, [])
    expect(history.undo.type).toBe('node.resizePresentation')
    expect(history.redo).toStrictEqual(plan!.command)
    const undone = applyFileCommand(history.file, history.undo, [])
    expect(withoutRevision(undone)).toStrictEqual(withoutRevision(source))
    expect(withoutRevision(applyFileCommand(undone, history.redo, []))).toStrictEqual(withoutRevision(history.file))
    expect(history.file.nodes.selected).toMatchObject({ styles: { left: -5, top: 12, width: 140, height: 96, rotation: 0, overflow: 'visible' }, layout: frame.layout })

    const drifts: FileDocument[] = [
      {
        ...structuredClone(source),
        nodes: {
          ...structuredClone(source.nodes),
          selected: {
            ...structuredClone(frame),
            layout: {
              item: { position: { mode: 'absolute', left: { kind: 'px', value: 10 }, top: { kind: 'px', value: 20 } } },
              container: { display: 'block' }, spacing: { padding: 8 },
            },
          },
        },
      },
      {
        ...structuredClone(source),
        nodes: {
          ...structuredClone(source.nodes),
          selected: {
            ...structuredClone(frame),
            layout: {
              item: { position: { mode: 'freeform' } },
              container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'center' } },
              spacing: { padding: 8 },
            },
          },
        },
      },
      {
        ...structuredClone(source),
        nodes: {
          ...structuredClone(source.nodes),
          selected: {
            ...structuredClone(frame),
            layout: { item: { position: { mode: 'freeform' } }, container: { display: 'block' }, spacing: { padding: 9 } },
          },
        },
      },
    ]
    for (const drifted of drifts) {
      const beforeDrift = structuredClone(drifted)
      expect(() => applyFileCommand(drifted, plan!.command, [])).toThrow('Resize presentation expected state does not match the file')
      expect(drifted).toStrictEqual(beforeDrift)
    }
  })

  it('AT-DOC-003 commits absolute primitive px geometry while preserving layout metadata and rejects anchor or sizing ambiguity', () => {
    const absolute = rectangle()
    absolute.layout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } } }, spacing: { margin: { x: 3, y: 4 } } }
    const source = fileWith(absolute)
    const selected = measured('rectangle', { x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null)
    selected.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    const captured = snapshot(source, geometry(selected))
    const plan = planGestureCommand(captured, [intent(captured, sample({ x: 15, y: -8, width: 125, height: 70 }))], vi.fn())
    expect(plan?.command).toStrictEqual({
      type: 'node.resizePresentation', entries: [{
        expected: {
          nodeId: 'selected', relationship: { parentId: 'root', orderKey: 'A7' }, primitiveGeometry: { left: 0, top: 0, width: 100, height: 50 },
          layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } } }, spacing: { margin: { x: 3, y: 4 } } },
        },
        source: {
          nodeId: 'selected', relationship: { parentId: 'root', orderKey: 'A7' }, primitiveGeometry: { left: 15, top: -8, width: 125, height: 70 },
          layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 15 }, top: { kind: 'px', value: -8 } } }, spacing: { margin: { x: 3, y: 4 } } },
        },
      }],
    })

    for (const layout of [
      { item: { position: { mode: 'absolute', right: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } } } },
      { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, right: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } } } },
      { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 }, bottom: { kind: 'px', value: 0 } } } },
      { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } }, width: { value: { kind: 'auto' } } }, container: { display: 'block' } },
    ] as const) {
      const rejectedFile = fileWith({ ...rectangle(), layout } as PrimitiveNode)
      const rejected = snapshot(rejectedFile, geometry(structuredClone(selected)))
      const derived = authority(rejected)
      expect(planGestureCommand(rejected, [intent(rejected, sample({ x: 1, y: 2, width: 120, height: 60 }), derived)], vi.fn())).toBeNull()
    }
  })

  it('AT-DOC-003 rejects freeform semantic sizing authority and an unchanged projection without creating history', () => {
    const selected = measured('rectangle', { x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null)
    selected.offsetParentToRoot = [1, 0, 0, 1, 0, 0]

    const sized = rectangle()
    sized.layout = {
      item: {
        position: { mode: 'freeform' },
        width: { value: { kind: 'px', value: 100 } },
      },
      spacing: { margin: 6 },
    }
    const sizedFile = fileWith(sized)
    const sizedSnapshot = snapshot(sizedFile, geometry(structuredClone(selected)))
    const allocate = vi.fn(() => 'never')
    expect(planGestureCommand(sizedSnapshot, [intent(sizedSnapshot, sample({ x: 0, y: 0, width: 140, height: 50 }, ['x']))], allocate)).toBeNull()

    const absentLayout = rectangle()
    delete absentLayout.layout
    const absentFile = fileWith(absentLayout)
    const absentSnapshot = snapshot(absentFile, geometry(structuredClone(selected)))
    const absentPlan = planGestureCommand(absentSnapshot, [intent(absentSnapshot, sample({ x: 0, y: 0, width: 120, height: 50 }, ['x']))], allocate)
    expect(absentPlan?.command).toStrictEqual({
      type: 'node.resizePresentation',
      entries: [{
        expected: {
          nodeId: 'selected', relationship: { parentId: 'root', orderKey: 'A7' },
          primitiveGeometry: { left: 0, top: 0, width: 100, height: 50 }, layout: null,
        },
        source: {
          nodeId: 'selected', relationship: { parentId: 'root', orderKey: 'A7' },
          primitiveGeometry: { left: 0, top: 0, width: 120, height: 50 }, layout: null,
        },
      }],
    })
    const gainedLayout = structuredClone(absentFile)
    ;(gainedLayout.nodes.selected as PrimitiveNode).layout = { item: { position: { mode: 'freeform' } } }
    const beforeGainedLayout = structuredClone(gainedLayout)
    expect(() => applyFileCommand(gainedLayout, absentPlan!.command, [])).toThrow('Resize presentation expected state does not match the file')
    expect(gainedLayout).toStrictEqual(beforeGainedLayout)

    const source = fileWith()
    const captured = snapshot(source, geometry(structuredClone(selected)))
    expect(planGestureCommand(captured, [intent(captured, sample({ x: 0, y: 0, width: 100, height: 50 }))], allocate)).toBeNull()
    expect(allocate).not.toHaveBeenCalled()
    expect(source.nodes.selected).toStrictEqual(rectangle())
  })

  it('PAPER-TEXT-006 changes only locally resized text axes, preserves font size, and clears maxLines only for height', () => {
    const makeText = (): PrimitiveNode => ({
      id: 'selected', type: 'text', name: 'Text', styles: { left: 0, top: 0, width: 100, height: 50 }, text: 'Hello', textStyle: structuredClone(textStyle),
      textSizing: { width: { mode: 'fit' }, height: { mode: 'fit' } }, layout: { item: { position: { mode: 'freeform' } } },
    })
    const selected = measured('text', { x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null)
    selected.offsetParentToRoot = [1, 0, 0, 1, 0, 0]

    const widthFile = fileWith(makeText()), widthSnapshot = snapshot(widthFile, geometry(structuredClone(selected)))
    const widthPlan = planGestureCommand(widthSnapshot, [intent(widthSnapshot, sample({ x: 0, y: 0, width: 140, height: 50 }, ['x']))], vi.fn())
    if (widthPlan?.command.type !== 'node.resizePresentation') throw new Error('Expected a resize presentation command.')
    const widthSource = widthPlan.command.entries[0]!.source
    expect(widthSource.textProperties).toStrictEqual({ textStyle, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } } })
    expect(widthSource.textProperties?.textStyle.fontSize).toBe(18)
    expect(widthSource.textProperties?.textStyle.maxLines).toBe(3)

    const heightFile = fileWith(makeText()), heightSnapshot = snapshot(heightFile, geometry(structuredClone(selected)))
    const heightPlan = planGestureCommand(heightSnapshot, [intent(heightSnapshot, sample({ x: 0, y: 0, width: 100, height: 75 }, ['y']))], vi.fn())
    if (heightPlan?.command.type !== 'node.resizePresentation') throw new Error('Expected a resize presentation command.')
    const heightSource = heightPlan.command.entries[0]!.source
    expect(heightSource.textProperties).toStrictEqual({
      textStyle: {
        fontFamily: 'Inter', fontStyle: 'normal', fontWeight: 400, fontSize: 18,
        lineHeight: { kind: 'unitless', value: 1.4 }, letterSpacing: 0,
        horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false,
      },
      textSizing: { width: { mode: 'fit' }, height: { mode: 'fixed' } },
    })
    expect(heightSource.textProperties?.textStyle).not.toHaveProperty('maxLines')
    expect(heightSource.textProperties?.textStyle.fontSize).toBe(18)
  })

  it('PAPER-FLEX-006 preserves nested Component identity, props, and the real named slot while changing only layout', () => {
    const atoms: Atom[] = [
      { name: 'Panel', kind: 'atom', componentId: 'panel-source', path: 'Panel.tsx', exportName: 'Panel', fingerprint: 'panel', sourceHash: 'panel', status: 'bound', candidates: [], slots: ['body'], props: [{ name: 'body', type: 'ReactNode', optional: true }] },
      { name: 'Button', kind: 'atom', componentId: 'button-source', path: 'Button.tsx', exportName: 'Button', fingerprint: 'button', sourceHash: 'button', status: 'bound', candidates: [], slots: [], props: [{ name: 'label', type: 'string', optional: false }] },
    ]
    const source: FileDocument = {
      schemaVersion: 9, fileId: 'resize-plan-file', revision, pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: {
        root: { id: 'root', type: 'root' },
        parent: { id: 'parent', type: 'component', componentId: 'panel-source', exportName: 'Panel', props: {}, layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 50 }, top: { kind: 'px', value: 60 } } } } },
        selected: {
          id: 'selected', type: 'component', componentId: 'button-source', exportName: 'Button', props: { label: 'Continue' },
          layout: {
            item: {
              position: {
                mode: 'absolute', left: { kind: 'px', value: 20 }, top: { kind: 'px', value: 30 },
              },
              width: { value: { kind: 'percent', value: 50 } },
            },
          },
        },
      },
      relationships: { parent: { parentId: 'root', orderKey: 'F3' }, selected: { parentId: 'parent', orderKey: 'Q7', slot: 'body' } }, theme: { tokens: {} },
    }
    const parent = measured('rectangle', { x: 50, y: 60, width: 200, height: 160 }, { x: 50, y: 60, width: 200, height: 160 }, null)
    delete parent.canvasKind; parent.componentId = 'panel-source'; parent.parentInstanceId = null; parent.offsetParentInstanceId = null; parent.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    const child = measured('rectangle', { x: 70, y: 90, width: 100, height: 50 }, { x: 20, y: 30, width: 100, height: 50 }, 'parent')
    delete child.canvasKind; child.componentId = 'button-source'; child.parentInstanceId = 'parent'; child.offsetParentInstanceId = 'parent'
    const captured = snapshot(source, { revision: measurementRevision, documentRevision: revision, layoutGeneration, nodes: { parent, selected: child }, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 }, 'selected', atoms)
    const plan = planGestureCommand(captured, [intent(captured, sample({ x: 25, y: 35, width: 120, height: 50 }, ['x']))], vi.fn())
    const expectedLayout = {
      item: {
        position: {
          mode: 'absolute' as const, left: { kind: 'px' as const, value: 20 }, top: { kind: 'px' as const, value: 30 },
        },
        width: { value: { kind: 'percent' as const, value: 50 } },
      },
    }
    expect(plan?.command).toStrictEqual({
      type: 'node.resizePresentation', entries: [{
        expected: { nodeId: 'selected', relationship: { parentId: 'parent', orderKey: 'Q7', slot: 'body' }, layout: expectedLayout },
        source: {
          nodeId: 'selected', relationship: { parentId: 'parent', orderKey: 'Q7', slot: 'body' },
          layout: {
            item: {
              position: { mode: 'absolute', left: { kind: 'px', value: 25 }, top: { kind: 'px', value: 35 } },
              width: { value: { kind: 'px', value: 120 } },
            },
          },
        },
      }],
    })
    if (plan?.command.type !== 'node.resizePresentation') throw new Error('Expected a resize presentation command.')
    const applied = applyFileCommand(source, plan.command, atoms)
    expect(applied.nodes.selected).toStrictEqual({ id: 'selected', type: 'component', componentId: 'button-source', exportName: 'Button', props: { label: 'Continue' }, layout: plan.command.entries[0]!.source.layout })
    expect(applied.relationships.selected).toStrictEqual({ parentId: 'parent', orderKey: 'Q7', slot: 'body' })
  })

  it('AT-DOC-003 writes explicit image appearance only when projection changes it', () => {
    const explicit = rectangle()
    explicit.appearance = { fills: [{ id: 'image', type: 'image', assetId: 'flowers', fit: 'cover', geometry: { x: 10, y: 5, width: 40, height: 20 } }] }
    const selected = measured('rectangle', { x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null)
    selected.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    const source = fileWith(explicit), captured = snapshot(source, geometry(structuredClone(selected)))
    const plan = planGestureCommand(captured, [intent(captured, sample({ x: 0, y: 0, width: 200, height: 100 }))], vi.fn())!
    const entry = (plan.command as Extract<typeof plan.command, { type: 'node.resizePresentation' }>).entries[0]!
    expect(entry.expected.appearance).toStrictEqual(explicit.appearance)
    expect(entry.source.appearance?.fills?.[0]).toMatchObject({ geometry: { x: 20, y: 10, width: 80, height: 40 } })

    const implicit = rectangle()
    implicit.appearance = { fills: [{ id: 'image', type: 'image', assetId: 'flowers', fit: 'contain' }] }
    const implicitFile = fileWith(implicit), implicitSnapshot = snapshot(implicitFile, geometry(structuredClone(selected)))
    const implicitPlan = planGestureCommand(implicitSnapshot, [intent(implicitSnapshot, sample({ x: 0, y: 0, width: 200, height: 100 }))], vi.fn())!
    expect((implicitPlan.command as Extract<typeof implicitPlan.command, { type: 'node.resizePresentation' }>).entries[0]).not.toHaveProperty('expected.appearance')
    expect((implicitPlan.command as Extract<typeof implicitPlan.command, { type: 'node.resizePresentation' }>).entries[0]!.expected).not.toHaveProperty('appearance')
  })

  it('PAPER-FLEX-006 commits nested descendants exactly once and keeps content-locked direct children world-fixed', () => {
    const selectedFrame: PrimitiveNode = { id: 'selected', type: 'frame', name: 'Selected', styles: { left: 0, top: 0, width: 100, height: 100 }, layout: { item: { position: { mode: 'freeform' } } } }
    const source = fileWith(selectedFrame)
    source.nodes.child = { id: 'child', type: 'frame', name: 'Child', styles: { left: 10, top: 20, width: 40, height: 50 }, layout: { item: { position: { mode: 'freeform' } } }, isLocked: true }
    source.nodes.grand = rectangle('grand', 5, 6, 10, 20)
    source.relationships.child = { parentId: 'selected', orderKey: 'C3' }
    source.relationships.grand = { parentId: 'child', orderKey: 'G7' }
    const selected = measured('frame', { x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }, null)
    selected.offsetParentToRoot = [1, 0, 0, 1, 0, 0]; selected.box = { border: { top: 10, right: 10, bottom: 10, left: 10 }, padding: zeroBox.padding }
    const child = measured('frame', { x: 10, y: 20, width: 40, height: 50 }, { x: 10, y: 20, width: 40, height: 50 }, 'selected', { x: 20, y: 30, width: 40, height: 50 })
    child.box = { border: { top: 5, right: 5, bottom: 5, left: 5 }, padding: zeroBox.padding }
    const grand = measured('rectangle', { x: 15, y: 26, width: 10, height: 20 }, { x: 5, y: 6, width: 10, height: 20 }, 'child', { x: 30, y: 41, width: 10, height: 20 })
    const captured = snapshot(source, { revision: measurementRevision, documentRevision: revision, layoutGeneration, nodes: { selected, child, grand }, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 })
    const plan = planGestureCommand(captured, [intent(captured, sample({ x: 0, y: 0, width: 200, height: 200 }))], vi.fn())!
    const entries = (plan.command as Extract<typeof plan.command, { type: 'node.resizePresentation' }>).entries
    expect(entries.map(entry => [entry.source.nodeId, entry.source.primitiveGeometry])).toStrictEqual([
      ['selected', { left: 0, top: 0, width: 200, height: 200 }],
      ['child', { left: 22.5, top: 45, width: 90, height: 112.5 }],
      ['grand', { left: 13.333333333333332, top: 15.375, width: 26.666666666666664, height: 51.25 }],
    ])
    expect(entries[2]!.source.primitiveGeometry).not.toStrictEqual({ left: 11.25, top: 13.5, width: 22.5, height: 45 })

    const lockedSource = fileWith({ ...selectedFrame, layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } } } } })
    lockedSource.nodes.child = { ...rectangle('child', 10, 5, 20, 10), isLocked: true }
    lockedSource.relationships.child = { parentId: 'selected', orderKey: 'C3' }
    const rotated = measured('frame', { x: -100, y: 75, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null, { x: -100, y: 0, width: 100, height: 200 })
    rotated.offsetParentToRoot = [0, 2, -2, 0, 0, 0]
    const held = measured('rectangle', { x: 10, y: 5, width: 20, height: 10 }, { x: 10, y: 5, width: 20, height: 10 }, 'selected', { x: -30, y: 20, width: 20, height: 40 })
    const lockedSnapshot = snapshot(lockedSource, { revision: measurementRevision, documentRevision: revision, layoutGeneration, nodes: { selected: rotated, child: held }, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 })
    const lockedPlan = planGestureCommand(lockedSnapshot, [intent(lockedSnapshot, sample({ x: 5, y: -15, width: 35, height: 50 }, ['x', 'y'], true))], vi.fn())!
    const heldEntry = (lockedPlan.command as Extract<typeof lockedPlan.command, { type: 'node.resizePresentation' }>).entries.find(entry => entry.source.nodeId === 'child')!
    expect(heldEntry.source.primitiveGeometry).toStrictEqual({ left: 5, top: 20, width: 20, height: 10 })
    expect(heldEntry.source).not.toHaveProperty('textProperties')
  })

  it('fails closed for flow, stale, malformed, raw-world, and double-rotation inputs without allocation or mutation', () => {
    const selected = measured('rectangle', { x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }, null)
    selected.offsetParentToRoot = [1, 0, 0, 1, 0, 0]
    const source = fileWith(), captured = snapshot(source, geometry(selected)), exact = authority(captured), terminal = sample({ x: 1, y: 2, width: 120, height: 60 })
    const allocate = vi.fn(() => 'never')
    const before = { file: JSON.stringify(source), snapshot: JSON.stringify(captured), authority: JSON.stringify(exact), sample: JSON.stringify(terminal) }
    const mutations: GestureFinalIntent[] = [
      { kind: 'resize', nodeId: 'selected', authority: deepFreeze({ ...structuredClone(exact), groupToWorld: [2, 0, 0, 2, 0, 0] }), sample: terminal },
      { kind: 'resize', nodeId: 'selected', authority: deepFreeze({ ...structuredClone(exact), rotationDegrees: 90 }), sample: terminal },
      { kind: 'resize', nodeId: 'selected', authority: exact, sample: { ...terminal, coordinateSpace: 'world' } as unknown as ResizeProjectionSample },
      { kind: 'resize', nodeId: 'selected', authority: exact, sample: { ...terminal, rect: { ...terminal.rect, width: Number.NaN } } },
      { kind: 'resize', nodeId: 'selected', authority: exact, sample: { ...terminal, extra: true } as ResizeProjectionSample },
    ]
    for (const candidate of mutations) expect(planGestureCommand(captured, [candidate], allocate)).toBeNull()
    let untrustedSampleReads = 0
    const untrustedExtra = {
      kind: 'resize', nodeId: 'selected', authority: exact, untrustedExtra: true,
      get sample() { untrustedSampleReads += 1; throw new Error('An invalid intent reached projection.') },
    } as unknown as GestureFinalIntent
    expect(() => planGestureCommand(captured, [untrustedExtra], allocate)).not.toThrow()
    expect(planGestureCommand(captured, [untrustedExtra], allocate)).toBeNull()
    expect(untrustedSampleReads).toBe(0)
    const malformedIntents = [
      { nodeId: 'selected', authority: exact, sample: terminal },
      { kind: 'resize', authority: exact, sample: terminal },
      { kind: 'resize', nodeId: 'selected', sample: terminal },
      { kind: 'resize', nodeId: 'selected', authority: exact },
    ] as unknown as GestureFinalIntent[]
    for (const candidate of malformedIntents) expect(planGestureCommand(captured, [candidate], allocate)).toBeNull()
    const stale = { ...captured, start: { ...captured.start, fileRevision: revision - 1 } }
    expect(planGestureCommand(stale, [intent(captured, terminal, exact)], allocate)).toBeNull()

    const flowFile = fileWith(); (flowFile.nodes.selected as PrimitiveNode).layout = { item: { position: { mode: 'flow' } } }
    const flowSnapshot = snapshot(flowFile, geometry(structuredClone(selected)))
    expect(planGestureCommand(flowSnapshot, [intent(flowSnapshot, terminal)], allocate)).toBeNull()
    expect(allocate).not.toHaveBeenCalled()
    expect(JSON.stringify(source)).toBe(before.file)
    expect(JSON.stringify(captured)).toBe(before.snapshot)
    expect(JSON.stringify(exact)).toBe(before.authority)
    expect(JSON.stringify(terminal)).toBe(before.sample)
  })
})
