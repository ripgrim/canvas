import { describe, expect, it } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, fileSchemaVersion } from '@canvas/repo-engine/file-document'
import type { FileDocument, PrimitiveNode } from '@canvas/repo-engine/file-document'
import { createInternalClipboardPayload, planCrossFileInternalPaste, planSameFileInternalPaste, planValidatedInternalPaste, planValidatedInternalReplace } from './clipboard-internal'

const fixture = (): FileDocument => ({
  schemaVersion: fileSchemaVersion,
  fileId: 'file',
  revision: 4,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    outer: { id: 'outer', type: 'frame', name: 'Outer', styles: { relativeTransform: [1, 0, 0, 1, 100, 50], width: 300, height: 200, overflow: 'clip' } },
    child: { id: 'child', type: 'rectangle', name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 40, height: 20 }, appearance: { fills: [
      { id: 'color', type: 'solid', color: { kind: 'token', tokenId: 'alias' } },
      { id: 'image', type: 'image', assetId: 'asset', fit: 'cover' },
    ] } },
  },
  relationships: {
    outer: { parentId: 'root', orderKey: 'V' },
    child: { parentId: 'outer', orderKey: 'V' },
  },
  theme: { tokens: {
    base: { id: 'base', type: 'color', name: 'Base', orderKey: 'V', value: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } },
    alias: { id: 'alias', type: 'color', name: 'Alias', orderKey: 'W', value: { kind: 'alias', tokenId: 'base' } },
  } },
  assets: { asset: { id: 'asset', name: 'Photo', mime: 'image/png', extension: 'png', bytes: 4, width: 1, height: 1, sha256: 'a'.repeat(64) } },
  componentModel: { definitions: {}, instances: {} },
})

describe('PAPER-CLIP-003 internal copy closure', () => {
  it('normalizes a nested root to world geometry and includes transitive token and image metadata', () => {
    const payload = createInternalClipboardPayload(fixture(), 'page', ['child'])
    expect(payload.roots).toEqual(['child'])
    expect(payload.nodes.child).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 120, 80] } })
    expect(payload.relationships).toEqual({})
    expect(Object.keys(payload.tokens)).toEqual(['alias', 'base'])
    expect(payload.assets).toEqual({ asset: fixture().assets!.asset })
  })

  it('collapses descendant selections under their selected ancestor', () => {
    const payload = createInternalClipboardPayload(fixture(), 'page', ['child', 'outer'])
    expect(payload.roots).toEqual(['outer'])
    expect(Object.keys(payload.nodes)).toEqual(['outer', 'child'])
    expect(payload.relationships.child).toEqual({ parentId: 'outer', orderKey: 'V' })
  })

  it('detaches a flow child as a freeform root without losing its world position', () => {
    const file = fixture()
    ;(file.nodes.outer as PrimitiveNode).layout = { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } }
    ;(file.nodes.child as PrimitiveNode).layout = { item: { position: { mode: 'flow' } } }
    const payload = createInternalClipboardPayload(file, 'page', ['child'])
    expect(payload.nodes.child).toMatchObject({
      styles: { relativeTransform: [1, 0, 0, 1, 120, 80] },
      layout: { item: { position: { mode: 'freeform' } } },
    })
  })

  it('rejects canvas component identities until definitions can be duplicated safely', () => {
    const file = fixture()
    file.componentModel = { definitions: { button: {
      id: 'button', name: 'Button', source: { kind: 'canvas', masterRootId: 'outer' }, revision: 1, properties: [], materials: [], parts: [], interactions: [],
    } }, instances: {} }
    expect(() => createInternalClipboardPayload(file, 'page', ['outer'])).toThrow('canvas component identity')
  })
})

