import { describe, expect, it } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, applyHostedFileCommand, createBlankFile, validateFileCommand } from '../src/file-document.js'
import type { FileCommand, FileDocument } from '../src/file-document.js'
import { hostedComponentCatalog } from '../src/hosted-catalog.js'
import type { Atom } from '../src/types.js'

const literal = { kind: 'literal', color: { kind: 'hex', hex: '#112233' } } as const
const solid = { id: 'fill-1', type: 'solid', color: literal } as const
const stroke = { color: literal, width: 1, style: 'solid' } as const
const page = { id: 'page-2', name: 'Page 2', rootNodeId: 'root-2' } as const
const node = { id: 'node-2', type: 'rectangle', name: 'Rectangle', styles: { left: 0, top: 0, width: 10, height: 10 } } as const
const token = { id: 'token-2', type: 'color', name: 'Accent', orderKey: 'V', value: literal } as const
const layout = { item: { position: { mode: 'flow' } } } as const

const commands = [
  { type: 'page.create', page, index: 0 },
  { type: 'page.rename', pageId: 'page-1', name: 'Home' },
  { type: 'page.setBackground', pageId: 'page-1', background: literal },
  { type: 'page.reorder', pageId: 'page-1', index: 0 },
  { type: 'page.delete', pageId: 'page-1' },
  { type: 'page.duplicate', pageId: 'page-1', page, ids: {} },
  { type: 'node.insert', node, placement: { parentId: 'root-1', index: 0 } },
  { type: 'node.rename', nodeId: 'node-1', name: 'Card' },
  { type: 'node.setStyles', nodeId: 'node-1', styles: { width: 20, rotation: null, flipX: true } },
  { type: 'node.setText', nodeId: 'node-1', text: 'Hello' },
  { type: 'node.setAppearance', nodeId: 'node-1', appearance: { fills: [solid] } },
  { type: 'node.setBlending', nodeId: 'node-1', visible: false, opacity: 0.5, blendMode: 'multiply' },
  { type: 'node.fill.add', nodeId: 'node-1' },
  { type: 'node.fill.update', nodeId: 'node-1', fillId: 'fill-1', paint: solid },
  { type: 'node.fill.move', nodeId: 'node-1', fillId: 'fill-1', index: 0 },
  { type: 'node.fill.remove', nodeId: 'node-1', fillId: 'fill-1' },
  { type: 'node.fill.replace', nodeId: 'node-1', fills: [solid] },
  { type: 'node.outline.set', nodeId: 'node-1', outline: { ...stroke, offset: 0 } },
  { type: 'node.borders.set', nodeId: 'node-1', borders: { all: stroke } },
  { type: 'node.border.update', nodeId: 'node-1', side: 'all', stroke },
  { type: 'node.border.remove', nodeId: 'node-1', side: 'left' },
  { type: 'asset.attach', asset: { id: 'asset-1', name: 'pixel.png', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, sha256: 'a'.repeat(64) } },
  { type: 'asset.detach', assetId: 'asset-1' },
  { type: 'node.setProps', nodeId: 'node-1', props: { label: 'Save', disabled: false }, remove: ['old'] },
  { type: 'node.setLayout', nodeId: 'node-1', layout },
  { type: 'node.setThemeMode', nodeId: 'node-1', themeMode: 'dark' },
  { type: 'node.reparent', nodeId: 'node-1', placement: { parentId: 'root-1', orderKey: 'V' }, preserveWorldPosition: true },
  { type: 'node.reorder', nodeId: 'node-1', index: 0 },
  { type: 'node.delete', nodeIds: ['node-1'] },
  { type: 'node.duplicate', nodeId: 'node-1', ids: { 'node-1': 'node-2' }, offset: { x: 10, y: -10 } },
  { type: 'token.create', token },
  { type: 'token.rename', tokenId: 'token-1', name: 'Surface' },
  { type: 'token.setValue', tokenId: 'token-1', value: literal },
  { type: 'token.setDescription', tokenId: 'token-1', description: 'Primary surface' },
  { type: 'token.reorder', tokenId: 'token-1', index: 0 },
  { type: 'token.duplicate', tokenId: 'token-1', newId: 'token-2', name: 'Copy' },
  { type: 'token.delete', tokenIds: ['token-1'], sources: { '--surface': { kind: 'hex', hex: '#112233' } } },
  { type: 'batch', commands: [{ type: 'node.rename', nodeId: 'node-1', name: 'Nested' }] },
] satisfies FileCommand[]

