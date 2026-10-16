import { describe, expect, it } from 'vitest'
import type { ComponentDefinition } from '@canvas/repo-engine/component-model'
import { applyFileCommand, createBlankFile, descendantsOf } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { eligibleInstanceSwapComponents, planComponentInstanceSwap } from './component-instance-swap'

function definition(id: string, masterRootId: string): ComponentDefinition {
  return { id, name: id, source: { kind: 'canvas', masterRootId }, revision: 0, properties: [], materials: [], parts: [], interactions: [] }
}

function fixture(): { file: FileDocument; owner: ComponentDefinition } {
  const file = createBlankFile('instance-swap', 'page', 'root')
  const frame = (id: string, name: string, x: number, width = 40) => ({ id, type: 'frame' as const, name, styles: { relativeTransform: [1, 0, 0, 1, x, 10] as const, width, height: 40 } })
  file.nodes.owner = frame('owner', 'Owner', 0, 200)
  file.nodes.bound = frame('bound', 'Badge use', 20)
  file.nodes['badge-master'] = frame('badge-master', 'Badge', 300)
  file.nodes['alternate-master'] = frame('alternate-master', 'Alternate', 400, 60)
  file.nodes['alternate-child'] = frame('alternate-child', 'Alternate child', 4, 20)
  file.nodes['outer-use'] = frame('outer-use', 'Owner use', 0, 200)
  file.nodes['bound-use'] = frame('bound-use', 'Badge use', 27)
  file.relationships.owner = { parentId: 'root', orderKey: 'A' }
  file.relationships.bound = { parentId: 'owner', orderKey: 'A' }
  file.relationships['badge-master'] = { parentId: 'root', orderKey: 'B' }
  file.relationships['alternate-master'] = { parentId: 'root', orderKey: 'C' }
  file.relationships['alternate-child'] = { parentId: 'alternate-master', orderKey: 'A' }
  file.relationships['outer-use'] = { parentId: 'root', orderKey: 'D' }
  file.relationships['bound-use'] = { parentId: 'outer-use', orderKey: 'A' }
  const owner: ComponentDefinition = {
    ...definition('owner-component', 'owner'),
    properties: [{ id: 'icon', name: 'Icon', type: 'instance-swap', defaultValue: 'badge', binding: { kind: 'instance-swap', nodeId: 'bound' } }],
  }
  file.componentModel = {
    definitions: { [owner.id]: owner, badge: definition('badge', 'badge-master'), alternate: definition('alternate', 'alternate-master') },
    instances: {
      bound: { id: 'bound', componentId: 'badge', values: {} },
      'outer-use': { id: 'outer-use', componentId: owner.id, values: {} },
      'bound-use': { id: 'bound-use', componentId: 'badge', values: {} },
    },
  }
  return { file, owner }
}

describe('COMP-V2-UI-076 Instance swap planning', () => {
  it('replaces one nested semantic subtree while preserving its stable root, relationship, and pose', () => {
    const { file, owner } = fixture()
    const before = structuredClone(file)
    let sequence = 0

    const plan = planComponentInstanceSwap({ file, owner, ownerRootId: 'outer-use', propertyId: 'icon', componentId: 'alternate', atoms: [], makeId: () => `new:${++sequence}` })!

    expect(file).toEqual(before)
    expect(plan.rootId).toBe('bound-use')
    expect(plan.file.componentModel.instances['outer-use']!.values).toEqual({ icon: 'alternate' })
    expect(plan.file.componentModel.instances['bound-use']).toEqual({ id: 'bound-use', componentId: 'alternate', values: {} })
    expect(plan.file.relationships['bound-use']).toEqual(before.relationships['bound-use'])
    expect(plan.file.nodes['bound-use']).toMatchObject({ name: 'Alternate', styles: { relativeTransform: [1, 0, 0, 1, 27, 10], width: 60 } })
    expect(descendantsOf(plan.file, 'bound-use')).toHaveLength(1)
    expect(applyFileCommand(file, { type: 'batch', commands: [...plan.commands] }, [], { allowUnavailableBindings: true })).toEqual(plan.file)
  })

  it('uses the same planner for a transient master preview without changing the source', () => {
    const { file, owner } = fixture()
    const before = structuredClone(file)
    let sequence = 0
    const plan = planComponentInstanceSwap({ file, owner, ownerRootId: 'owner', propertyId: 'icon', componentId: 'alternate', atoms: [], makeId: () => `preview:${++sequence}`, transientMaster: true })!
    expect(file).toEqual(before)
    expect(plan.file.componentModel.definitions[owner.id]!.properties[0]).toMatchObject({ type: 'instance-swap', defaultValue: 'alternate' })
    expect(plan.file.componentModel.instances.bound).toMatchObject({ componentId: 'alternate' })
  })
})