describe('PAPER-CLIP-004 same-file internal paste', () => {
  it('plans one atomic batch, preserves subtree geometry, offsets roots, and has an exact inverse', () => {
    const file = fixture()
    const payload = createInternalClipboardPayload(file, 'page', ['outer'])
    let id = 0
    const plan = planSameFileInternalPaste(file, 'page', payload, () => `paste-${++id}`)
    const history = applyFileCommandWithHistory(file, plan.command, [], { allowUnavailableBindings: true })
    expect(plan.selection).toEqual(['paste-1'])
    expect(history.file.nodes['paste-1']).toMatchObject({ type: 'frame', styles: { relativeTransform: [1, 0, 0, 1, 420, 50] } })
    expect(history.file.nodes['paste-2']).toMatchObject({ type: 'rectangle', styles: { relativeTransform: [1, 0, 0, 1, 20, 30] } })
    expect(history.file.relationships['paste-2']?.parentId).toBe('paste-1')
    const restored = applyFileCommand(history.file, history.undo, [], { allowUnavailableBindings: true })
    expect({ ...restored, revision: file.revision }).toStrictEqual(file)
  })

  it('rejects cross-file, stale-token, stale-image, and colliding identity plans', () => {
    const file = fixture()
    const payload = createInternalClipboardPayload(file, 'page', ['child'])
    expect(() => planSameFileInternalPaste({ ...file, fileId: 'other' }, 'page', payload, () => 'new')).toThrow('Cross-file')
    const staleToken = structuredClone(file)
    staleToken.theme.tokens.alias!.name = 'Changed'
    expect(() => planSameFileInternalPaste(staleToken, 'page', payload, () => 'new')).toThrow('token changed')
    const staleImage = structuredClone(file)
    staleImage.assets!.asset!.sha256 = 'b'.repeat(64)
    expect(() => planSameFileInternalPaste(staleImage, 'page', payload, () => 'new')).toThrow('image changed')
    expect(() => planSameFileInternalPaste(file, 'page', payload, () => 'child')).toThrow('unique')
  })

  it('uses an explicit zero offset for Paste on top', () => {
    const file = fixture()
    const payload = createInternalClipboardPayload(file, 'page', ['outer'])
    let id = 0
    const plan = planSameFileInternalPaste(file, 'page', payload, () => `top-${++id}`, { offset: { x: 0, y: 0 } })
    const result = applyFileCommand(file, plan.command, [], { allowUnavailableBindings: true })
    expect(result.nodes[plan.ids.outer!]).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 100, 50] } })
  })

  it('moves every pasted root by one group offset without changing their spacing', () => {
    const file = fixture()
    file.nodes.sibling = { id: 'sibling', type: 'rectangle', name: 'Sibling', styles: { relativeTransform: [1, 0, 0, 1, 500, 60], width: 10, height: 10 } }
    file.relationships.sibling = { parentId: 'root', orderKey: 'W' }
    const payload = createInternalClipboardPayload(file, 'page', ['outer', 'sibling'])
    let id = 0
    const plan = planSameFileInternalPaste(file, 'page', payload, () => `group-${++id}`)
    const result = applyFileCommand(file, plan.command, [], { allowUnavailableBindings: true })
    const outer = result.nodes[plan.ids.outer!] as PrimitiveNode
    const sibling = result.nodes[plan.ids.sibling!] as PrimitiveNode
    expect(outer.styles.relativeTransform).toEqual([1, 0, 0, 1, 530, 50])
    expect(sibling.styles.relativeTransform).toEqual([1, 0, 0, 1, 930, 60])
    expect(sibling.styles.relativeTransform[4] - outer.styles.relativeTransform[4]).toBe(400)
  })

  it('climbs from an unsupported selected layer and preserves world placement in the nearest compatible frame', () => {
    const file = fixture()
    const payload = createInternalClipboardPayload(file, 'page', ['child'])
    let id = 0
    const plan = planSameFileInternalPaste(file, 'page', payload, () => `nested-${++id}`, {}, ['child'])
    const result = applyFileCommand(file, plan.command, [], { allowUnavailableBindings: true })
    expect(result.relationships[plan.ids.child!]?.parentId).toBe('outer')
    expect(result.nodes[plan.ids.child!]).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 80, 30] } })
  })

  it('centers a dropped internal tree on the pointer as one semantic batch', () => {
    const file = fixture()
    const payload = createInternalClipboardPayload(file, 'page', ['child'])
    let id = 0
    const plan = planSameFileInternalPaste(file, 'page', payload, () => `drop-${++id}`, { center: { x: 0, y: 0 } })
    const result = applyFileCommand(file, plan.command, [], { allowUnavailableBindings: true })
    expect(result.relationships[plan.ids.child!]?.parentId).toBe('root')
    expect(result.nodes[plan.ids.child!]).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, -20, -10] } })
  })
})

