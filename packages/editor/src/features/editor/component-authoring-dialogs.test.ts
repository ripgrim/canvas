import { describe, expect, it } from 'vitest'
import { canonicalMaterialGroup, componentPropertyBindingNodes, materialDraftError, propertyDraftError, uniqueComponentDraftName } from './component-authoring-dialogs'

describe('COMP-V2-UI-013 component definition validation', () => {
  it('requires unique option names without exposing model value terminology', () => {
    expect(propertyDraftError({ name: 'State', options: [{ id: 'one', name: 'Default' }, { id: 'two', name: 'default' }] }, 'variant', [])).toBe('Options need unique names.')
    expect(propertyDraftError({ name: 'State', options: [{ id: 'one', name: 'Default' }, { id: 'two', name: 'Hover' }] }, 'variant', [])).toBeNull()
  })

  it('rejects duplicate property and material definitions', () => {
    expect(propertyDraftError({ name: 'State', options: [] }, 'text', ['State'])).toBe('Name already exists.')
    expect(materialDraftError({ name: 'Quiet', group: 'Interaction', description: '', nodeId: 'face' }, ['interaction\u0000quiet'])).toBe('Name already exists.')
    expect(materialDraftError({ name: 'Quiet', group: 'Interaction', description: '', nodeId: 'face' }, [])).toBeNull()
  })

  it('preserves the authored casing of an existing material group', () => {
    expect(canonicalMaterialGroup(' interaction ', ['Layers', 'Interaction'])).toBe('Interaction')
    expect(canonicalMaterialGroup('Brand', ['Layers', 'Interaction'])).toBe('Brand')
  })

  it('starts repeated definitions with a usable unique name', () => {
    expect(uniqueComponentDraftName(['Property', 'property 2'], 'Property')).toBe('Property 3')
    expect(uniqueComponentDraftName(['Surface'], 'Material')).toBe('Material')
  })

  it('offers only layer kinds supported by each property binding', () => {
    const nodes = [
      { id: 'frame', name: 'Frame', type: 'frame', icon: 'frame' as const },
      { id: 'label', name: 'Enter token', type: 'text', icon: 'text' as const },
      { id: 'face', name: 'Face', type: 'rectangle', icon: 'rectangle' as const },
    ]
    expect(componentPropertyBindingNodes(nodes, 'text').map(node => node.id)).toEqual(['label'])
    expect(componentPropertyBindingNodes(nodes, 'slot').map(node => node.id)).toEqual(['frame'])
    expect(componentPropertyBindingNodes(nodes, 'variant').map(node => node.id)).toEqual(['frame', 'label', 'face'])
    expect(componentPropertyBindingNodes(nodes, 'boolean').map(node => node.id)).toEqual(['frame', 'label', 'face'])
    expect(componentPropertyBindingNodes(nodes, 'variant', ['frame']).map(node => node.id)).toEqual(['label', 'face'])
  })
})
