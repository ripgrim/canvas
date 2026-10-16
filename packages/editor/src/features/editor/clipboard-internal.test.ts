import { describe, expect, it } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, fileSchemaVersion } from '@canvas/repo-engine/file-document'
import type { FileDocument, PrimitiveNode } from '@canvas/repo-engine/file-document'
import { validateInternalClipboardPayload } from './clipboard-codec'
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

const componentFixture = (): FileDocument => ({
  schemaVersion: fileSchemaVersion,
  fileId: 'component-file',
  revision: 9,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    'icon-master': { id: 'icon-master', type: 'frame', name: 'Icon', styles: { relativeTransform: [1, 0, 0, 1, 20, 20], width: 20, height: 20, overflow: 'visible' }, appearance: {} },
    'icon-shape': { id: 'icon-shape', type: 'rectangle', name: 'Shape', styles: { relativeTransform: [1, 0, 0, 1, 2, 2], width: 16, height: 16 }, appearance: {} },
    'badge-master': { id: 'badge-master', type: 'frame', name: 'Badge', styles: { relativeTransform: [1, 0, 0, 1, 50, 20], width: 20, height: 20, overflow: 'visible' }, appearance: {} },
    'badge-shape': { id: 'badge-shape', type: 'rectangle', name: 'Badge shape', styles: { relativeTransform: [1, 0, 0, 1, 1, 1], width: 18, height: 18 }, appearance: {} },
    'button-master': { id: 'button-master', type: 'frame', name: 'Button', styles: { relativeTransform: [1, 0, 0, 1, 100, 40], width: 100, height: 40, overflow: 'visible' }, appearance: {} },
    face: { id: 'face', type: 'rectangle', name: 'Face', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 40 }, appearance: { fills: [{ id: 'face-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#0055ff' } } }] } },
    'icon-use': { id: 'icon-use', type: 'frame', name: 'Icon', styles: { relativeTransform: [1, 0, 0, 1, 72, 10], width: 20, height: 20, overflow: 'visible' }, appearance: {} },
    'icon-use-shape': { id: 'icon-use-shape', type: 'rectangle', name: 'Shape', styles: { relativeTransform: [1, 0, 0, 1, 2, 2], width: 16, height: 16 }, appearance: {} },
    'button-instance': { id: 'button-instance', type: 'frame', name: 'Button', styles: { relativeTransform: [1, 0, 0, 1, 100, 120], width: 100, height: 40, overflow: 'visible' }, appearance: {} },
    'instance-face': { id: 'instance-face', type: 'rectangle', name: 'Face', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 40 }, appearance: { opacity: 0.7 } },
    'instance-icon': { id: 'instance-icon', type: 'frame', name: 'Icon', styles: { relativeTransform: [1, 0, 0, 1, 72, 10], width: 20, height: 20, overflow: 'visible' }, appearance: {} },
    'instance-icon-shape': { id: 'instance-icon-shape', type: 'rectangle', name: 'Shape', styles: { relativeTransform: [1, 0, 0, 1, 2, 2], width: 16, height: 16 }, appearance: {} },
    slot: { id: 'slot', type: 'rectangle', name: 'Slot content', styles: { relativeTransform: [1, 0, 0, 1, 8, 44], width: 84, height: 12 }, appearance: {} },
  },
  relationships: {
    'icon-master': { parentId: 'root', orderKey: 'A' }, 'icon-shape': { parentId: 'icon-master', orderKey: 'A' }, 'badge-master': { parentId: 'root', orderKey: 'B' }, 'badge-shape': { parentId: 'badge-master', orderKey: 'A' },
    'button-master': { parentId: 'root', orderKey: 'C' }, face: { parentId: 'button-master', orderKey: 'A' }, 'icon-use': { parentId: 'button-master', orderKey: 'B' }, 'icon-use-shape': { parentId: 'icon-use', orderKey: 'A' },
    'button-instance': { parentId: 'root', orderKey: 'D' }, 'instance-face': { parentId: 'button-instance', orderKey: 'A' }, 'instance-icon': { parentId: 'button-instance', orderKey: 'B' }, 'instance-icon-shape': { parentId: 'instance-icon', orderKey: 'A' }, slot: { parentId: 'button-instance', orderKey: 'C', slot: 'content' },
  },
  theme: { tokens: {} },
  componentModel: {
    definitions: {
      icon: { id: 'icon', name: 'Icon', source: { kind: 'canvas', masterRootId: 'icon-master' }, revision: 2, properties: [], materials: [], parts: [], interactions: [] },
      badge: { id: 'badge', name: 'Badge', source: { kind: 'canvas', masterRootId: 'badge-master' }, revision: 1, properties: [], materials: [], parts: [], interactions: [] },
      button: {
        id: 'button', name: 'Button', source: { kind: 'canvas', masterRootId: 'button-master' }, revision: 4,
        properties: [
          { id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', currentValueId: 'default', values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }], binding: { kind: 'variant', nodeId: 'face', appearances: { default: {}, hover: { opacity: 0.7 } } } },
          { id: 'visible', name: 'Visible', type: 'boolean', defaultValue: true, binding: { kind: 'visibility', nodeId: 'face' } },
          { id: 'content', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'button-master' } },
          { id: 'icon-property', name: 'Icon', type: 'instance-swap', defaultValue: 'icon', binding: { kind: 'instance-swap', nodeId: 'icon-use' } },
        ],
        materials: [{ id: 'surface', group: 'Interaction', name: 'Surface', appearance: { opacity: 0.9 } }],
        parts: [{ id: 'face-part', name: 'Face', nodeId: 'face', materialId: 'surface' }],
        interactions: [{ id: 'hover-interaction', trigger: 'pointer-hover', propertyId: 'state', valueId: 'hover' }],
        variantAppearances: { face: { 'state=default': {}, 'state=hover': { opacity: 0.7 } } },
      },
    },
    instances: {
      'icon-use': { id: 'icon-use', componentId: 'icon', values: {} },
      'button-instance': { id: 'button-instance', componentId: 'button', values: { state: 'hover', visible: false, 'icon-property': 'badge' } },
      'instance-icon': { id: 'instance-icon', componentId: 'badge', values: {} },
    },
  },
})