describe('PAPER-CLIP-004 and PAPER-CLIP-006 cross-file internal paste', () => {
  const withoutImage = () => {
    const file = fixture()
    const child = file.nodes.child as PrimitiveNode
    child.appearance = { fills: [child.appearance!.fills![0]!] }
    delete file.assets
    return file
  }

  it('reuses byte-identical tokens and inserts the tree as one exact undoable batch', () => {
    const source = withoutImage()
    const payload = createInternalClipboardPayload(source, 'page', ['outer'])
    const target = { ...withoutImage(), fileId: 'target-file' }
    let id = 0
    const plan = planValidatedInternalPaste(target, 'page', payload, () => `paste-${++id}`)
    const history = applyFileCommandWithHistory(target, plan.command, [], { allowUnavailableBindings: true })
    expect(plan.selection).toEqual([plan.ids.outer])
    expect(history.file.nodes[plan.ids.outer!]).toMatchObject({ type: 'frame', styles: { relativeTransform: [1, 0, 0, 1, 420, 50] } })
    expect(history.file.nodes[plan.ids.child!]).toMatchObject({ appearance: { fills: [{ color: { kind: 'token', tokenId: 'alias' } }] } })
    expect(Object.keys(history.file.theme.tokens)).toEqual(Object.keys(target.theme.tokens))
    const restored = applyFileCommand(history.file, history.undo, [], { allowUnavailableBindings: true })
    expect({ ...restored, revision: target.revision }).toStrictEqual(target)
  })

  it('imports a conflicting token closure under fresh identities before inserting nodes', () => {
    const source = withoutImage()
    const payload = createInternalClipboardPayload(source, 'page', ['outer'])
    const target = { ...withoutImage(), fileId: 'target-file' }
    target.theme.tokens.base!.value = { kind: 'literal', color: { kind: 'hex', hex: '#000000' } }
    let id = 0
    const plan = planCrossFileInternalPaste(target, 'page', payload, () => `cross-${++id}`)
    const result = applyFileCommand(target, plan.command, [], { allowUnavailableBindings: true })
    const pasted = result.nodes[plan.ids.child!] as PrimitiveNode
    const aliasId = pasted.appearance!.fills![0]!.type === 'solid' && pasted.appearance!.fills![0]!.color.kind === 'token'
      ? pasted.appearance!.fills![0]!.color.tokenId
      : ''
    expect(aliasId).not.toBe('alias')
    const importedAlias = result.theme.tokens[aliasId]!
    expect(importedAlias.value.kind).toBe('alias')
    const baseId = importedAlias.value.kind === 'alias' ? importedAlias.value.tokenId : ''
    expect(baseId).not.toBe('base')
    expect(result.theme.tokens[baseId]).toMatchObject({ value: { kind: 'literal', color: { hex: '#ffffff' } } })
    expect(result.theme.tokens.base).toMatchObject({ value: { kind: 'literal', color: { hex: '#000000' } } })
  })

  it('rejects cross-file image metadata until verified source bytes are available', () => {
    const payload = createInternalClipboardPayload(fixture(), 'page', ['child'])
    expect(() => planCrossFileInternalPaste({ ...fixture(), fileId: 'target-file' }, 'page', payload, () => 'new')).toThrow('verified source bytes')
  })

  it('attaches verified cross-file assets, remaps image fills, and undoes the complete batch', () => {
    const source = fixture()
    const payload = createInternalClipboardPayload(source, 'page', ['child'])
    const target = { ...withoutImage(), fileId: 'target-file' }
    const imported = { ...source.assets!.asset!, id: 'imported-asset' }
    let id = 0
    const plan = planCrossFileInternalPaste(target, 'page', payload, () => `image-paste-${++id}`, {}, [], [], { asset: imported })
    const history = applyFileCommandWithHistory(target, plan.command, [], { allowUnavailableBindings: true })
    const pasted = history.file.nodes[plan.selection[0]!] as PrimitiveNode
    expect(history.file.assets?.['imported-asset']).toStrictEqual(imported)
    expect(pasted.appearance?.fills?.find(fill => fill.type === 'image')).toMatchObject({ assetId: 'imported-asset' })
    const restored = applyFileCommand(history.file, history.undo, [], { allowUnavailableBindings: true })
    expect({ ...restored, revision: target.revision }).toStrictEqual(target)
  })
})

