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
})
