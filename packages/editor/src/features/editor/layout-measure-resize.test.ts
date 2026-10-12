import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { Matrix } from '@canvas/repo-engine/layout-matrix'
import type { GestureAuthorityDocumentState, GestureAuthoritySnapshot } from './gesture-authority'
import { captureGestureAuthority } from './gesture-authority'
import { projectResizeRectToWorld, resizeDescendantPresentationAuthority, resizeGeometryAuthority, resizeWorldDeltaToGroup, resizeWorldPointToGroup } from './layout-measure'
import type { SceneGeometry } from './scene-geometry'

const revision = 7
const layoutGeneration = 11
const measurementRevision = 19

function file(): FileDocument {
  return {
    schemaVersion: 9,
    fileId: 'resize-file',
    revision,
    pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
    nodes: {
      root: { id: 'root', type: 'root' },
      child: {
        id: 'child', type: 'rectangle', name: 'Child',
        styles: { left: 0, top: 0, width: 100, height: 50 },
        layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } } } },
      },
    },
    relationships: { child: { parentId: 'root', orderKey: 'V' } },
    theme: { tokens: {} },
  }
}

function geometry(): SceneGeometry {
  return {
    revision: measurementRevision,
    documentRevision: revision,
    layoutGeneration,
    unsupported: {}, themeUnsupported: {}, unownedPortals: 0,
    nodes: {
      child: {
        canvasKind: 'rectangle', documentRevision: revision, layoutGeneration,
        rect: { x: -100, y: 75, width: 100, height: 50 },
        worldAabb: { x: -100, y: 0, width: 100, height: 200 },
        offset: { x: 0, y: 0, width: 100, height: 50, origin: { x: 50, y: 25 } },
        offsetParentNodeId: null,
        offsetParentToRoot: [0, 2, -2, 0, 0, 0],
        directChild: true,
        transform: [1, 0, 0, 1, 0, 0],
      },
    },
  }
}

function snapshot(sourceFile = file(), sourceGeometry = geometry(), selection = ['child']): GestureAuthoritySnapshot {
  const state: GestureAuthorityDocumentState = {
    file: sourceFile,
    pageId: 'page',
    atoms: [],
    layoutGeneration,
    viewport: { x: 0, y: 0, zoom: 1 },
    viewportSize: { width: 800, height: 600 },
    selection,
  }
  const captured = captureGestureAuthority(() => state, () => sourceGeometry)
  if (!captured) throw new Error('Fixture authority did not capture.')
  return captured
}

function copyAuthority(): GestureAuthoritySnapshot {
  return snapshot(structuredClone(file()), structuredClone(geometry()))
}

