import { describe, expect, it } from 'vitest'
import type { ComponentDefinition } from '@canvas/repo-engine/component-model'
import { createBlankFile, legacyTextProperties } from '@canvas/repo-engine/file-document'
import { isPreviewDocument } from '@canvas/preview-runtime/protocol'
import { configuredCanvasComponentPreview } from './component-configured-preview'

describe('COMP-V2-UI-035 configured component preview', () => {
  it('isolates the real master subtree and projects draft values without changing the file', () => {
    const file = createBlankFile('configured-preview', 'page', 'root')
    file.nodes.master = { id: 'master', type: 'frame', name: 'Button', styles: { relativeTransform: [0, 1, -1, 0, 120, 80], width: 100, height: 40 }, appearance: { fills: [{ id: 'default', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } }] } }
    file.nodes.label = { id: 'label', type: 'text', name: 'Label', styles: { relativeTransform: [1, 0, 0, 1, 8, 8], width: 84, height: 24 }, text: 'Default', ...legacyTextProperties() }
    file.nodes.unrelated = { id: 'unrelated', type: 'rectangle', name: 'Unrelated', styles: { relativeTransform: [1, 0, 0, 1, 400, 400], width: 50, height: 50 } }
    file.relationships.master = { parentId: 'root', orderKey: 'A' }
    file.relationships.label = { parentId: 'master', orderKey: 'A' }
    file.relationships.unrelated = { parentId: 'root', orderKey: 'B' }
    const definition: ComponentDefinition = {
      id: 'button', name: 'Button', source: { kind: 'canvas', masterRootId: 'master' }, revision: 0,
      properties: [
        { id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }], binding: { kind: 'variant', nodeId: 'master', appearances: { default: {}, hover: { opacity: 0.5 } } } },
        { id: 'label', name: 'Label', type: 'text', defaultValue: 'Default', binding: { kind: 'text', nodeId: 'label' } },
        { id: 'visible', name: 'Visible', type: 'boolean', defaultValue: true, binding: { kind: 'visibility', nodeId: 'label' } },
      ], materials: [], parts: [], interactions: [],
    }
    file.componentModel = { definitions: { button: definition }, instances: {} }
    const before = structuredClone(file)

    const preview = configuredCanvasComponentPreview(file, definition, { state: 'hover', label: 'Configured', visible: false })!

    expect(file).toEqual(before)
    expect(preview.document.canvas.elements.map(element => element.id)).toEqual(['master', 'label'])
    expect(preview.document.canvas.elements.find(element => element.id === 'master')).toMatchObject({ parentId: null, relativeTransform: [0, 1, -1, 0, 52, 0], appearance: { opacity: 0.5 } })
    expect(preview.document.canvas.elements.find(element => element.id === 'label')).toMatchObject({ text: 'Configured', appearance: { visible: false } })
    expect(preview.document.frame).toMatchObject({ width: 64, height: 100, clip: false })
    expect(preview.document.background).toBeUndefined()
    expect(isPreviewDocument(preview.document)).toBe(true)
  })

  it('returns no preview for code components', () => {
    const file = createBlankFile('configured-preview-code', 'page', 'root')
    const definition: ComponentDefinition = { id: 'code', name: 'Code', source: { kind: 'code', bindingId: 'binding' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] }
    expect(configuredCanvasComponentPreview(file, definition, {})).toBeNull()
  })

  it('renders transient Slot drafts without changing the authoritative file', () => {
    const file = createBlankFile('configured-slot-preview', 'page', 'root')
    file.nodes.master = { id: 'master', type: 'frame', name: 'Notice', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 240, height: 120 } }
    file.nodes.host = { id: 'host', type: 'frame', name: 'Content', styles: { relativeTransform: [1, 0, 0, 1, 8, 8], width: 224, height: 104 } }
    file.nodes.badge = { id: 'badge', type: 'frame', name: 'Badge', styles: { relativeTransform: [1, 0, 0, 1, 300, 0], width: 80, height: 24 } }
    file.relationships.master = { parentId: 'root', orderKey: 'A' }
    file.relationships.host = { parentId: 'master', orderKey: 'A' }
    file.relationships.badge = { parentId: 'root', orderKey: 'B' }
    const definition: ComponentDefinition = {
      id: 'notice', name: 'Notice', source: { kind: 'canvas', masterRootId: 'master' }, revision: 0,
      properties: [{ id: 'content', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'host' } }],
      materials: [], parts: [], interactions: [],
    }
    const badge: ComponentDefinition = { id: 'badge', name: 'Badge', source: { kind: 'canvas', masterRootId: 'badge' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] }
    file.componentModel = { definitions: { notice: definition, badge }, instances: {} }
    const before = structuredClone(file)

    const preview = configuredCanvasComponentPreview(file, definition, {}, {}, { drafts: [
      { id: 'text', propertyId: 'content', content: { kind: 'text' } },
      { id: 'badge', propertyId: 'content', content: { kind: 'component', componentId: 'badge' } },
    ] })!

    expect(file).toEqual(before)
    expect(preview.document.canvas.elements.find(element => element.id === 'configured-preview:notice:0')).toMatchObject({ text: 'Text' })
    expect(preview.document.canvas.elements.some(element => element.id === 'configured-preview:notice:2')).toBe(true)
    expect(Object.keys(file.nodes).some(nodeId => nodeId.startsWith('configured-preview:'))).toBe(false)
    expect(isPreviewDocument(preview.document)).toBe(true)
  })

  it('renders multiple transient Instance swaps without changing the master', () => {
    const file = createBlankFile('configured-swap-preview', 'page', 'root')
    file.nodes.master = { id: 'master', type: 'frame', name: 'Button', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 120, height: 40 } }
    file.nodes.circleMaster = { id: 'circleMaster', type: 'frame', name: 'Circle icon', styles: { relativeTransform: [1, 0, 0, 1, 160, 0], width: 24, height: 24 } }
    file.nodes.circleMasterShape = { id: 'circleMasterShape', type: 'rectangle', name: 'Circle', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 24, height: 24 } }
    file.nodes.icon = { id: 'icon', type: 'frame', name: 'Circle icon', styles: { relativeTransform: [1, 0, 0, 1, 8, 8], width: 24, height: 24 } }
    file.nodes.circle = { id: 'circle', type: 'rectangle', name: 'Circle', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 24, height: 24 } }
    file.nodes.icon2 = { id: 'icon2', type: 'frame', name: 'Circle icon', styles: { relativeTransform: [1, 0, 0, 1, 88, 8], width: 24, height: 24 } }
    file.nodes.circle2 = { id: 'circle2', type: 'rectangle', name: 'Circle', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 24, height: 24 } }
    file.nodes.squareMaster = { id: 'squareMaster', type: 'frame', name: 'Square icon', styles: { relativeTransform: [1, 0, 0, 1, 200, 0], width: 24, height: 24 } }
    file.nodes.square = { id: 'square', type: 'rectangle', name: 'Square', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 24, height: 24 } }
    file.relationships.master = { parentId: 'root', orderKey: 'A' }
    file.relationships.icon = { parentId: 'master', orderKey: 'A' }
    file.relationships.circle = { parentId: 'icon', orderKey: 'A' }
    file.relationships.icon2 = { parentId: 'master', orderKey: 'B' }
    file.relationships.circle2 = { parentId: 'icon2', orderKey: 'A' }
    file.relationships.circleMaster = { parentId: 'root', orderKey: 'B' }
    file.relationships.circleMasterShape = { parentId: 'circleMaster', orderKey: 'A' }
    file.relationships.squareMaster = { parentId: 'root', orderKey: 'C' }
    file.relationships.square = { parentId: 'squareMaster', orderKey: 'A' }
    const circle: ComponentDefinition = { id: 'circle-component', name: 'Circle icon', source: { kind: 'canvas', masterRootId: 'circleMaster' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] }
    const square: ComponentDefinition = { id: 'square-component', name: 'Square icon', source: { kind: 'canvas', masterRootId: 'squareMaster' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] }
    const button: ComponentDefinition = {
      id: 'button', name: 'Button', source: { kind: 'canvas', masterRootId: 'master' }, revision: 0,
      properties: [
        { id: 'leading', name: 'Leading icon', type: 'instance-swap', defaultValue: circle.id, binding: { kind: 'instance-swap', nodeId: 'icon' } },
        { id: 'trailing', name: 'Trailing icon', type: 'instance-swap', defaultValue: circle.id, binding: { kind: 'instance-swap', nodeId: 'icon2' } },
      ],
      materials: [], parts: [], interactions: [],
    }
    file.componentModel = { definitions: { button, [circle.id]: circle, [square.id]: square }, instances: { icon: { id: 'icon', componentId: circle.id, values: {} }, icon2: { id: 'icon2', componentId: circle.id, values: {} } } }
    const before = structuredClone(file)

    const preview = configuredCanvasComponentPreview(file, button, { leading: square.id, trailing: square.id })!

    expect(file).toEqual(before)
    expect(preview.document.canvas.elements.find(element => element.id === 'icon')).toMatchObject({ name: 'Square icon' })
    expect(preview.document.canvas.elements.find(element => element.id === 'icon2')).toMatchObject({ name: 'Square icon' })
    expect(preview.document.canvas.elements.filter(element => element.name === 'Square')).toHaveLength(2)
    expect(preview.document.canvas.elements.some(element => element.name === 'Circle')).toBe(false)
    expect(isPreviewDocument(preview.document)).toBe(true)
  })
})