const componentFixtureWithLooseRoot = (): FileDocument => {
  const file = componentFixture()
  file.nodes.loose = { id: 'loose', type: 'rectangle', name: 'Loose', styles: { relativeTransform: [1, 0, 0, 1, 260, 60], width: 20, height: 20 }, appearance: {} }
  file.relationships.loose = { parentId: 'root', orderKey: 'E' }
  return file
}

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

  it('[COMP-V2-UI-078] captures the exact same-file semantic closure for a canvas master and configured instance', () => {
    const file = componentFixture()
    const master = createInternalClipboardPayload(file, 'page', ['button-master'])
    expect(master.roots).toEqual(['button-master'])
    expect(Object.keys(master.nodes)).toEqual(['button-master', 'face', 'icon-use', 'icon-use-shape'])
    expect(master.componentModel).toEqual({
      definitions: { button: file.componentModel.definitions.button, icon: file.componentModel.definitions.icon },
      instances: { 'icon-use': { id: 'icon-use', componentId: 'icon', values: {} } },
    })
    const instance = createInternalClipboardPayload(file, 'page', ['button-instance'])
    expect(instance.roots).toEqual(['button-instance'])
    expect(instance.componentModel).toEqual({
      definitions: { button: file.componentModel.definitions.button, badge: file.componentModel.definitions.badge, icon: file.componentModel.definitions.icon },
      instances: {
        'button-instance': { id: 'button-instance', componentId: 'button', values: { state: 'hover', visible: false, 'icon-property': 'badge' } },
        'instance-icon': { id: 'instance-icon', componentId: 'badge', values: {} },
      },
    })
  })
})