function nestedSnapshot(selection = ['child'], lockChild = false, lockParent = false): GestureAuthoritySnapshot {
  const source = file()
  source.nodes.parent = {
    id: 'parent', type: 'frame', name: 'Parent', styles: { left: 10, top: 20, width: 100, height: 100 },
    layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 10 }, top: { kind: 'px', value: 20 } } } },
    ...(lockParent ? { isLocked: true } : {}),
  }
  source.relationships.parent = { parentId: 'root', orderKey: 'F' }
  source.relationships.child!.parentId = 'parent'
  source.nodes.child = {
    id: 'child', type: 'rectangle', name: 'Child', styles: { left: 5, top: 6, width: 10, height: 20 },
    layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 5 }, top: { kind: 'px', value: 6 } } } },
    ...(lockChild ? { isLocked: true } : {}),
  }
  const measured = geometry()
  measured.nodes.parent = {
    canvasKind: 'frame', documentRevision: revision, layoutGeneration,
    rect: { x: 10, y: 20, width: 100, height: 100 },
    worldAabb: { x: 10, y: 20, width: 100, height: 100 },
    offset: { x: 10, y: 20, width: 100, height: 100, origin: { x: 50, y: 50 } },
    offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true,
    transform: [1, 0, 0, 1, 0, 0],
    box: { border: { top: 4, right: 0, bottom: 0, left: 3 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  }
  measured.nodes.child = {
    canvasKind: 'rectangle', documentRevision: revision, layoutGeneration,
    rect: { x: 18, y: 30, width: 10, height: 20 },
    worldAabb: { x: 18, y: 30, width: 10, height: 20 },
    offset: { x: 5, y: 6, width: 10, height: 20, origin: { x: 5, y: 10 } },
    offsetParentNodeId: 'parent', directChild: true,
    transform: [1, 0, 0, 1, 0, 0],
  }
  return snapshot(source, measured, selection)
}

function rotatedSnapshot(): GestureAuthoritySnapshot {
  const source = file()
  const node = source.nodes.child
  if (!node || node.type === 'root' || node.type === 'component') throw new Error('Expected primitive fixture.')
  node.styles = { left: 10, top: 20, width: 100, height: 50, rotation: 90 }
  const measured = geometry()
  measured.nodes.child = {
    canvasKind: 'rectangle', documentRevision: revision, layoutGeneration,
    rect: { x: 10, y: 20, width: 100, height: 50 },
    worldAabb: { x: 35, y: -5, width: 50, height: 100 },
    offset: { x: 10, y: 20, width: 100, height: 50, origin: { x: 50, y: 25 } },
    offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true,
    transform: [0, 1, -1, 0, 0, 0],
  }
  return snapshot(source, measured)
}

describe('immutable resize geometry authority', () => {
  it('captures the exact root offset-parent space and freezes detached identity and matrix evidence', () => {
    const captured = copyAuthority()
    const authority = resizeGeometryAuthority(captured, 'child')

    expect(authority).toStrictEqual({
      coordinateSpace: 'parent-padding', fileId: 'resize-file', pageId: 'page', pageRootId: 'root', nodeId: 'child', parentId: 'root',
      fence: { fileId: 'resize-file', fileRevision: 7, measurementRevision: 19, documentRevision: 7, layoutGeneration: 11 },
      startRect: { x: 0, y: 0, width: 100, height: 50 },
      groupToWorld: [0, 2, -2, 0, 0, 0],
      worldToGroup: [0, -0.5, 0.5, 0, 0, 0],
      rotationDegrees: 0,
      transformOrigin: { x: 50, y: 25 },
    })
    expect(Object.isFrozen(authority)).toBe(true)
    expect(Object.isFrozen(authority!.fence)).toBe(true)
    expect(Object.isFrozen(authority!.startRect)).toBe(true)
    expect(Object.isFrozen(authority!.groupToWorld)).toBe(true)
    expect(Object.isFrozen(authority!.worldToGroup)).toBe(true)
    expect(Object.isFrozen(authority!.transformOrigin)).toBe(true)
    expect(authority!.fence).not.toBe(captured.start)
    expect(authority!.groupToWorld).not.toBe(captured.geometry.nodes.child!.offsetParentToRoot)

    ;(captured.geometry.nodes.child!.offsetParentToRoot as unknown as number[])[0] = 999
    captured.geometry.nodes.child!.offset!.x = 999
    expect(authority!.groupToWorld).toEqual([0, 2, -2, 0, 0, 0])
    expect(authority!.startRect).toEqual({ x: 0, y: 0, width: 100, height: 50 })
  })

  it('maps points and deltas through the captured inverse and projects literal resumed rectangles', () => {
    const authority = resizeGeometryAuthority(copyAuthority(), 'child')!
    expect(resizeWorldPointToGroup(authority, { x: -50, y: 200 })).toStrictEqual({ x: 100, y: 25 })
    expect(resizeWorldDeltaToGroup(authority, { x: -50, y: 200 }, { x: -20, y: 210 })).toStrictEqual({ x: 5, y: -15 })

    expect(projectResizeRectToWorld(authority, { x: 5, y: -15, width: 25, height: 50 })).toStrictEqual({
      quad: [{ x: 30, y: 10 }, { x: 30, y: 60 }, { x: -70, y: 60 }, { x: -70, y: 10 }],
      aabb: { x: -70, y: 10, width: 100, height: 50 },
    })
    expect(projectResizeRectToWorld(authority, { x: 5, y: -15, width: 35, height: 50 })).toStrictEqual({
      quad: [{ x: 30, y: 10 }, { x: 30, y: 80 }, { x: -70, y: 80 }, { x: -70, y: 10 }],
      aabb: { x: -70, y: 10, width: 100, height: 70 },
    })

    // Negative control: applying the world delta directly would produce {30,10}, not the required local {5,-15}.
    expect({ x: -20 - -50, y: 210 - 200 }).toStrictEqual({ x: 30, y: 10 })
    expect({ x: 30, y: 10 }).not.toStrictEqual({ x: 5, y: -15 })
  })

  it('uses strict parent border-to-root plus its border edge for a nested child', () => {
    const authority = resizeGeometryAuthority(nestedSnapshot(), 'child')
    expect(authority?.groupToWorld).toEqual([1, 0, 0, 1, 13, 24])
    expect(authority?.worldToGroup).toEqual([1, 0, 0, 1, -13, -24])
    expect(authority?.startRect).toEqual({ x: 5, y: 6, width: 10, height: 20 })
    expect(projectResizeRectToWorld(authority!, authority!.startRect)).toStrictEqual({
      quad: [{ x: 18, y: 30 }, { x: 28, y: 30 }, { x: 28, y: 50 }, { x: 18, y: 50 }],
      aabb: { x: 18, y: 30, width: 10, height: 20 },
    })
  })

  it('permits locked descendant presentation only under the selected unlocked ancestor and exact parent matrix', () => {
    const captured = nestedSnapshot(['parent'], true)
    const expectedGroup: Matrix = [1, 0, 0, 1, 13, 24]
    const authority = resizeDescendantPresentationAuthority(captured, 'child', 'parent', expectedGroup)

    expect(authority?.nodeId).toBe('child')
    expect(authority?.parentId).toBe('parent')
    expect(authority?.groupToWorld).toEqual(expectedGroup)
    expect(resizeDescendantPresentationAuthority(captured, 'child', 'root', expectedGroup)).toBeNull()
    expect(resizeDescendantPresentationAuthority(captured, 'child', 'parent', [1, 0, 0, 1, 12, 24])).toBeNull()
    expect(resizeGeometryAuthority(nestedSnapshot(['child'], true), 'child')).toBeNull()
    expect(resizeGeometryAuthority(nestedSnapshot(['child'], false, true), 'child')).toBeNull()
    expect(resizeDescendantPresentationAuthority(nestedSnapshot(['parent'], false, true), 'child', 'parent', expectedGroup)).toBeNull()
  })

  it('keeps the selected rotation separate from the parent group matrix so projection rotates exactly once', () => {
    const authority = resizeGeometryAuthority(rotatedSnapshot(), 'child')
    expect(authority?.groupToWorld).toEqual([1, 0, 0, 1, 0, 0])
    expect(authority?.rotationDegrees).toBe(90)
    expect(projectResizeRectToWorld(authority!, authority!.startRect)).toStrictEqual({
      quad: [{ x: 85, y: -5 }, { x: 85, y: 95 }, { x: 35, y: 95 }, { x: 35, y: -5 }],
      aabb: { x: 35, y: -5, width: 50, height: 100 },
    })

    // Negative control: the selected full border matrix would rotate and translate the already-local rect again.
    const selectedBorderToWorld: Matrix = [0, 1, -1, 0, 85, -5]
    const doubleRotatedTopLeft = {
      x: selectedBorderToWorld[0] * 10 + selectedBorderToWorld[2] * 20 + selectedBorderToWorld[4],
      y: selectedBorderToWorld[1] * 10 + selectedBorderToWorld[3] * 20 + selectedBorderToWorld[5],
    }
    expect(doubleRotatedTopLeft).toStrictEqual({ x: 65, y: 5 })
    expect(doubleRotatedTopLeft).not.toStrictEqual({ x: 85, y: -5 })
  })

  it('proves Component identity independently from native canvas kind identity', () => {
    const source = file()
    source.nodes.child = {
      id: 'child', type: 'component', componentId: 'button', exportName: 'Button', props: {},
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } } } },
    }
    const measured = geometry()
    measured.nodes.child = {
      componentId: 'button', documentRevision: revision, layoutGeneration,
      rect: { x: 0, y: 0, width: 100, height: 50 }, worldAabb: { x: 0, y: 0, width: 100, height: 50 },
      offset: { x: 0, y: 0, width: 100, height: 50, origin: { x: 50, y: 25 } },
      offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], offsetParentInstanceId: null, parentInstanceId: null,
      directChild: true, transform: [1, 0, 0, 1, 0, 0],
    }
    const componentSnapshot = snapshot(source, measured)
    expect(resizeGeometryAuthority(componentSnapshot, 'child')?.nodeId).toBe('child')
    measured.nodes.child!.componentId = 'other'
    expect(resizeGeometryAuthority(componentSnapshot, 'child')).toBeNull()

    const native = geometry()
    const nativeSnapshot = snapshot(file(), native)
    native.nodes.child!.canvasKind = 'shape'
    expect(resizeGeometryAuthority(nativeSnapshot, 'child')).toBeNull()
  })

  it('accepts only explicit AABB rounding tolerance and rejects stale or incomplete authority', () => {
    const tolerated = geometry()
    tolerated.nodes.child!.worldAabb = { x: -99.5, y: 0.5, width: 99.5, height: 199.5 }
    expect(resizeGeometryAuthority(snapshot(file(), tolerated), 'child')).not.toBeNull()
    const outside = geometry()
    outside.nodes.child!.worldAabb = { x: -99.49, y: 0, width: 100, height: 200 }
    expect(resizeGeometryAuthority(snapshot(file(), outside), 'child')).toBeNull()

    const mutations: Array<(captured: GestureAuthoritySnapshot) => GestureAuthoritySnapshot> = [
      captured => ({ ...captured, selection: ['child', 'other'] }),
      captured => ({ ...captured, start: { ...captured.start, fileRevision: captured.start.fileRevision - 1 } }),
      captured => { captured.geometry.documentRevision! -= 1; return captured },
      captured => { captured.geometry.layoutGeneration! -= 1; return captured },
      captured => { captured.geometry.nodes.child!.documentRevision! -= 1; return captured },
      captured => { captured.geometry.nodes.child!.layoutGeneration! -= 1; return captured },
      captured => { captured.geometry.nodes.child!.directChild = false; return captured },
      captured => { captured.geometry.nodes.child!.offsetParentNodeId = 'other'; return captured },
      captured => { delete captured.geometry.nodes.child!.offset; return captured },
      captured => { delete captured.geometry.nodes.child!.worldAabb; return captured },
      captured => { delete captured.geometry.nodes.child!.offsetParentToRoot; return captured },
      captured => { captured.geometry.nodes.child!.offsetParentToRoot = [1, 0, 0, 0, 0, 0]; return captured },
      captured => { captured.geometry.nodes.child!.offset!.origin.x = 0; return captured },
      captured => { captured.geometry.nodes.child!.offset!.origin.x = 49; return captured },
      captured => { captured.geometry.nodes.child!.transform = [1, 0.2, 0, 1, 0, 0]; return captured },
      captured => { captured.geometry.nodes.child!.transform = [-1, 0, 0, 1, 0, 0]; return captured },
    ]
    for (const mutate of mutations) {
      const captured = mutate(copyAuthority())
      expect(resizeGeometryAuthority(captured, 'child')).toBeNull()
    }
  })

  it('rejects semantic locks, selected scale, reflections, page mismatch, and cyclic or incomplete parent chains', () => {
    const locked = file()
    const lockedNode = locked.nodes.child
    if (!lockedNode || lockedNode.type === 'root') throw new Error('Expected selectable fixture.')
    lockedNode.isLocked = true
    expect(resizeGeometryAuthority(snapshot(locked, geometry()), 'child')).toBeNull()

    const reflected = file()
    const reflectedNode = reflected.nodes.child
    if (!reflectedNode || reflectedNode.type === 'root' || reflectedNode.type === 'component') throw new Error('Expected primitive fixture.')
    reflectedNode.styles.flipX = true
    expect(resizeGeometryAuthority(snapshot(reflected, geometry()), 'child')).toBeNull()

    const scaled = file()
    scaled.nodes.child = {
      id: 'child', type: 'component', componentId: 'button', exportName: 'Button', props: {},
      layout: { item: { position: { mode: 'absolute', left: { kind: 'px', value: 0 }, top: { kind: 'px', value: 0 } }, transform: { scale: 2 } } },
    }
    const scaledGeometry = geometry()
    scaledGeometry.nodes.child = {
      componentId: 'button', documentRevision: revision, layoutGeneration,
      rect: { x: -50, y: -25, width: 200, height: 100 }, worldAabb: { x: -50, y: -25, width: 200, height: 100 },
      offset: { x: 0, y: 0, width: 100, height: 50, origin: { x: 50, y: 25 } },
      offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], offsetParentInstanceId: null, parentInstanceId: null,
      directChild: true, transform: [2, 0, 0, 2, 0, 0],
    }
    expect(resizeGeometryAuthority(snapshot(scaled, scaledGeometry), 'child')).toBeNull()

    const wrongPage = { ...copyAuthority(), pageId: 'missing' }
    expect(resizeGeometryAuthority(wrongPage, 'child')).toBeNull()

    const otherPage = copyAuthority()
    otherPage.file.nodes.otherRoot = { id: 'otherRoot', type: 'root' }
    otherPage.file.pages.push({ id: 'other', name: 'Other', rootNodeId: 'otherRoot' })
    expect(resizeGeometryAuthority({ ...otherPage, pageId: 'other' }, 'child')).toBeNull()

    const cyclic = nestedSnapshot()
    cyclic.file.relationships.parent!.parentId = 'parent'
    expect(resizeGeometryAuthority(cyclic, 'child')).toBeNull()

    const incomplete = nestedSnapshot()
    delete incomplete.geometry.nodes.parent!.box
    expect(resizeGeometryAuthority(incomplete, 'child')).toBeNull()
  })

  it('returns null for non-finite helper inputs instead of leaking invalid geometry', () => {
    const authority = resizeGeometryAuthority(copyAuthority(), 'child')!
    expect(resizeWorldPointToGroup(authority, { x: Number.NaN, y: 0 })).toBeNull()
    expect(resizeWorldDeltaToGroup(authority, { x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 })).toBeNull()
    expect(projectResizeRectToWorld(authority, { x: 0, y: 0, width: 0, height: 50 })).toBeNull()
  })
})
