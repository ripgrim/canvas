import { describe, expect, it } from 'vitest'
import type { ComponentDefinition } from '@canvas/repo-engine/component-model'
import { createBlankFile, descendantsOf } from '@canvas/repo-engine/file-document'
import { eligibleSlotDraftComponents, planComponentSlotDrafts, validComponentSlotDrafts } from './component-configured-instance'

function fixture() {
  const file = createBlankFile('slot-drafts', 'page', 'root')
  file.nodes.owner = { id: 'owner', type: 'frame', name: 'Notice', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 240, height: 120 } }
  file.nodes.host = { id: 'host', type: 'frame', name: 'Content', styles: { relativeTransform: [1, 0, 0, 1, 8, 8], width: 224, height: 104 } }
  file.nodes.badge = { id: 'badge', type: 'frame', name: 'Badge', styles: { relativeTransform: [1, 0, 0, 1, 300, 0], width: 80, height: 24 } }
  file.relationships.owner = { parentId: 'root', orderKey: 'A' }
  file.relationships.host = { parentId: 'owner', orderKey: 'A' }
  file.relationships.badge = { parentId: 'root', orderKey: 'B' }
  const owner: ComponentDefinition = {
    id: 'notice', name: 'Notice', source: { kind: 'canvas', masterRootId: 'owner' }, revision: 0,
    properties: [{ id: 'content', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'host' } }],
    materials: [], parts: [], interactions: [],
  }
  const badge: ComponentDefinition = { id: 'badge', name: 'Badge', source: { kind: 'canvas', masterRootId: 'badge' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] }
  file.componentModel = { definitions: { notice: owner, badge }, instances: {} }
  return { file, owner, badge }
}

describe('COMP-V2-UI-075 configured Slot draft planning', () => {
  it('materializes Text, Frame, and a nested canvas component without changing the source file', () => {
    const { file, owner } = fixture()
    const before = structuredClone(file)
    let next = 0
    const drafts = [
      { id: 'draft:text', propertyId: 'content', content: { kind: 'text' as const } },
      { id: 'draft:frame', propertyId: 'content', content: { kind: 'frame' as const } },
      { id: 'draft:badge', propertyId: 'content', content: { kind: 'component' as const, componentId: 'badge' } },
    ]

    const plan = planComponentSlotDrafts({ file, owner, ownerRootId: 'owner', drafts, atoms: [], makeId: () => `new:${++next}`, editorMode: 'light' })!

    expect(file).toEqual(before)
    expect(plan.nodeIds).toHaveLength(3)
    expect(plan.nodeIds.every(nodeId => plan.file.relationships[nodeId]?.parentId === 'host')).toBe(true)
    expect(plan.nodeIds.every(nodeId => plan.file.relationships[nodeId]?.slot === 'content')).toBe(true)
    expect(plan.file.nodes[plan.nodeIds[0]!]!.type).toBe('text')
    expect(plan.file.nodes[plan.nodeIds[1]!]!.type).toBe('frame')
    expect(plan.file.componentModel.instances[plan.nodeIds[2]!]).toMatchObject({ componentId: 'badge', values: {} })
    expect(descendantsOf(plan.file, 'owner')).toEqual(expect.arrayContaining([...plan.nodeIds]))
  })
})

describe('COMP-V2-UI-NEG-002 closed Slot draft boundary', () => {
  it('reconciles stale drafts and excludes direct or ancestor recursion', () => {
    const { file, owner } = fixture()
    file.componentModel = { ...file.componentModel, instances: { ...file.componentModel.instances, ownerInsideBadge: { id: 'ownerInsideBadge', componentId: 'notice', values: {} } } }
    file.nodes.ownerInsideBadge = { id: 'ownerInsideBadge', type: 'frame', name: 'Nested notice', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 20, height: 20 } }
    file.relationships.ownerInsideBadge = { parentId: 'badge', orderKey: 'A' }
    const drafts = [
      { id: 'valid', propertyId: 'content', content: { kind: 'text' as const } },
      { id: 'missing-property', propertyId: 'missing', content: { kind: 'frame' as const } },
      { id: 'recursive', propertyId: 'content', content: { kind: 'component' as const, componentId: 'badge' } },
      { id: 'direct', propertyId: 'content', content: { kind: 'component' as const, componentId: 'notice' } },
    ]

    expect(eligibleSlotDraftComponents(file, owner)).toEqual([])
    expect(validComponentSlotDrafts(file, owner, drafts)).toEqual([drafts[0]])
    expect(planComponentSlotDrafts({ file, owner, ownerRootId: 'owner', drafts, atoms: [], makeId: () => 'new', editorMode: 'light' })).toBeNull()
  })

  it('rejects an unbound Slot without producing a partial plan', () => {
    const { file, owner } = fixture()
    const unbound = { ...owner, properties: [{ id: 'content', name: 'Content', type: 'slot' as const }] }
    const drafts = [{ id: 'draft', propertyId: 'content', content: { kind: 'text' as const } }]
    expect(validComponentSlotDrafts(file, unbound, drafts)).toEqual([])
    expect(planComponentSlotDrafts({ file, owner: unbound, ownerRootId: 'owner', drafts, atoms: [], makeId: () => 'new', editorMode: 'light' })).toBeNull()
  })

  it('rejects duplicate identities and code-component drafts', () => {
    const { file, owner } = fixture()
    file.componentModel = { ...file.componentModel, definitions: { ...file.componentModel.definitions, code: { id: 'code', name: 'Code', source: { kind: 'code', bindingId: 'code' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] } } }
    const drafts = [
      { id: 'same', propertyId: 'content', content: { kind: 'text' as const } },
      { id: 'same', propertyId: 'content', content: { kind: 'frame' as const } },
      { id: 'code', propertyId: 'content', content: { kind: 'component' as const, componentId: 'code' } },
    ]
    expect(validComponentSlotDrafts(file, owner, drafts)).toEqual([drafts[0]])
    expect(planComponentSlotDrafts({ file, owner, ownerRootId: 'owner', drafts, atoms: [], makeId: () => 'new', editorMode: 'light' })).toBeNull()
  })
})
