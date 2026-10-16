import { describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { Atom } from './types'
import type { GestureAuthorityDocumentState } from './gesture-authority'
import { captureGestureAuthority } from './gesture-authority'
import type { SceneGeometry } from './scene-geometry'

const atoms = (): Atom[] => [{ name: 'Button', kind: 'atom', componentId: 'button-component', path: 'src/Button.tsx', exportName: 'Button', fingerprint: 'button-fingerprint', sourceHash: 'button-hash', status: 'bound', candidates: ['src/legacy/Button.tsx'], props: [{ name: 'tone', type: 'string', optional: true }] }]
const file = (): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} },
  fileId: 'authority-file',
  revision: 7,
  pages: [{ id: 'page', name: 'Page 1', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    flex: { id: 'flex', type: 'frame', name: 'Flex', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 240, height: 120 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } },
    child: { id: 'child', type: 'rectangle', name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 50, height: 24 }, layout: { item: { position: { mode: 'flow' } } } },
  },
  relationships: {
    flex: { parentId: 'root', orderKey: 'V' },
    child: { parentId: 'flex', orderKey: 'V' },
  },
  theme: { tokens: {} },
})
const geometry = (childX = 42): SceneGeometry => ({
  revision: 19,
  documentRevision: 7,
  layoutGeneration: 11,
  unsupported: {},
  themeUnsupported: {},
  unownedPortals: 0,
  nodes: {
    flex: { canvasKind: 'frame', documentRevision: 7, layoutGeneration: 11, rect: { x: 20, y: 30, width: 240, height: 120 }, offset: { x: 20, y: 30, width: 240, height: 120, origin: { x: 120, y: 60 } }, offsetParentNodeId: null, directChild: true },
    child: { canvasKind: 'rectangle', documentRevision: 7, layoutGeneration: 11, rect: { x: childX, y: 48, width: 50, height: 24 }, offset: { x: childX - 20, y: 18, width: 50, height: 24, origin: { x: 25, y: 12 } }, offsetParentNodeId: 'flex', directChild: true },
  },
})
const state = (source = file(), catalog = atoms()): GestureAuthorityDocumentState => ({
  file: source,
  pageId: 'page',
  atoms: catalog,
  layoutGeneration: 11,
  viewport: { x: 14, y: -9, zoom: 1.5 },
  viewportSize: { width: 1280, height: 720 },
  selection: ['child'],
})