type MissingCommandVariant = Exclude<FileCommand['type'], typeof commands[number]['type']>
const commandVariantsAreExhaustive: MissingCommandVariant extends never ? true : false = true
void commandVariantsAreExhaustive

describe('FileCommand closed runtime schema', () => {
  it('accepts every command variant and returns a detached value', () => {
    for (const command of commands) {
      const validated = validateFileCommand(command)
      expect(validated, command.type).toEqual(command)
      expect(validated, command.type).not.toBe(command)
      expect(validateFileCommand(JSON.parse(JSON.stringify(command))), command.type).toEqual(command)
    }
    expect(new Set(commands.map(command => command.type)).size).toBe(commands.length)
  })

  it('rejects extra fields, replacement paths, prototypes, and non-JSON values', () => {
    const invalid = [
      { type: 'node.rename', nodeId: 'node-1', name: 'Card', fileId: 'forged' },
      { type: 'document.replace', document: { fileId: 'forged' } },
      { type: 'set', path: ['fileId'], value: 'forged' },
      { type: 'node.setStyles', nodeId: 'node-1', styles: { flipX: undefined } },
      { type: 'node.setStyles', nodeId: 'node-1', styles: { width: null } },
      { type: 'node.setProps', nodeId: 'node-1', props: { bad: Number.NaN } },
      { type: 'node.setProps', nodeId: 'node-1', props: { bad: 1n } },
      { type: 'node.setProps', nodeId: 'node-1', props: { bad: () => undefined } },
    ]
    for (const command of invalid) expect(() => validateFileCommand(command), String(command.type)).toThrow('Invalid file command')
    const inherited = Object.create({ type: 'node.rename' }) as Record<string, unknown>
    inherited.nodeId = 'node-1'; inherited.name = 'Card'
    expect(() => validateFileCommand(inherited)).toThrow('Invalid file command')
  })

  it('enforces nested batch count, depth, identifiers, and byte limits', () => {
    const rename = { type: 'node.rename', nodeId: 'node-1', name: 'Card' } as const
    expect(() => validateFileCommand({ type: 'batch', commands: [rename, rename] }, { maxBatchCommands: 1 })).toThrow('Invalid file command')
    expect(() => validateFileCommand({ type: 'batch', commands: [
      { type: 'batch', commands: [rename, rename] },
      { type: 'batch', commands: [rename, rename] },
    ] }, { maxBatchCommands: 3 })).toThrow('Invalid file command')
    expect(() => validateFileCommand({ type: 'batch', commands: [{ type: 'batch', commands: [rename] }] }, { maxDepth: 1 })).toThrow('Invalid file command')
    expect(() => validateFileCommand({ ...rename, nodeId: '__proto__' })).toThrow('Invalid file command')
    expect(() => validateFileCommand(rename, { maxBytes: 8 })).toThrow('Invalid file command')
  })

  it('enforces the cumulative batch budget at the public apply boundary', () => {
    const rename = { type: 'node.rename', nodeId: 'node-1', name: 'Card' } as const
    const half: FileCommand = { type: 'batch', commands: Array.from({ length: 600 }, () => rename) }
    const oversized: FileCommand = { type: 'batch', commands: [half, half] }

    expect(() => applyFileCommand(createBlankFile('file-1', 'page-1', 'root-1'), oversized, [])).toThrow('Invalid command batch')
  })
})