describe('PAPER-CLIP-007 Paste to replace', () => {
  const geometry = (file: FileDocument, nodes: Record<string, { x: number; y: number; width: number; height: number }>, layoutGeneration = 3) => ({
    documentRevision: file.revision,
    layoutGeneration,
    expectedLayoutGeneration: layoutGeneration,
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, rect]) => [id, { documentRevision: file.revision, layoutGeneration, rect, worldAabb: rect }])),
  })

  it('replaces one freeform root at its measured bounds in one exact undoable batch', () => {
    const file = fixture()
    const payload = createInternalClipboardPayload(file, 'page', ['child'])
    let id = 0
    const plan = planValidatedInternalReplace(file, 'page', payload, ['outer'], () => `replace-${++id}`, geometry(file, { outer: { x: 100, y: 50, width: 300, height: 200 } }))
    const history = applyFileCommandWithHistory(file, plan.command, [], { allowUnavailableBindings: true })
    expect(plan.selection).toEqual(['replace-1'])
    expect(history.file.nodes.outer).toBeUndefined()
    expect(history.file.nodes.child).toBeUndefined()
    expect(history.file.nodes['replace-1']).toMatchObject({ type: 'rectangle', styles: { relativeTransform: [1, 0, 0, 1, 100, 50] } })
    expect(history.file.relationships['replace-1']).toMatchObject({ parentId: 'root' })
    const restored = applyFileCommand(history.file, history.undo, [], { allowUnavailableBindings: true })
    expect({ ...restored, revision: file.revision }).toStrictEqual(file)
  })

  it('clones the clipboard once per selected flow root and preserves their parent positions', () => {
    const file = fixture()
    delete (file.nodes.child as PrimitiveNode).appearance
    delete file.assets
    file.nodes.template = { id: 'template', type: 'rectangle', name: 'Template', styles: { relativeTransform: [1, 0, 0, 1, 20, 10], width: 30, height: 12 }, layout: { item: { position: { mode: 'freeform' } } } }
    file.nodes.flex = { id: 'flex', type: 'frame', name: 'Flex', styles: { relativeTransform: [1, 0, 0, 1, 500, 0], width: 200, height: 80 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } } } }
    file.nodes.a = { id: 'a', type: 'rectangle', name: 'A', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 20, height: 20 }, layout: { item: { position: { mode: 'flow' } } } }
    file.nodes.b = { id: 'b', type: 'rectangle', name: 'B', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 20, height: 20 }, layout: { item: { position: { mode: 'flow' } } } }
    file.relationships.template = { parentId: 'root', orderKey: 'X' }
    file.relationships.flex = { parentId: 'root', orderKey: 'Y' }
    file.relationships.a = { parentId: 'flex', orderKey: 'A' }
    file.relationships.b = { parentId: 'flex', orderKey: 'B' }
    const payload = createInternalClipboardPayload(file, 'page', ['template'])
    let id = 0
    const plan = planValidatedInternalReplace(file, 'page', payload, ['a', 'b'], () => `flow-${++id}`, geometry(file, {}))
    const result = applyFileCommand(file, plan.command, [], { allowUnavailableBindings: true })
    expect(plan.selection).toEqual(['flow-1', 'flow-2'])
    expect(result.nodes.a).toBeUndefined()
    expect(result.nodes.b).toBeUndefined()
    expect(result.relationships['flow-1']).toMatchObject({ parentId: 'flex' })
    expect(result.relationships['flow-2']).toMatchObject({ parentId: 'flex' })
    expect((result.nodes['flow-1'] as PrimitiveNode).layout?.item.position.mode).toBe('flow')
    expect((result.nodes['flow-2'] as PrimitiveNode).layout?.item.position.mode).toBe('flow')
  })

  it('rejects stale geometry before replacing a measured target', () => {
    const file = fixture()
    const payload = createInternalClipboardPayload(file, 'page', ['child'])
    const stale = geometry(file, { outer: { x: 100, y: 50, width: 300, height: 200 } })
    expect(() => planValidatedInternalReplace(file, 'page', payload, ['outer'], () => 'replace', { ...stale, documentRevision: file.revision - 1 })).toThrow('current canvas measurements')
  })

  it('reconciles a verified cross-file image before replacing the target in one reversible batch', () => {
    const source = fixture()
    const payload = createInternalClipboardPayload(source, 'page', ['child'])
    const target = structuredClone(source)
    target.fileId = 'target-file'
    delete target.assets
    const targetChild = target.nodes.child as PrimitiveNode
    targetChild.appearance = { fills: [targetChild.appearance!.fills![0]!] }
    const imported = { ...source.assets!.asset!, id: 'replacement-asset' }
    let id = 0
    const plan = planValidatedInternalReplace(target, 'page', payload, ['outer'], () => `replace-image-${++id}`, geometry(target, { outer: { x: 100, y: 50, width: 300, height: 200 } }), [], { asset: imported })
    const history = applyFileCommandWithHistory(target, plan.command, [], { allowUnavailableBindings: true })
    const replacement = history.file.nodes[plan.selection[0]!] as PrimitiveNode
    expect(history.file.nodes.outer).toBeUndefined()
    expect(replacement.appearance?.fills?.find(fill => fill.type === 'image')).toMatchObject({ assetId: imported.id })
    const restored = applyFileCommand(history.file, history.undo, [], { allowUnavailableBindings: true })
    expect({ ...restored, revision: target.revision }).toStrictEqual(target)
  })
})