describe('COMP-V2-UI-NEG-003 closed Instance swap planner', () => {
  it('excludes recursion and rejects stale physical, semantic, and property targets without partial output', () => {
    const { file, owner } = fixture()
    file.componentModel = {
      definitions: { ...file.componentModel.definitions, recursive: { ...definition('recursive', 'alternate-master'), properties: [{ id: 'owner', name: 'Owner', type: 'instance-swap', defaultValue: owner.id, binding: { kind: 'instance-swap', nodeId: 'alternate-child' } }] } },
      instances: { ...file.componentModel.instances, 'alternate-child': { id: 'alternate-child', componentId: owner.id, values: {} } },
    }
    expect(eligibleInstanceSwapComponents(file, owner).map(item => item.id)).toEqual(['badge'])
    expect(planComponentInstanceSwap({ file, owner, ownerRootId: 'outer-use', propertyId: 'missing', componentId: 'alternate', atoms: [], makeId: () => 'new' })).toBeNull()
    const stale = structuredClone(file)
    stale.componentModel = { ...stale.componentModel, instances: { ...stale.componentModel.instances, 'bound-use': { id: 'bound-use', componentId: 'alternate', values: {} } } }
    expect(planComponentInstanceSwap({ file: stale, owner, ownerRootId: 'outer-use', propertyId: 'icon', componentId: 'badge', atoms: [], makeId: () => 'new' })).toBeNull()
    expect(planComponentInstanceSwap({ file, owner, ownerRootId: 'outer-use', propertyId: 'icon', componentId: 'recursive', atoms: [], makeId: () => 'new' })).toBeNull()
  })

  it('fails atomically when generated identities collide', () => {
    const { file, owner } = fixture()
    const before = structuredClone(file)
    expect(planComponentInstanceSwap({ file, owner, ownerRootId: 'outer-use', propertyId: 'icon', componentId: 'alternate', atoms: [], makeId: () => 'owner' })).toBeNull()
    expect(file).toEqual(before)
  })

  it('excludes a candidate that reaches the owner only through an existing swap override', () => {
    const { file, owner } = fixture()
    file.nodes['alternate-use'] = { id: 'alternate-use', type: 'frame', name: 'Alternate use', styles: { relativeTransform: [1, 0, 0, 1, 500, 10], width: 60, height: 40 } }
    file.relationships['alternate-use'] = { parentId: 'root', orderKey: 'E' }
    const alternate: ComponentDefinition = {
      ...file.componentModel.definitions.alternate!,
      properties: [{ id: 'nested', name: 'Nested', type: 'instance-swap', defaultValue: 'badge', binding: { kind: 'instance-swap', nodeId: 'alternate-child' } }],
    }
    file.componentModel = {
      definitions: { ...file.componentModel.definitions, alternate },
      instances: {
        ...file.componentModel.instances,
        'alternate-child': { id: 'alternate-child', componentId: 'badge', values: {} },
        'alternate-use': { id: 'alternate-use', componentId: 'alternate', values: { nested: owner.id } },
      },
    }

    expect(eligibleInstanceSwapComponents(file, owner).map(item => item.id)).toEqual(['badge'])
    expect(planComponentInstanceSwap({ file, owner, ownerRootId: 'outer-use', propertyId: 'icon', componentId: 'alternate', atoms: [], makeId: () => 'new' })).toBeNull()
  })
})