function hostedComponents(): FileDocument {
  const file = createBlankFile('file-1', 'page-1', 'root-1')
  file.nodes.card = { id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', props: { label: 'Card' } }
  file.relationships.card = { parentId: 'root-1', orderKey: 'V' }
  file.nodes.child = { id: 'child', type: 'component', componentId: 'button-component', exportName: 'Button', props: { label: 'Child' } }
  file.relationships.child = { parentId: 'card', slot: 'children', orderKey: 'V' }
  file.nodes.peer = { id: 'peer', type: 'component', componentId: 'button-component', exportName: 'Button', props: { label: 'Peer' } }
  file.relationships.peer = { parentId: 'root-1', orderKey: 'W' }
  return file
}

describe('hosted command component authority', () => {
  it('[COMPONENT-BINDING-SAVE-001] accepts a new component only when the hosted catalog establishes its binding', () => {
    const catalog = hostedComponentCatalog()
    for (const atom of catalog) {
      const empty = createBlankFile('file-1', 'page-1', 'root-1')
      const next = applyHostedFileCommand(empty, {
        type: 'node.insert',
        node: { id: 'placed', type: 'component', componentId: atom.componentId, exportName: atom.exportName, props: {} },
        placement: { parentId: 'root-1' },
      }, catalog)
      expect(next.nodes.placed, atom.exportName).toMatchObject({ componentId: atom.componentId, exportName: atom.exportName })
    }
  })

  it('allows only component shapes already established by the persisted document', () => {
    const file = hostedComponents()
    const next = applyHostedFileCommand(file, {
      type: 'node.insert',
      node: { id: 'copy', type: 'component', componentId: 'button-component', exportName: 'Button', props: { label: 'Copy' } },
      placement: { parentId: 'root-1' },
    })
    expect(next.nodes.copy).toMatchObject({ componentId: 'button-component', exportName: 'Button', props: { label: 'Copy' } })
  })

  it('[COMPONENT-BINDING-SAVE-001] fails closed when a command proposes a new identity, export, prop, type, or slot', () => {
    const empty = createBlankFile('file-1', 'page-1', 'root-1')
    expect(() => applyHostedFileCommand(empty, {
      type: 'node.insert',
      node: { id: 'first', type: 'component', componentId: 'new-component', exportName: 'NewComponent', props: {} },
      placement: { parentId: 'root-1' },
    })).toThrow('Component binding needs review')

    const file = hostedComponents()
    expect(() => applyHostedFileCommand(file, {
      type: 'node.insert',
      node: { id: 'copy', type: 'component', componentId: 'button-component', exportName: 'ForgedButton', props: { label: 'Copy' } },
      placement: { parentId: 'root-1' },
    })).toThrow('Component binding needs review')
    expect(() => applyHostedFileCommand(file, { type: 'node.setProps', nodeId: 'peer', props: { tone: 'danger' } })).toThrow('Unsupported value for Button.tone')
    expect(() => applyHostedFileCommand(file, { type: 'node.setProps', nodeId: 'peer', props: { label: 42 } })).toThrow('Unsupported value for Button.label')
    expect(() => applyHostedFileCommand(file, { type: 'node.reparent', nodeId: 'peer', placement: { parentId: 'card', slot: 'footer' } })).toThrow('That node cannot be placed there')
  })
})

const historyAtom: Atom = {
  componentId: 'card-component', name: 'Card', kind: 'atom', path: 'src/Card.tsx', exportName: 'Card', fingerprint: 'card', sourceHash: 'hash', status: 'bound', candidates: [], props: [],
}

function historyFile(): FileDocument {
  const file = createBlankFile('history-file', 'page-1', 'root-1')
  file.pages.push({ id: 'page-2', name: 'Page 2', rootNodeId: 'root-2', background: { kind: 'token', tokenId: 'token-a' } })
  file.nodes['root-2'] = { id: 'root-2', type: 'root' }
  file.nodes.parent = { id: 'parent', type: 'frame', name: 'Parent', styles: { left: 10, top: 20, width: 200, height: 160, overflow: 'clip' } }
  file.nodes.child = { id: 'child', type: 'rectangle', name: 'Child', styles: { left: 5, top: 6, width: 40, height: 30 }, appearance: { fills: [{ id: 'bound-fill', type: 'solid', color: { kind: 'token', tokenId: 'token-a' } }] } }
  file.nodes.card = { id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', props: {} }
  file.relationships.parent = { parentId: 'root-1', orderKey: 'V' }
  file.relationships.child = { parentId: 'parent', orderKey: 'V' }
  file.relationships.card = { parentId: 'root-1', orderKey: 'W' }
  file.theme.tokens['token-a'] = { id: 'token-a', type: 'color', name: 'Accent', orderKey: 'V', value: { kind: 'literal', color: { kind: 'hex', hex: '#123456' } } }
  file.theme.tokens['token-b'] = { id: 'token-b', type: 'color', name: 'Alias', orderKey: 'W', value: { kind: 'alias', tokenId: 'token-a' } }
  file.assets = { 'asset-1': { id: 'asset-1', name: 'pixel.png', mime: 'image/png', extension: 'png', bytes: 3, width: 1, height: 1, sha256: 'a'.repeat(64) } }
  return file
}

const withoutRevision = (file: FileDocument) => ({ ...file, revision: 0 })

describe('semantic command history', () => {
  it.each([
    ['batch', { type: 'batch', commands: [{ type: 'node.setStyles', nodeId: 'child', styles: { left: 15, rotation: 45 } }, { type: 'node.rename', nodeId: 'parent', name: 'Renamed' }] }],
    ['generated fill identity', { type: 'node.fill.add', nodeId: 'child' }],
    ['deleted subtree', { type: 'node.delete', nodeIds: ['parent'] }],
    ['deleted page', { type: 'page.delete', pageId: 'page-2' }],
    ['optional component fields', { type: 'batch', commands: [{ type: 'node.rename', nodeId: 'card', name: 'Named card' }, { type: 'node.setLayout', nodeId: 'card', layout: { item: { position: { mode: 'flow' } } } }] }],
    ['node order', { type: 'node.reorder', nodeId: 'card', index: 0 }],
    ['token order', { type: 'token.reorder', tokenId: 'token-b', index: 0 }],
    ['deleted token references', { type: 'token.delete', tokenIds: ['token-a'] }],
    ['detached asset', { type: 'asset.detach', assetId: 'asset-1' }],
  ] satisfies [string, FileCommand][])('round trips %s through reusable undo and redo commands', (_, command) => {
    const source = historyFile()
    const projected = applyFileCommandWithHistory(source, command, [historyAtom])
    expect(projected.file).toEqual(applyFileCommand(source, command, [historyAtom]))
    expect(validateFileCommand(projected.undo)).toEqual(projected.undo)
    expect(validateFileCommand(projected.redo)).toEqual(projected.redo)
    const undone = applyFileCommand(projected.file, projected.undo, [historyAtom])
    expect(withoutRevision(undone)).toEqual(withoutRevision(source))
    const redone = applyFileCommand(undone, projected.redo, [historyAtom])
    expect(withoutRevision(redone)).toEqual(withoutRevision(projected.file))
    const undoneAgain = applyFileCommand(redone, projected.undo, [historyAtom])
    expect(withoutRevision(undoneAgain)).toEqual(withoutRevision(source))
  })

  it('canonicalizes an implicit fill once so redo never invents another identity', () => {
    const source = historyFile()
    const projected = applyFileCommandWithHistory(source, { type: 'node.fill.add', nodeId: 'child' }, [historyAtom])
    expect(projected.redo).toMatchObject({ type: 'node.fill.add', nodeId: 'child', paint: { id: 'fill:1:2' } })
  })
})
