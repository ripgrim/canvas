import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import type { PreviewDocument } from '@canvas/preview-runtime/protocol'
import { protocolVersion } from '@canvas/preview-runtime/protocol'
import type { ComponentDefinition } from '@canvas/repo-engine/component-model'
import type { ProjectSnapshot } from './types'
import { configuredComponentPreviewCommands, createComponentDocsPreviewService, validComponentPreviewValues } from './component-docs-preview-service'
import { documentStore } from './document-store'
import { editorStore } from './store'

const document: PreviewDocument = {
  version: 3,
  revision: 1,
  rootIds: [],
  nodes: {},
  frame: { width: 100, height: 50, direction: 'column', gap: 0, padding: 0, clip: false },
  canvas: { elements: [] },
}

function componentFile(): FileDocument {
  const file = createBlankFile('component-preview-service', 'page', 'root')
  file.nodes.master = { id: 'master', type: 'frame', name: 'Button', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 50 } }
  file.nodes.host = { id: 'host', type: 'frame', name: 'Content', styles: { relativeTransform: [1, 0, 0, 1, 4, 4], width: 92, height: 42 } }
  file.nodes.badge = { id: 'badge', type: 'frame', name: 'Badge', styles: { relativeTransform: [1, 0, 0, 1, 160, 0], width: 40, height: 20 } }
  file.relationships.master = { parentId: 'root', orderKey: 'A' }
  file.relationships.host = { parentId: 'master', orderKey: 'A' }
  file.relationships.badge = { parentId: 'root', orderKey: 'B' }
  file.componentModel = { definitions: {
    button: { id: 'button', name: 'Button', source: { kind: 'canvas', masterRootId: 'master' }, revision: 0, properties: [{ id: 'content', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'host' } }], materials: [], parts: [], interactions: [] },
    badge: { id: 'badge', name: 'Badge', source: { kind: 'canvas', masterRootId: 'badge' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
  }, instances: {} }
  return file
}