describe('Phase 4 immutable gesture authority capture', () => {
  it('reads each authority once and returns the exact file/geometry pair with literal fences and Base data', () => {
    const sourceFile = file()
    const sourceAtoms = atoms()
    const sourceState = state(sourceFile, sourceAtoms)
    const sourceGeometry = geometry(42)
    const getDocumentState = vi.fn(() => sourceState)
    const getGeometry = vi.fn(() => sourceGeometry)
    const captured = captureGestureAuthority(getDocumentState, getGeometry)

    expect(getDocumentState).toHaveBeenCalledTimes(1)
    expect(getGeometry).toHaveBeenCalledTimes(1)
    expect(captured).not.toBeNull()
    expect(captured!.file).toBe(sourceFile)
    expect(captured!.geometry).toBe(sourceGeometry)
    expect(captured!.start).toStrictEqual({ fileId: 'authority-file', fileRevision: 7, measurementRevision: 19, documentRevision: 7, layoutGeneration: 11 })
    expect(captured!.pageId).toBe('page')
    expect(captured!.camera).toStrictEqual({ x: 14, y: -9, zoom: 1.5 })
    expect(captured!.size).toStrictEqual({ width: 1280, height: 720 })
    expect(captured!.selection).toEqual(['child'])
    expect(captured!.scene.byId.get('child')!.rect).toStrictEqual({ x: 42, y: 48, width: 50, height: 24 })
    expect(captured!.atoms).toStrictEqual(sourceAtoms)
    expect(captured!.atoms).not.toBe(sourceAtoms)
    expect(captured!.atoms[0]).not.toBe(sourceAtoms[0])
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(sourceFile)).toBe(false)
    expect(Object.isFrozen(sourceGeometry)).toBe(false)
  })

  it('keeps copied atoms, viewport, size, and selection stable after the source state changes', () => {
    const sourceAtoms = atoms()
    const sourceState = state(file(), sourceAtoms)
    const captured = captureGestureAuthority(() => sourceState, () => geometry())!
    sourceAtoms[0]!.name = 'Changed'
    sourceState.viewport.x = 999
    sourceState.viewportSize.width = 1
    sourceState.selection.push('flex')
    expect(captured.atoms[0]!.name).toBe('Button')
    expect(captured.camera).toStrictEqual({ x: 14, y: -9, zoom: 1.5 })
    expect(captured.size).toStrictEqual({ width: 1280, height: 720 })
    expect(captured.selection).toEqual(['child'])
  })

  it('deep-freezes only the captured atom graph, including candidate and prop metadata', () => {
    const sourceAtoms = atoms()
    const captured = captureGestureAuthority(() => state(file(), sourceAtoms), () => geometry())!

    expect(Object.isFrozen(captured.atoms)).toBe(true)
    expect(Object.isFrozen(captured.atoms[0])).toBe(true)
    expect(Object.isFrozen(captured.atoms[0]!.candidates)).toBe(true)
    expect(Object.isFrozen(captured.atoms[0]!.props)).toBe(true)
    expect(Object.isFrozen(captured.atoms[0]!.props[0])).toBe(true)
    expect(() => { (captured.atoms[0] as Atom).name = 'Captured change' }).toThrow(TypeError)
    expect(() => { (captured.atoms[0] as Atom).candidates[0] = 'src/captured/Button.tsx' }).toThrow(TypeError)
    expect(() => { (captured.atoms[0] as Atom).props[0]!.type = 'number' }).toThrow(TypeError)
    expect(captured.atoms[0]).toStrictEqual({ name: 'Button', kind: 'atom', componentId: 'button-component', path: 'src/Button.tsx', exportName: 'Button', fingerprint: 'button-fingerprint', sourceHash: 'button-hash', status: 'bound', candidates: ['src/legacy/Button.tsx'], props: [{ name: 'tone', type: 'string', optional: true }] })

    expect(Object.isFrozen(sourceAtoms)).toBe(false)
    expect(Object.isFrozen(sourceAtoms[0])).toBe(false)
    expect(Object.isFrozen(sourceAtoms[0]!.candidates)).toBe(false)
    expect(Object.isFrozen(sourceAtoms[0]!.props[0])).toBe(false)
    sourceAtoms[0]!.name = 'Shared change'
    sourceAtoms[0]!.candidates[0] = 'src/shared/Button.tsx'
    sourceAtoms[0]!.props[0]!.type = 'boolean'
    expect(sourceAtoms[0]).toStrictEqual({ name: 'Shared change', kind: 'atom', componentId: 'button-component', path: 'src/Button.tsx', exportName: 'Button', fingerprint: 'button-fingerprint', sourceHash: 'button-hash', status: 'bound', candidates: ['src/shared/Button.tsx'], props: [{ name: 'tone', type: 'boolean', optional: true }] })
    expect(captured.atoms[0]!.name).toBe('Button')
    expect(captured.atoms[0]!.candidates).toEqual(['src/legacy/Button.tsx'])
    expect(captured.atoms[0]!.props).toEqual([{ name: 'tone', type: 'string', optional: true }])
  })

  it.each([
    ['negative file revision', (document: GestureAuthorityDocumentState, _geometry: SceneGeometry) => { document.file!.revision = -1 }],
    ['fractional file revision', (document: GestureAuthorityDocumentState, _geometry: SceneGeometry) => { document.file!.revision = 7.5 }],
    ['negative measurement revision', (_document: GestureAuthorityDocumentState, measured: SceneGeometry) => { measured.revision = -1 }],
    ['fractional measurement revision', (_document: GestureAuthorityDocumentState, measured: SceneGeometry) => { measured.revision = 19.5 }],
    ['missing document revision', (_document: GestureAuthorityDocumentState, measured: SceneGeometry) => { measured.documentRevision = null }],
    ['mismatched document revision', (_document: GestureAuthorityDocumentState, measured: SceneGeometry) => { measured.documentRevision = 6 }],
    ['negative layout generation', (document: GestureAuthorityDocumentState, _geometry: SceneGeometry) => { document.layoutGeneration = -1 }],
    ['missing geometry generation', (_document: GestureAuthorityDocumentState, measured: SceneGeometry) => { measured.layoutGeneration = null }],
    ['mismatched geometry generation', (_document: GestureAuthorityDocumentState, measured: SceneGeometry) => { measured.layoutGeneration = 12 }],
    ['stale node document revision', (_document: GestureAuthorityDocumentState, measured: SceneGeometry) => { measured.nodes.child!.documentRevision = 6 }],
    ['stale node layout generation', (_document: GestureAuthorityDocumentState, measured: SceneGeometry) => { measured.nodes.child!.layoutGeneration = 10 }],
  ])('rejects %s from one paired read', (_name, mutate) => {
    const sourceState = state()
    const sourceGeometry = geometry()
    mutate(sourceState, sourceGeometry)
    const getDocumentState = vi.fn(() => sourceState)
    const getGeometry = vi.fn(() => sourceGeometry)
    expect(captureGestureAuthority(getDocumentState, getGeometry)).toBeNull()
    expect(getDocumentState).toHaveBeenCalledTimes(1)
    expect(getGeometry).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing file', (document: GestureAuthorityDocumentState) => { document.file = null }],
    ['missing page', (document: GestureAuthorityDocumentState) => { document.pageId = null }],
    ['unknown page', (document: GestureAuthorityDocumentState) => { document.pageId = 'missing-page' }],
    ['missing root', (document: GestureAuthorityDocumentState) => { delete document.file!.nodes.root }],
  ])('rejects %s while still taking one paired authority read', (_name, mutate) => {
    const sourceState = state()
    mutate(sourceState)
    const getDocumentState = vi.fn(() => sourceState)
    const getGeometry = vi.fn(() => geometry())
    expect(captureGestureAuthority(getDocumentState, getGeometry)).toBeNull()
    expect(getDocumentState).toHaveBeenCalledTimes(1)
    expect(getGeometry).toHaveBeenCalledTimes(1)
  })

  it('rejects a document whose measured scene cannot be built', () => {
    const source = file()
    delete source.nodes.flex
    delete source.relationships.flex
    source.relationships.child = { parentId: 'root', orderKey: 'V' }
    const emptyGeometry: SceneGeometry = { revision: 19, documentRevision: 7, layoutGeneration: 11, nodes: {}, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 }
    expect(captureGestureAuthority(() => state(source), () => emptyGeometry)).toBeNull()
  })

  it('never performs a second geometry read that could mix a later scene with the first fences', () => {
    const first = geometry(42)
    const later = { ...geometry(900), revision: 20, documentRevision: 8, layoutGeneration: 12 }
    const getGeometry = vi.fn().mockReturnValueOnce(first).mockReturnValue(later)
    const captured = captureGestureAuthority(() => state(), getGeometry)
    expect(getGeometry).toHaveBeenCalledTimes(1)
    expect(captured!.geometry).toBe(first)
    expect(captured!.start).toStrictEqual({ fileId: 'authority-file', fileRevision: 7, measurementRevision: 19, documentRevision: 7, layoutGeneration: 11 })
    expect(captured!.scene.byId.get('child')!.rect).toStrictEqual({ x: 42, y: 48, width: 50, height: 24 })
  })
})
