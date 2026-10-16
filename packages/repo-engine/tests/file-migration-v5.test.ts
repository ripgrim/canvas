import { describe, expect, it } from 'vitest'
import type { Atom } from '../src/types.js'
import { applyFileCommand, validateFileDocument } from '../src/file-document.js'
import type { FileDocument } from '../src/file-document.js'
import { isFileDocumentShape, upgradeFileDocument } from '../src/file-migration.js'

const atom = (name: string, componentId: string, props: Atom['props']): Atom => ({ name, kind: 'atom', componentId, path: `src/${name}.tsx`, exportName: name, fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props })
const atoms: Atom[] = [atom('Card', 'sample-card', [{ name: 'children', type: 'ReactNode', optional: true }]), atom('Button', 'sample-button', [{ name: 'children', type: 'ReactNode', optional: true }])]
const lit = (hex: string) => ({ kind: 'literal' as const, color: { kind: 'hex' as const, hex } })

/** A v4 file with every node kind, layout, appearance, tokens, and two pages. */
const v4 = () => ({
  schemaVersion: 4, fileId: 'file-1', revision: 7,
  pages: [{ id: 'page-1', name: 'Home', rootNodeId: 'root-1' }, { id: 'page-2', name: 'Other', rootNodeId: 'root-2' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'root-2': { id: 'root-2', type: 'root' },
    card: { id: 'card', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'block' } }, appearance: { opacity: 0.5 } },
    btn: { id: 'btn', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Go' } },
    box: { id: 'box', type: 'rectangle', name: 'Box', styles: { left: 1, top: 2, width: 30, height: 40 }, appearance: { fills: [{ id: 'box:fill:1', type: 'solid', color: { kind: 'token', tokenId: 'brand' } }] } },
    caption: { id: 'caption', type: 'text', name: 'Caption', styles: { left: 0, top: 0, width: 80, height: 20 }, text: 'Hi' },
  },
  relationships: {
    card: { parentId: 'root-1', orderKey: 'V' }, btn: { parentId: 'card', orderKey: 'V', slot: 'children' }, box: { parentId: 'root-1', orderKey: 'W' }, caption: { parentId: 'root-2', orderKey: 'V' },
  },
  theme: { tokens: { brand: { id: 'brand', type: 'color', name: 'Brand', orderKey: 'V', value: lit('#3366cc') }, alias: { id: 'alias', type: 'color', name: 'Alias', orderKey: 'W', value: { kind: 'alias', tokenId: 'brand' } } } },
})

