import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { applyDocumentCommand, createDocument, getDocumentParent, validateDocument } from './document.js'
import type { DocumentNode, EditorDocument } from './document.js'
import { fileFromLegacyDocument, loadFile, readDocumentState, saveDocument } from './document-persistence.js'
import { childrenOf, legacyPageDocument } from './file-document.js'
import type { FileDocument } from './file-document.js'
import { documentPromotionSource } from './document-promotion.js'
import { discover, makeProject, sourceFiles } from './discovery.js'
import type { Atom, Composition } from './types.js'

const fixtureRoot = fileURLToPath(new URL('../../../fixtures/component-repo/', import.meta.url))
let atoms: Atom[]
let files: Record<string, string>
const temporary: string[] = []
const composition: Composition = {
  id: 'login', name: 'Login', componentId: null,
  children: [
    { id: 'email-label', componentId: 'atom-Label', exportName: 'Label', props: { children: 'Email', htmlFor: 'email' } },
    { id: 'email-input', componentId: 'atom-Input', exportName: 'Input', props: { id: 'email', type: 'email' } },
    { id: 'submit', componentId: 'atom-Button', exportName: 'Button', props: { children: 'Sign in', variant: 'primary' } },
  ],
}
const node = (id: string, exportName: string, props: DocumentNode['props'] = {}): DocumentNode => ({ id, componentId: `atom-${exportName}`, exportName, props, children: {} })
const fresh = () => createDocument(atoms, composition)

beforeAll(async () => {
  files = await sourceFiles(fixtureRoot)
  atoms = discover(fixtureRoot, files).map(atom => ({ ...atom, componentId: `atom-${atom.exportName}`, status: 'bound', candidates: [] }))
})

afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('validated editor documents', () => {
  it('initializes a named Card with actual repository atom bindings and immutable command inputs', () => {
    const before = fresh()
    expect(before.rootIds).toEqual(['login:card'])
    expect(before.nodes['login:card']!.children).toEqual({ children: ['email-label', 'email-input', 'submit'] })
    const inserted = applyDocumentCommand(before, { type: 'insert', node: node('new-label', 'Label', { children: 'Remember me' }), target: { parentId: 'login:card', slot: 'footer' } }, atoms)
    expect(inserted.nodes['login:card']!.children.footer).toEqual(['new-label'])
    expect(inserted.nodes['new-label']!.componentId).toBe('atom-Label')
    expect(before.nodes['new-label']).toBeUndefined()
    expect(before.nodes['login:card']!.children.footer).toBeUndefined()
  })

  it('duplicates a nested subtree with new instance IDs and the same source component IDs', () => {
    const before = fresh()
    const next = applyDocumentCommand(before, { type: 'duplicate', nodeId: 'login:card', ids: { 'login:card': 'copy-card', 'email-label': 'copy-label', 'email-input': 'copy-input', submit: 'copy-submit' } }, atoms)
    expect(next.rootIds).toEqual(['login:card', 'copy-card'])
    expect(next.nodes['copy-card']!.children.children).toEqual(['copy-label', 'copy-input', 'copy-submit'])
    expect(next.nodes['copy-label']).toEqual({ id: 'copy-label', componentId: 'atom-Label', exportName: 'Label', props: { children: 'Email', htmlFor: 'email' }, children: {} })
    expect(() => applyDocumentCommand(before, { type: 'duplicate', nodeId: 'email-label', ids: { 'email-label': 'email-label' } }, atoms)).toThrow('unique new identities')
  })

  it('moves instances by final index and between verified named slots, then deletes only the chosen subtree', () => {
    let doc = applyDocumentCommand(fresh(), { type: 'move', nodeId: 'submit', target: { parentId: 'login:card', slot: 'children', index: 0 } }, atoms)
    expect(doc.nodes['login:card']!.children.children).toEqual(['submit', 'email-label', 'email-input'])
    doc = applyDocumentCommand(doc, { type: 'move', nodeId: 'email-label', target: { parentId: 'login:card', slot: 'footer' } }, atoms)
    expect(getDocumentParent(doc, 'email-label')).toEqual({ parentId: 'login:card', slot: 'footer', index: 0 })
    doc = applyDocumentCommand(doc, { type: 'delete', nodeIds: ['email-label'] }, atoms)
    expect(doc.nodes['login:card']!.children.children).toEqual(['submit', 'email-input'])
    expect(doc.nodes['login:card']!.children.footer).toEqual([])
    expect(doc.nodes['email-label']).toBeUndefined()
    expect(applyDocumentCommand(doc, { type: 'delete', nodeIds: ['login:card'] }, atoms).nodes).toEqual({})
  })

  it('rejects invalid slots, text-slot collisions, cycles and reused child instances', () => {
    const doc = fresh()
    expect(() => applyDocumentCommand(doc, { type: 'move', nodeId: 'submit', target: { parentId: 'email-input', slot: 'children' } }, atoms)).toThrow('Invalid slot')
    expect(() => applyDocumentCommand(doc, { type: 'move', nodeId: 'submit', target: { parentId: 'login:card', slot: 'heading' } }, atoms)).toThrow('Clear the text prop')
    expect(() => applyDocumentCommand(doc, { type: 'move', nodeId: 'login:card', target: { parentId: 'login:card' } }, atoms)).toThrow('own subtree')
    const cyclic = structuredClone(doc)
    cyclic.nodes['login:card']!.children.children!.push('login:card')
    expect(() => validateDocument(cyclic, atoms)).toThrow('cycle')
    const reused = structuredClone(doc)
    reused.rootIds.push('submit')
    expect(() => validateDocument(reused, atoms)).toThrow('multiple parents')
  })

  it('allows a deliberate text-to-slot change and validates actual enum and boolean prop types', () => {
    let doc = applyDocumentCommand(fresh(), { type: 'remove-props', nodeId: 'login:card', names: ['heading'] }, atoms)
    doc = applyDocumentCommand(doc, { type: 'move', nodeId: 'email-label', target: { parentId: 'login:card', slot: 'heading' } }, atoms)
    doc = applyDocumentCommand(doc, { type: 'update-props', nodeId: 'submit', props: { variant: 'quiet', disabled: true } }, atoms)
    expect(doc.nodes['login:card']!.children.heading).toEqual(['email-label'])
    expect(doc.nodes.submit!.props).toEqual({ children: 'Sign in', variant: 'quiet', disabled: true })
    expect(() => applyDocumentCommand(doc, { type: 'update-props', nodeId: 'submit', props: { variant: 'unknown' } }, atoms)).toThrow('Unsupported value')
    expect(() => applyDocumentCommand(doc, { type: 'update-props', nodeId: 'submit', props: { disabled: 'yes' } }, atoms)).toThrow('Unsupported value')
    expect(() => applyDocumentCommand(doc, { type: 'update-props', nodeId: 'submit', props: { onClick: 'alert(1)' } }, atoms)).toThrow('Unsupported prop')
  })

  it('checks source identity, unknown fields, size, and frame values rather than accepting display-name matches', () => {
    const doc = fresh()
    const impostor = structuredClone(doc)
    impostor.nodes.submit!.componentId = 'atom-Input'
    expect(() => validateDocument(impostor, atoms)).toThrow('binding')
    expect(() => validateDocument({ ...doc, arbitrary: true }, atoms)).toThrow('Unsupported document field')
    expect(() => applyDocumentCommand(doc, { type: 'update-frame', frame: { width: Number.NaN } }, atoms)).toThrow('frame width')
    expect(() => applyDocumentCommand(doc, { type: 'update-frame', frame: { height: 1 } }, atoms)).toThrow('frame height')
    expect(() => applyDocumentCommand(doc, { type: 'update-props', nodeId: 'submit', props: { children: 'a'.repeat(10_001) } }, atoms)).toThrow('Invalid value')
    expect(applyDocumentCommand(doc, { type: 'update-frame', frame: { width: 640, direction: 'row', clip: true } }, atoms).frame).toEqual({ width: 640, height: 520, direction: 'row', gap: 16, padding: 24, clip: true })
  })

  it('persists native DOM canvas elements, geometry, component layout, and exact layer order', () => {
    let doc = applyDocumentCommand(fresh(), { type: 'insert-canvas-element', element: { id: 'rectangle-1', kind: 'rectangle', name: 'Rectangle 1', x: 20, y: 30, width: 160, height: 100, rotation: 0, fill: 'accent' } }, atoms)
    doc = applyDocumentCommand(doc, { type: 'insert-canvas-element', element: { id: 'shape-1', kind: 'shape', name: 'Shape 1', x: 60, y: 70, width: 120, height: 120, rotation: 0, fill: 'muted' } }, atoms)
    doc = applyDocumentCommand(doc, { type: 'update-canvas-element', elementId: 'rectangle-1', patch: { x: 88, width: 240 } }, atoms)
    doc = applyDocumentCommand(doc, { type: 'move-canvas-element', elementId: 'shape-1', index: 0 }, atoms)
    doc = applyDocumentCommand(doc, { type: 'update-node-layout', nodeId: 'submit', layout: { mode: 'absolute', x: 12, y: 18, width: 140, height: 44 } }, atoms)
    expect(validateDocument(JSON.parse(JSON.stringify(doc)), atoms)).toEqual(doc)
    expect(doc.canvas!.elements.map(element => element.id)).toEqual(['shape-1', 'rectangle-1'])
    expect(doc.canvas!.elements[1]).toMatchObject({ x: 88, width: 240 })
    expect(doc.nodes.submit!.layout).toEqual({ mode: 'absolute', x: 12, y: 18, width: 140, height: 44 })
    expect(() => documentPromotionSource('CanvasLogin', doc, atoms)).toThrow('reviewed source adapter')
  })

  it('rejects invalid native geometry and identity collisions', () => {
    const doc = fresh()
    expect(() => applyDocumentCommand(doc, { type: 'insert-canvas-element', element: { id: 'submit', kind: 'rectangle', name: 'Rectangle', x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: 'accent' } }, atoms)).toThrow('identity')
    expect(() => applyDocumentCommand(doc, { type: 'insert-canvas-element', element: { id: 'bad-shape', kind: 'shape', name: 'Shape', x: 0, y: 0, width: 0, height: 10, rotation: 0, fill: 'accent' } }, atoms)).toThrow('identity')
  })

  it('persists nested frame ownership, large world coordinates, and cascaded frame deletion', () => {
    let doc = applyDocumentCommand(fresh(), { type: 'insert-canvas-element', element: { id: 'frame-1', kind: 'frame', name: 'Frame 1', x: -250000, y: 320000, width: 9000, height: 7000, rotation: 0, fill: 'surface' } }, atoms)
    doc = applyDocumentCommand(doc, { type: 'insert-canvas-element', element: { id: 'rectangle-1', kind: 'rectangle', name: 'Rectangle 1', x: 40, y: 60, width: 160, height: 100, rotation: 0, fill: 'accent', parentId: 'frame-1' } }, atoms)
    expect(validateDocument(JSON.parse(JSON.stringify(doc)), atoms).canvas?.elements[1]).toMatchObject({ id: 'rectangle-1', parentId: 'frame-1', x: 40, y: 60 })
    doc = applyDocumentCommand(doc, { type: 'update-canvas-element', elementId: 'frame-1', patch: { x: -1000000, y: 1000000, width: 1000000, height: 1000000 } }, atoms)
    expect(doc.canvas?.elements[0]).toMatchObject({ x: -1000000, y: 1000000, width: 1000000, height: 1000000 })
    expect(() => applyDocumentCommand(doc, { type: 'update-canvas-element', elementId: 'frame-1', patch: { x: -1000001 } }, atoms)).toThrow('Invalid canvas element update')
    expect(() => applyDocumentCommand(doc, { type: 'update-canvas-element', elementId: 'frame-1', patch: { parentId: 'rectangle-1' } }, atoms)).toThrow('nested in frames')
    const removed = applyDocumentCommand(doc, { type: 'delete-canvas-elements', elementIds: ['frame-1'] }, atoms)
    expect(removed.canvas?.elements).toEqual([])
  })
})