function projectSnapshot(file: FileDocument): ProjectSnapshot {
  return {
    projectId: 'component-preview-project', fileId: file.fileId, atoms: [], sourceHashes: {},
    composition: { id: 'component-preview-composition', name: 'Component preview', componentId: null, children: [] },
    file, sourceHistory: [], conflict: null, phases: [{ name: 'Read source', completed: 1 }], tokens: [],
    preview: { status: 'ready', currentGeneration: 1, activeGeneration: 1, origin: 'https://preview.test', url: 'https://preview.test/build/1/index.html', stale: false, diagnostics: [] },
    designThemes: [{ id: 'default', name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' }],
  }
}

afterEach(() => {
  documentStore.clear()
  editorStore.set({ snapshot: null, previewReady: false, previewThemeId: null, runtimeInstanceIds: null, compositionPreview: false, error: null })
})

describe('COMP-V2-UI-035 component docs preview connection', () => {
  it('publishes the real document in interact mode with a fitted camera', () => {
    const commands = configuredComponentPreviewCommands({ generation: 4, document, layout: [], layoutGeneration: 7, cameraSequence: 3, renderSequence: 5, viewport: { width: 300, height: 180 }, theme: { attribute: null, colorScheme: 'light' }, fonts: [] })
    expect(commands.map(command => command.type)).toEqual(['set-theme', 'set-interaction-mode', 'set-document', 'set-layout', 'set-camera'])
    expect(commands.find(command => command.type === 'set-interaction-mode')).toMatchObject({ mode: 'interact' })
    expect(commands.find(command => command.type === 'set-document')).toMatchObject({ generation: 4, document, renderSequence: 5 })
    expect(commands.find(command => command.type === 'set-layout')).toMatchObject({ layoutGeneration: 7, items: [] })
    expect(commands.find(command => command.type === 'set-camera')).toMatchObject({ sequence: 3, camera: { x: -100, y: -50, zoom: 2, width: 300, height: 180 } })
  })

  it('keeps only explicit playground drafts so untouched values follow master defaults', () => {
    const definition: ComponentDefinition = {
      id: 'button', name: 'Button', source: { kind: 'canvas', masterRootId: 'master' }, revision: 0,
      properties: [
        { id: 'label', name: 'Label', type: 'text', defaultValue: 'Master label' },
        { id: 'visible', name: 'Visible', type: 'boolean', defaultValue: true },
      ], materials: [], parts: [], interactions: [],
    }
    expect(validComponentPreviewValues(definition, {})).toEqual({})
    expect(validComponentPreviewValues(definition, { label: 'Draft', missing: 'stale' })).toEqual({ label: 'Draft' })
    expect(validComponentPreviewValues({ ...definition, properties: [{ id: 'label', name: 'Label', type: 'text', defaultValue: 'New master label' }] }, {})).toEqual({})
  })

  it('surfaces runtime failure and retries the same preview connection', () => {
    const file = componentFile()
    documentStore.load(file, [], { replace: true, pageId: 'page' })
    editorStore.set({ snapshot: projectSnapshot(file), previewReady: true, previewThemeId: 'default', runtimeInstanceIds: null, compositionPreview: true, error: null })
    let messageListener: ((event: MessageEvent) => void) | null = null
    const messageHost = {
      addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => { messageListener = listener }),
      removeEventListener: vi.fn(),
    }
    const target = { postMessage: vi.fn() }
    const service = createComponentDocsPreviewService('button', messageHost as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>)
    const deliver = (data: unknown) => messageListener?.({ data, origin: 'https://preview.test', source: target } as unknown as MessageEvent)
    const lastDocumentCommand = () => {
      for (let index = target.postMessage.mock.calls.length - 1; index >= 0; index -= 1) {
        const command = target.postMessage.mock.calls[index]?.[0]
        if (command?.type === 'set-document') return command
      }
      throw new Error('Expected sequenced document command')
    }

    service.connect(target as unknown as Window, { width: 300, height: 180 })
    expect(service.getSnapshot().status).toBe('connecting')
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'ping' }), 'https://preview.test')

    deliver({ channel: 'design-editor-preview', version: protocolVersion, generation: 1, type: 'ready', componentId: 'preview' })
    expect(service.getSnapshot().status).toBe('connecting')
    expect(target.postMessage.mock.calls.some(([command]) => command.type === 'set-document')).toBe(true)
    const firstDocument = lastDocumentCommand()
    if (firstDocument?.type !== 'set-document' || firstDocument.renderSequence === undefined) throw new Error('Expected sequenced document command')
    deliver({ channel: 'design-editor-preview', version: protocolVersion, generation: 1, type: 'document-applied', renderSequence: firstDocument.renderSequence, documentRevision: file.revision })
    expect(service.getSnapshot().status).toBe('ready')

    deliver({ channel: 'design-editor-preview', version: protocolVersion, generation: 1, type: 'diagnostic', message: 'Runtime failed' })
    expect(service.getSnapshot().status).toBe('error')

    target.postMessage.mockClear()
    service.retry()
    expect(service.getSnapshot().status).toBe('connecting')
    expect(target.postMessage).toHaveBeenCalledOnce()
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'ping' }), 'https://preview.test')

    deliver({ channel: 'design-editor-preview', version: protocolVersion, generation: 1, type: 'ready', componentId: 'preview' })
    expect(service.getSnapshot().status).toBe('connecting')
    const retryDocument = lastDocumentCommand()
    if (retryDocument?.type !== 'set-document' || retryDocument.renderSequence === undefined) throw new Error('Expected retried sequenced document command')
    deliver({ channel: 'design-editor-preview', version: protocolVersion, generation: 1, type: 'document-applied', renderSequence: retryDocument.renderSequence, documentRevision: file.revision })
    expect(service.getSnapshot().status).toBe('ready')
    expect(target.postMessage.mock.calls.some(([command]) => command.type === 'set-document')).toBe(true)
    service.disconnect()
  })

  it('keeps Slot drafts transient and reconciles them when the binding disappears', () => {
    const file = componentFile()
    documentStore.load(file, [], { replace: true, pageId: 'page' })
    const service = createComponentDocsPreviewService('button', { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>)

    expect(service.addSlotContent('content', 'text')).toBe(true)
    expect(service.addSlotComponent('content', 'badge')).toBe(true)
    expect(service.getSnapshot().slotDrafts).toHaveLength(2)
    expect(documentStore.getSnapshot().file).toEqual(file)
    expect(documentStore.getSnapshot().dirty).toBe(false)

    expect(documentStore.commands.insertCanvas('rectangle', { x: 240, y: 0 })).toBe(true)
    service.resetValue('missing')
    expect(service.getSnapshot().slotDrafts).toHaveLength(2)

    const withoutSlot = structuredClone(documentStore.getSnapshot().file!)
    withoutSlot.componentModel = { ...withoutSlot.componentModel, definitions: { ...withoutSlot.componentModel.definitions, button: { ...withoutSlot.componentModel.definitions.button!, revision: 1, properties: [] } } }
    documentStore.load(withoutSlot, [], { replace: true, pageId: 'page' })
    service.resetValue('missing')
    expect(service.getSnapshot().slotDrafts).toEqual([])
    expect(service.addSlotContent('content', 'frame')).toBe(false)
  })
})