describe('CC-NT-001: v4 theme-mode migration through current schema', () => {
  it('sets every non-root node to inherit and leaves everything else byte-equal', () => {
    const input = v4()
    const upgraded = upgradeFileDocument(input) as FileDocument
    expect(upgraded.schemaVersion).toBe(13)
    for (const id of ['card', 'btn', 'box', 'caption']) expect((upgraded.nodes[id] as { themeMode?: string }).themeMode).toBe('inherit')
    expect(upgraded.nodes['root-1']).toBe(input.nodes['root-1'])
    expect(upgraded.nodes['root-2']).toBe(input.nodes['root-2'])
    expect((upgraded.nodes.box as { styles: unknown }).styles).toEqual({ relativeTransform: [1, 0, 0, 1, 1, 2], width: 30, height: 40 })
    expect((upgraded.nodes.caption as { styles: unknown }).styles).toEqual({ relativeTransform: [1, 0, 0, 1, 0, 0], width: 80, height: 20 })
    expect(upgraded.pages).toBe(input.pages)
    expect(upgraded.relationships).toBe(input.relationships)
    expect(upgraded.theme).toBe(input.theme)
    expect(upgraded).not.toHaveProperty('assets')
    expect(input).toEqual(v4())
    expect(validateFileDocument(upgraded, atoms)).toEqual(upgraded)
    expect(upgradeFileDocument(upgraded)).toBe(upgraded)
  })
  it('chains from version 2 and 3 to the current schema and recognizes every stored version', () => {
    const v3 = { ...v4(), schemaVersion: 3, nodes: { ...v4().nodes, card: { id: 'card', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {}, layout: { mode: 'flow', x: 0, y: 0 } } } }
    const upgraded = upgradeFileDocument(v3) as FileDocument
    expect(upgraded.schemaVersion).toBe(13)
    expect(upgraded.nodes.card).toEqual({ id: 'card', type: 'component', componentId: 'sample-card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } } }, themeMode: 'inherit' })
    for (const version of [2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(isFileDocumentShape({ ...v4(), schemaVersion: version })).toBe(true)
    expect(isFileDocumentShape({ ...v4(), schemaVersion: 11 })).toBe(true)
    expect(isFileDocumentShape({ ...v4(), schemaVersion: 12 })).toBe(true)
    expect(isFileDocumentShape({ ...v4(), schemaVersion: 13 })).toBe(true)
    expect(isFileDocumentShape({ ...v4(), schemaVersion: 14 })).toBe(false)
    expect(() => validateFileDocument(v4(), atoms)).toThrow('Unsupported design file version')
  })

  it('upgrades a version 5 file through the current schema without inventing page backgrounds', () => {
    const { componentModel: _componentModel, ...current } = upgradeFileDocument(v4()) as FileDocument
    const version5 = { ...current, schemaVersion: 5 }
    const upgraded = upgradeFileDocument(version5) as FileDocument
    expect(upgraded).not.toBe(version5)
    expect(upgraded.schemaVersion).toBe(13)
    expect(upgraded.pages).toBe(version5.pages)
    expect(upgraded.pages.every(page => !Object.hasOwn(page, 'background'))).toBe(true)
    const { componentModel: _upgradedComponentModel, ...upgradedWithoutComponentModel } = upgraded
    expect({ ...upgradedWithoutComponentModel, schemaVersion: null }).toEqual({ ...version5, schemaVersion: null })
    expect(validateFileDocument(upgraded, atoms)).toEqual(upgraded)
    expect(upgradeFileDocument(upgraded)).toBe(upgraded)
  })
  it('keeps an explicit stored mode and rejects an invalid one', () => {
    const upgraded = upgradeFileDocument({ ...v4(), nodes: { ...v4().nodes, box: { ...v4().nodes.box, themeMode: 'dark' } } }) as FileDocument
    expect((upgraded.nodes.box as { themeMode?: string }).themeMode).toBe('dark')
    const bad = { ...upgraded, nodes: { ...upgraded.nodes, box: { ...upgraded.nodes.box, themeMode: 'auto' } } }
    expect(() => validateFileDocument(bad, atoms)).toThrow('Invalid node theme mode')
    const extra = { ...upgraded, nodes: { ...upgraded.nodes, box: { ...upgraded.nodes.box, theme: 'dark' } } }
    expect(() => validateFileDocument(extra, atoms)).toThrow('Unsupported node field')
  })
})

describe('CC-NT-002 and CC-NT-006: stored modes through commands', () => {
  const file = () => validateFileDocument(upgradeFileDocument(v4()), atoms)
  it('a new node defaults to inherit and setThemeMode changes only that field', () => {
    const inserted = applyFileCommand(file(), { type: 'node.insert', node: { id: 'fresh', type: 'rectangle', name: 'Fresh', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 10, height: 10 } }, placement: { parentId: 'root-1' } }, atoms)
    expect(inserted.nodes.fresh).toEqual({ id: 'fresh', type: 'rectangle', name: 'Fresh', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 10, height: 10 }, themeMode: 'inherit' })
    const before = file()
    const after = applyFileCommand(before, { type: 'node.setThemeMode', nodeId: 'box', themeMode: 'dark' }, atoms)
    expect((after.nodes.box as { themeMode?: string }).themeMode).toBe('dark')
    expect(after.revision).toBe(before.revision + 1)
    const strip = (node: unknown) => JSON.parse(JSON.stringify(node, (key, value) => key === 'themeMode' ? undefined : value))
    expect(strip(after.nodes.box)).toEqual(strip(before.nodes.box))
    expect(after.theme).toEqual(before.theme)
    expect(after.relationships).toEqual(before.relationships)
    expect(after.assets).toEqual(before.assets)
    expect(Object.keys(after.nodes)).toEqual(Object.keys(before.nodes))
    expect(() => applyFileCommand(before, { type: 'node.setThemeMode', nodeId: 'root-1', themeMode: 'dark' }, atoms)).toThrow('Select an existing node')
    expect(() => applyFileCommand(before, { type: 'node.setThemeMode', nodeId: 'box', themeMode: 'system' as never }, atoms)).toThrow('Invalid node theme mode')
  })
  it('CC-NT-007: a batch over several nodes is one revision', () => {
    const before = file()
    const after = applyFileCommand(before, { type: 'batch', commands: [{ type: 'node.setThemeMode', nodeId: 'card', themeMode: 'light' }, { type: 'node.setThemeMode', nodeId: 'btn', themeMode: 'light' }] }, atoms)
    expect(after.revision).toBe(before.revision + 1)
    expect((after.nodes.card as { themeMode?: string }).themeMode).toBe('light')
    expect((after.nodes.btn as { themeMode?: string }).themeMode).toBe('light')
  })
})