describe('PAPER-CLIP-004 same-file internal paste', () => {
  it('[COMP-V2-UI-078] routes a master and configured instance through the semantic duplicate planner as one batch', () => {
    const source = componentFixture()
    let masterId = 0
    const masterPayload = createInternalClipboardPayload(source, 'page', ['button-master'])
    const masterPlan = planSameFileInternalPaste(source, 'page', masterPayload, () => `master-${++masterId}`)
    const masterHistory = applyFileCommandWithHistory(source, masterPlan.command, [], { allowUnavailableBindings: true })
    expect(masterPlan.selection).toEqual(['master-1'])
    expect(masterPlan.componentSemantic).toBe(true)
    expect(masterPlan.command.type).toBe('batch')
    expect(masterHistory.file.nodes['master-1']).toMatchObject({ id: 'master-1', name: 'Button copy', styles: { relativeTransform: [1, 0, 0, 1, 220, 40] } })
    expect(masterHistory.file.componentModel.definitions['master-5']).toEqual({
      id: 'master-5', name: 'Button copy', source: { kind: 'canvas', masterRootId: 'master-1' }, revision: 0,
      properties: [
        { id: 'master-6', name: 'State', type: 'variant', defaultValueId: 'master-7', currentValueId: 'master-7', values: [{ id: 'master-7', name: 'Default' }, { id: 'master-8', name: 'Hover' }], binding: { kind: 'variant', nodeId: 'master-2', appearances: { 'master-7': {}, 'master-8': { opacity: 0.7 } } } },
        { id: 'master-9', name: 'Visible', type: 'boolean', defaultValue: true, binding: { kind: 'visibility', nodeId: 'master-2' } },
        { id: 'master-10', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'master-1' } },
        { id: 'master-11', name: 'Icon', type: 'instance-swap', defaultValue: 'icon', binding: { kind: 'instance-swap', nodeId: 'master-3' } },
      ],
      materials: [{ id: 'master-12', group: 'Interaction', name: 'Surface', appearance: { opacity: 0.9 } }],
      parts: [{ id: 'master-13', name: 'Face', nodeId: 'master-2', materialId: 'master-12' }],
      interactions: [{ id: 'master-14', trigger: 'pointer-hover', propertyId: 'master-6', valueId: 'master-8' }],
      variantAppearances: { 'master-2': { 'master-6=master-7': {}, 'master-6=master-8': { opacity: 0.7 } } },
      docs: { slug: 'button-copy' },
    })
    expect(masterHistory.file.componentModel.instances['master-3']).toEqual({ id: 'master-3', componentId: 'icon', values: {} })
    expect({ ...applyFileCommand(masterHistory.file, masterHistory.undo, [], { allowUnavailableBindings: true }), revision: source.revision }).toEqual(source)

    let instanceId = 0
    const instancePayload = createInternalClipboardPayload(source, 'page', ['button-instance'])
    const instancePlan = planSameFileInternalPaste(source, 'page', instancePayload, () => `instance-${++instanceId}`)
    expect(instancePlan.componentSemantic).toBe(true)
    const instanceResult = applyFileCommand(source, instancePlan.command, [], { allowUnavailableBindings: true })
    expect(instancePlan.selection).toEqual(['instance-1'])
    expect(instanceResult.componentModel.instances['instance-1']).toEqual({ id: 'instance-1', componentId: 'button', values: { state: 'hover', visible: false, 'icon-property': 'badge' } })
    expect(instanceResult.componentModel.instances['instance-3']).toEqual({ id: 'instance-3', componentId: 'badge', values: {} })
    expect(instanceResult.nodes['instance-5']).toMatchObject({ id: 'instance-5', name: 'Slot content', styles: { relativeTransform: [1, 0, 0, 1, 8, 44] } })
    expect(instanceResult.relationships['instance-5']).toEqual({ parentId: 'instance-1', orderKey: 'C', slot: 'content' })
  })

  it('[COMP-V2-UI-078] preserves semantic masters and generic roots together in deterministic source order', () => {
    const source = componentFixtureWithLooseRoot()
    const payload = createInternalClipboardPayload(source, 'page', ['loose', 'button-master'])
    expect(payload.roots).toEqual(['button-master', 'loose'])
    let index = 0
    const plan = planSameFileInternalPaste(source, 'page', payload, () => `mixed-${++index}`)
    const history = applyFileCommandWithHistory(source, plan.command, [], { allowUnavailableBindings: true })
    expect(plan.componentSemantic).toBe(true)
    expect(plan.command.type).toBe('batch')
    expect(plan.selection).toEqual([plan.ids['button-master'], plan.ids.loose])
    expect(history.file.nodes[plan.ids['button-master']!]).toMatchObject({ name: 'Button copy', styles: { relativeTransform: [1, 0, 0, 1, 300, 40] } })
    expect(history.file.nodes[plan.ids.loose!]).toMatchObject({ name: 'Loose', styles: { relativeTransform: [1, 0, 0, 1, 460, 60] } })
    const copiedDefinition = Object.values(history.file.componentModel.definitions).find(definition => definition.source.kind === 'canvas' && definition.source.masterRootId === plan.ids['button-master'])
    expect(copiedDefinition).toMatchObject({ name: 'Button copy', revision: 0 })
    expect({ ...applyFileCommand(history.file, history.undo, [], { allowUnavailableBindings: true }), revision: source.revision }).toEqual(source)
  })

  it('[COMP-V2-UI-078] semantically plans multiple component roots and an instance plus primitive without flattening', () => {
    const source = componentFixtureWithLooseRoot()
    const masters = createInternalClipboardPayload(source, 'page', ['button-master', 'icon-master'])
    expect(masters.roots).toEqual(['icon-master', 'button-master'])
    let masterIndex = 0
    const masterPlan = planSameFileInternalPaste(source, 'page', masters, () => `many-${++masterIndex}`)
    const masterResult = applyFileCommand(source, masterPlan.command, [], { allowUnavailableBindings: true })
    expect(masterPlan.selection).toEqual([masterPlan.ids['icon-master'], masterPlan.ids['button-master']])
    expect(Object.values(masterResult.componentModel.definitions).filter(definition => definition.name.endsWith(' copy')).map(definition => definition.name)).toEqual(['Icon copy', 'Button copy'])
    expect(Object.values(masterResult.componentModel.instances).some(instance => instance.id === masterPlan.ids['icon-use'] && instance.componentId === 'icon')).toBe(true)

    const configured = createInternalClipboardPayload(source, 'page', ['loose', 'button-instance'])
    expect(configured.roots).toEqual(['button-instance', 'loose'])
    let instanceIndex = 0
    const instancePlan = planSameFileInternalPaste(source, 'page', configured, () => `configured-${++instanceIndex}`)
    const instanceResult = applyFileCommand(source, instancePlan.command, [], { allowUnavailableBindings: true })
    expect(instancePlan.selection).toEqual([instancePlan.ids['button-instance'], instancePlan.ids.loose])
    expect(instanceResult.componentModel.instances[instancePlan.ids['button-instance']!]).toEqual({ id: instancePlan.ids['button-instance'], componentId: 'button', values: { state: 'hover', visible: false, 'icon-property': 'badge' } })
    expect(instanceResult.componentModel.instances[instancePlan.ids['instance-icon']!]).toEqual({ id: instancePlan.ids['instance-icon'], componentId: 'badge', values: {} })
    expect(instanceResult.relationships[instancePlan.ids.slot!]).toMatchObject({ parentId: instancePlan.ids['button-instance'], slot: 'content' })
    expect(instanceResult.nodes[instancePlan.ids.loose!]).toMatchObject({ name: 'Loose' })
  })

  it('[COMP-V2-UI-NEG-005] rejects stale, malformed, recursive, colliding, oversized, and cross-file canvas component payloads', () => {
    const file = componentFixture()
    const payload = createInternalClipboardPayload(file, 'page', ['button-master'])
    const before = structuredClone(file)
    const malformed = [
      (value: any) => { value.componentModel.definitions.button.properties[0].binding.nodeId = 'missing' },
      (value: any) => { delete value.componentModel.definitions.button.variantAppearances.face['state=hover'] },
      (value: any) => { value.componentModel.instances['icon-use'].componentId = 'missing' },
      (value: any) => { value.componentModel.definitions.button.properties[3].defaultValue = 'button' },
      (value: any) => { value.relationships.face.parentId = 'missing' },
    ]
    for (const mutate of malformed) {
      const candidate = structuredClone(payload) as any
      mutate(candidate)
      expect(() => validateInternalClipboardPayload(candidate)).toThrow()
    }
    const changedRevision = structuredClone(payload) as any
    changedRevision.componentModel.definitions.button.revision = 5
    expect(() => planSameFileInternalPaste(file, 'page', validateInternalClipboardPayload(changedRevision), () => 'fresh')).toThrow('component changed')
    const changedPhysicalGraph = structuredClone(payload) as any
    changedPhysicalGraph.nodes.face.appearance = { opacity: 0.2 }
    expect(() => planSameFileInternalPaste(file, 'page', validateInternalClipboardPayload(changedPhysicalGraph), () => 'fresh')).toThrow('graph changed')
    expect(() => planSameFileInternalPaste(file, 'page', payload, () => 'root')).toThrow('graph changed')
    expect(() => planSameFileInternalPaste({ ...file, revision: 10 }, 'page', payload, () => 'fresh')).toThrow('context changed')
    expect(() => planValidatedInternalPaste({ ...file, fileId: 'other-file' }, 'page', payload, () => 'fresh')).toThrow('Cross-file canvas component identity')
    const oversized = structuredClone(payload) as any
    oversized.nodes = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`node-${index}`, { id: `node-${index}`, type: 'rectangle', name: 'Node', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 } }]))
    expect(() => validateInternalClipboardPayload(oversized)).toThrow('node limit')
    expect(file).toEqual(before)
  })

  it('[COMP-V2-UI-NEG-005] rejects stale bytes for a mixed semantic payload and fails Paste to replace closed', () => {
    const file = componentFixtureWithLooseRoot()
    const payload = createInternalClipboardPayload(file, 'page', ['button-master', 'loose'])
    const before = structuredClone(file)
    const stale = structuredClone(payload) as any
    stale.nodes.loose.appearance = { opacity: 0.4 }
    expect(() => planSameFileInternalPaste(file, 'page', validateInternalClipboardPayload(stale), () => 'fresh')).toThrow('graph changed')
    let generated = 0
    expect(() => planValidatedInternalReplace(file, 'page', payload, ['loose'], () => { generated += 1; return `replace-${generated}` }, {
      documentRevision: file.revision, layoutGeneration: 2, expectedLayoutGeneration: 2,
      nodes: { loose: { documentRevision: file.revision, layoutGeneration: 2, rect: { x: 260, y: 60, width: 20, height: 20 } } },
    })).toThrow('does not support canvas component identity')
    expect(generated).toBe(0)
    expect(file).toEqual(before)
  })

  it('plans one atomic batch, preserves subtree geometry, offsets roots, and has an exact inverse', () => {
    const file = fixture()
    const payload = createInternalClipboardPayload(file, 'page', ['outer'])
    let id = 0
    const plan = planSameFileInternalPaste(file, 'page', payload, () => `paste-${++id}`)
    expect(plan.componentSemantic).toBe(false)
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