describe('document metadata persistence', () => {
  async function root() {
    const directory = await mkdtemp(path.join(tmpdir(), 'design-editor-document-'))
    temporary.push(directory)
    return directory
  }
  const projectId = 'project-under-test'
  const freshFile = () => fileFromLegacyDocument(projectId, fresh(), atoms)
  const setChildren = (file: FileDocument, nodeId: string, value: string) => { const node = file.nodes[nodeId]; if (node?.type === 'component') node.props.children = value }

  it('round trips identities and exact hierarchy without writing repository source', async () => {
    const directory = await root()
    await writeFile(path.join(directory, 'source.tsx'), 'export const untouched = true\n')
    expect(await loadFile(directory, projectId, atoms)).toBeNull()
    const saved = await saveDocument(directory, freshFile(), 0, atoms)
    expect(saved.revision).toBe(1)
    const loaded = await loadFile(directory, projectId, atoms)
    expect(loaded!.nodes['email-label']!.id).toBe('email-label')
    expect(childrenOf(loaded!, 'login:card', 'children')).toEqual(['email-label', 'email-input', 'submit'])
    expect(await readFile(path.join(directory, 'source.tsx'), 'utf8')).toBe('export const untouched = true\n')
    await expect(saveDocument(directory, saved, 0, atoms)).rejects.toThrow('revision changed')
  })

  it('migrates a stored version 1 document in memory and backs the original bytes up on the first save', async () => {
    const directory = await root()
    const legacy = fresh()
    const legacyBytes = JSON.stringify(legacy)
    await mkdir(path.join(directory, '.design-editor'), { recursive: true })
    await writeFile(path.join(directory, '.design-editor/document.json'), legacyBytes)
    const state = await readDocumentState(directory, projectId, atoms)
    expect(state.legacy).toBe(true)
    expect(state.file!.pages).toEqual([{ id: `page-${projectId}`, name: 'Page 1', rootNodeId: `root:page-${projectId}` }])
    expect(await readFile(path.join(directory, '.design-editor/document.json'), 'utf8')).toBe(legacyBytes)
    const saved = await saveDocument(directory, state.file!, 0, atoms, state.hash)
    expect(saved.schemaVersion).toBe(5)
    expect(await readFile(path.join(directory, '.design-editor/document.v1.backup.json'), 'utf8')).toBe(legacyBytes)
    expect(JSON.parse(await readFile(path.join(directory, '.design-editor/document.json'), 'utf8')).schemaVersion).toBe(5)
  })

  it('upgrades a stored version 2 file on read without rewriting it, and saves it as version 5', async () => {
    const directory = await root()
    const rootId = `root:page-${projectId}`
    const stored = JSON.parse(JSON.stringify({ ...freshFile(), schemaVersion: 2, revision: 4 }))
    const lit = (hex: string) => ({ kind: 'literal', color: { kind: 'hex', hex } })
    // Version 2 order is top-first: red is drawn, the hidden green sits under it.
    stored.nodes.swatch = { id: 'swatch', type: 'rectangle', name: 'Swatch', styles: { left: 0, top: 0, width: 10, height: 10 }, fills: [{ type: 'solid', color: lit('#ff0000') }, { type: 'solid', color: lit('#00ff00'), visible: false }] }
    stored.relationships.swatch = { parentId: rootId, orderKey: 'Z' }
    const bytes = JSON.stringify(stored, null, 2)
    await mkdir(path.join(directory, '.design-editor'), { recursive: true })
    await writeFile(path.join(directory, '.design-editor/document.json'), bytes)
    const state = await readDocumentState(directory, projectId, atoms)
    expect(state.legacy).toBe(false)
    expect(state.file!.schemaVersion).toBe(5)
    expect(state.file!.revision).toBe(4)
    expect(state.file!.nodes.swatch).toStrictEqual({ id: 'swatch', type: 'rectangle', name: 'Swatch', styles: { left: 0, top: 0, width: 10, height: 10 }, appearance: { fills: [{ id: 'swatch:fill:2', type: 'solid', color: lit('#00ff00'), visible: false }, { id: 'swatch:fill:1', type: 'solid', color: lit('#ff0000') }] }, themeMode: 'inherit' })
    expect(await readFile(path.join(directory, '.design-editor/document.json'), 'utf8')).toBe(bytes)
    const saved = await saveDocument(directory, state.file!, 4, atoms, state.hash)
    expect(saved.revision).toBe(5)
    const written = JSON.parse(await readFile(path.join(directory, '.design-editor/document.json'), 'utf8'))
    expect(written.schemaVersion).toBe(5)
    expect(written.nodes.swatch).not.toHaveProperty('fills')
    expect(written.nodes.swatch.appearance.fills.map((paint: { id: string }) => paint.id)).toEqual(['swatch:fill:2', 'swatch:fill:1'])
    await expect(readFile(path.join(directory, '.design-editor/document.v1.backup.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await loadFile(directory, projectId, atoms))!.nodes.swatch).toStrictEqual(state.file!.nodes.swatch)
  })

  it('rejects same-revision external bytes and leaves their contents intact', async () => {
    const directory = await root()
    const saved = await saveDocument(directory, freshFile(), 0, atoms)
    const external = structuredClone(saved)
    setChildren(external, 'submit', 'Changed elsewhere')
    const externalBytes = JSON.stringify(external)
    await writeFile(path.join(directory, '.design-editor/document.json'), externalBytes)
    await expect(saveDocument(directory, saved, 1, atoms)).rejects.toThrow('contents changed')
    expect(await readFile(path.join(directory, '.design-editor/document.json'), 'utf8')).toBe(externalBytes)
    const reloaded = await loadFile(directory, projectId, atoms)
    expect((await saveDocument(directory, reloaded!, 1, atoms)).revision).toBe(2)
  })

  it('rejects concurrent metadata writers through the exclusive lock', async () => {
    const directory = await root()
    await saveDocument(directory, freshFile(), 0, atoms)
    await writeFile(path.join(directory, '.design-editor/document.lock'), '')
    await expect(saveDocument(directory, freshFile(), 1, atoms)).rejects.toThrow('Another document save')
    expect(JSON.parse(await readFile(path.join(directory, '.design-editor/document.json'), 'utf8')).revision).toBe(1)
  })

  it('keeps per-engine hash approval even if another reader adopts a same-revision external edit', async () => {
    const directory = await root()
    await saveDocument(directory, freshFile(), 0, atoms)
    const firstEngine = await readDocumentState(directory, projectId, atoms)
    const external = structuredClone(firstEngine.file!)
    setChildren(external, 'submit', 'Other editor')
    await writeFile(path.join(directory, '.design-editor/document.json'), JSON.stringify(external))
    const secondEngine = await readDocumentState(directory, projectId, atoms)
    expect((secondEngine.file!.nodes.submit as unknown as { props: { children: string } }).props.children).toBe('Other editor')
    await expect(saveDocument(directory, firstEngine.file!, 1, atoms, firstEngine.hash)).rejects.toThrow('contents changed')
    expect(JSON.parse(await readFile(path.join(directory, '.design-editor/document.json'), 'utf8')).nodes.submit.props.children).toBe('Other editor')
  })

  it('retains unresolved component references for conflict display while blocking all edits and promotion', async () => {
    const directory = await root()
    await saveDocument(directory, freshFile(), 0, atoms)
    const missingAtoms = atoms.map(atom => atom.exportName === 'Label' ? { ...atom, status: 'missing' as const } : atom)
    const state = await readDocumentState(directory, projectId, missingAtoms, { allowUnavailableBindings: true })
    expect((state.file!.nodes['email-label'] as { componentId: string }).componentId).toBe('atom-Label')
    await expect(saveDocument(directory, state.file!, 1, missingAtoms, state.hash)).rejects.toThrow('binding')
    expect(() => documentPromotionSource('InvalidLogin', legacyPageDocument(state.file!, `page-${projectId}`), missingAtoms)).toThrow('binding')
  })
})
