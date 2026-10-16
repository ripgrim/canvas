// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { FlowDragPresentation } from './flow-drag-presentation'

const revision = 4
const measurementRevision = 12
const layoutGeneration = 0
const worldQuad = [{ x: 30, y: 10 }, { x: 30, y: 80 }, { x: -70, y: 80 }, { x: -70, y: 10 }] as const
const nativeMatchMedia = window.matchMedia
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let mountedRoot: ReturnType<typeof createRoot> | null = null

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value as object)) deepFreeze(Reflect.get(value as object, key))
  return Object.freeze(value)
}

const file = (): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: 'hud-client-file',
  revision,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    selected: { id: 'selected', type: 'rectangle', name: 'Selected', styles: { relativeTransform: [1, 0, 0, 1, -70, 10], width: 100, height: 70 }, layout: { item: { position: { mode: 'freeform' } } } },
  },
  relationships: { selected: { parentId: 'root', orderKey: 'V' } },
  theme: { tokens: {} },
})

function flowDrag(retention: 'active' | 'terminal-retained', sequence: number): FlowDragPresentation {
  const sourceQuad = worldQuad.map(point => ({ ...point })) as unknown as typeof worldQuad
  const source = { coordinateSpace: 'world' as const, quad: sourceQuad, aabb: { x: -70, y: 10, width: 100, height: 70 }, semanticSize: { width: 35, height: 50 } }
  const currentQuad = sourceQuad.map(point => ({ x: point.x + sequence, y: point.y + sequence })) as unknown as typeof worldQuad
  const current = { coordinateSpace: 'world' as const, quad: currentQuad, aabb: { x: -70 + sequence, y: 10 + sequence, width: 100, height: 70 }, semanticSize: { width: 35, height: 50 } }
  return deepFreeze({
    kind: 'flow-drag' as const,
    coordinateSpace: 'world' as const,
    identity: { interactionId: 'client-flow', gestureGeneration: 2, sampleSequence: sequence },
    fence: { fileId: 'hud-client-file', pageId: 'page', pageRootId: 'root', fileRevision: revision, measurementRevision, documentRevision: revision, layoutGeneration },
    retention: retention === 'active'
      ? { kind: 'active' as const, gestureGeneration: 2, sampleSequence: sequence }
      : { kind: 'terminal-retained' as const, gestureGeneration: 2, sampleSequence: sequence, terminalReason: 'pointer-up' as const, terminalSampleSequence: sequence, holdUntil: 'authoritative-geometry' as const },
    pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: sequence, y: sequence } },
    original: {
      documentNodeId: 'selected', kind: 'rectangle' as const, name: 'Selected', sourceRelationship: { parentId: 'root', orderKey: 'V', slot: { presence: 'absent' as const } }, sourceIndex: 0,
      mode: 'flow' as const, source, current, sourceOffsetParentPose: null,
      dom: { treatment: 'drag-dimmed' as const, opacity: 0.6 as const, opacityPriority: 'important' as const, zIndex: null },
      namePresentation: { visible: true as const, anchor: 'source' as const, pose: source },
    },
    movingVisual: { kind: 'fill-ghost' as const, documentNodeId: null, geometry: current, fill: { kind: 'fill-only' as const, color: 'oklch(0.67 0.17 258)' as const, alpha: 0.15 as const }, hitTesting: 'none' as const, a11y: 'hidden' as const },
    supportClone: null,
    target: null,
    hud: { showDimensions: false as const, showSelectionOutline: false as const, showResizeHandles: false as const, showRotationHandles: false as const, interactiveHandleLayer: false as const },
    mobileQuickActions: { mounted: true as const, hidden: true as const, inert: true as const, transition: { property: 'opacity' as const, durationMs: 150, source: 'wonder' as const } },
  })
}

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => { mountedRoot?.unmount() })
    mountedRoot = null
  }
  const [{ documentStore }, { sceneGeometry }, { canvasHudProjectionService }] = await Promise.all([
    import('./document-store'),
    import('./scene-geometry'),
    import('./canvas-hud-projection-service'),
  ])
  canvasHudProjectionService.stop()
  documentStore.clear()
  sceneGeometry.clear()
  window.matchMedia = nativeMatchMedia
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
  document.body.replaceChildren()
})

describe('UI-MOBILE-004-C5-HUD-RETIRE mounted production quick-actions boundary', () => {
  it('suppresses 100 real flow samples and renders only phase entry and exact retirement', async () => {
    window.matchMedia = (() => ({
      matches: true,
      media: '(max-width: 760px)',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })) as typeof window.matchMedia
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true

    const [{ SelectionHud }, { documentStore }, { sceneGeometry }, { canvasHudProjectionService }] = await Promise.all([
      import('./SelectionHud'),
      import('./document-store'),
      import('./scene-geometry'),
      import('./canvas-hud-projection-service'),
    ])
    documentStore.clear()
    sceneGeometry.clear()
    canvasHudProjectionService.stop()
    documentStore.load(file(), [], { replace: true, pageId: 'page' })
    documentStore.setViewport({ x: 10, y: -20, zoom: 2 })
    documentStore.setViewportSize({ width: 390, height: 844 })
    documentStore.select('selected')
    sceneGeometry.update({
      selected: {
        canvasKind: 'rectangle', documentRevision: revision, layoutGeneration,
        rect: { x: -70, y: 10, width: 100, height: 70 }, worldAabb: { x: -70, y: 10, width: 100, height: 70 },
        offset: { x: -70, y: 10, width: 100, height: 70, origin: { x: 50, y: 35 } },
        offsetParentNodeId: null, directChild: true, transform: [1, 0, 0, 1, 0, 0], offsetParentToRoot: [1, 0, 0, 1, 0, 0],
        box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      },
    }, { documentRevision: revision, layoutGeneration, measurementRevision })
    canvasHudProjectionService.start()

    const host = document.createElement('div')
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => { mountedRoot?.render(createElement(SelectionHud)) })
    const toolbar = host.querySelector<HTMLElement>('.mobile-selection-actions')
    expect(toolbar).not.toBeNull()
    expect(toolbar!.dataset.phase).toBe('idle')
    const idleGeneration = toolbar!.dataset.hudGeneration

    await act(async () => { expect(canvasHudProjectionService.publishFlowDragPresentation(flowDrag('active', 1))).toBe(true) })
    expect(toolbar!.dataset.phase).toBe('moving')
    expect(toolbar!.dataset.hudGeneration).toBe(idleGeneration)
    const movingMarkup = toolbar!.outerHTML

    for (let sequence = 2; sequence <= 101; sequence += 1) {
      await act(async () => { expect(canvasHudProjectionService.publishFlowDragPresentation(flowDrag('active', sequence))).toBe(true) })
      expect(toolbar!.outerHTML).toBe(movingMarkup)
    }

    const terminal = flowDrag('terminal-retained', 102)
    await act(async () => { expect(canvasHudProjectionService.publishFlowDragPresentation(terminal)).toBe(true) })
    expect(toolbar!.outerHTML).toBe(movingMarkup)
    const retirement = deepFreeze({
      kind: 'terminal-flow-failure' as const,
      interactionId: terminal.identity.interactionId,
      gestureGeneration: terminal.identity.gestureGeneration,
      terminalSequence: terminal.retention.kind === 'terminal-retained' ? terminal.retention.terminalSampleSequence : -1,
      sourceFence: terminal.fence,
    })
    await act(async () => { expect(canvasHudProjectionService.retireFailedFlowDragHold(retirement)).toBe(true) })
    expect(toolbar!.dataset.phase).toBe('idle')
    expect(toolbar!.dataset.hudGeneration).not.toBe(idleGeneration)
    const retiredMarkup = toolbar!.outerHTML

    await act(async () => { expect(canvasHudProjectionService.retireFailedFlowDragHold(retirement)).toBe(false) })
    expect(toolbar!.outerHTML).toBe(retiredMarkup)

  })
})

describe('PAPER-TEXT-004 mounted canvas text editor boundary', () => {
  it('focuses new text before measurement without removing the existing overlays', async () => {
    window.matchMedia = (() => ({
      matches: false,
      media: '(max-width: 760px)',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })) as typeof window.matchMedia
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true

    const [{ SelectionHud }, { documentStore }, { sceneGeometry }, { canvasHudProjectionService }] = await Promise.all([
      import('./SelectionHud'),
      import('./document-store'),
      import('./scene-geometry'),
      import('./canvas-hud-projection-service'),
    ])
    documentStore.clear()
    sceneGeometry.clear()
    canvasHudProjectionService.stop()
    const source = file()
    source.nodes.selected = { id: 'selected', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, -70, 10], width: 100, height: 70, overflow: 'clip' }, layout: { item: { position: { mode: 'freeform' } } } }
    documentStore.load(source, [], { replace: true, pageId: 'page' })
    documentStore.setViewport({ x: 10, y: -20, zoom: 2 })
    documentStore.setViewportSize({ width: 800, height: 600 })
    documentStore.select('selected')
    sceneGeometry.update({
      selected: {
        canvasKind: 'frame', documentRevision: revision, layoutGeneration,
        rect: { x: -70, y: 10, width: 100, height: 70 }, worldAabb: { x: -70, y: 10, width: 100, height: 70 },
        offset: { x: -70, y: 10, width: 100, height: 70, origin: { x: 50, y: 35 } },
        offsetParentNodeId: null, directChild: true,
        transform: [1, 0, 0, 1, 0, 0], offsetParentToRoot: [1, 0, 0, 1, 0, 0],
        box: { border: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      },
    }, { documentRevision: revision, layoutGeneration, measurementRevision })
    canvasHudProjectionService.start()

    const host = document.createElement('div')
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => { mountedRoot?.render(createElement(SelectionHud)) })
    expect(canvasHudProjectionService.getSnapshot().frame?.byNodeId.selected).toBeDefined()

    await act(async () => { expect(documentStore.commands.insertCanvasText('point', { x: 20, y: 30, parentId: 'selected' })).toBe(true) })
    const nodeId = documentStore.getSnapshot().selection[0]!
    const editor = host.querySelector<HTMLElement>(`[data-editing="${nodeId}"]`)

    expect(editor).not.toBeNull()
    expect(document.activeElement).toBe(editor)
    expect(editor?.style.left).toBe('310.5px')
    expect(editor?.style.top).toBe('370px')
    expect(canvasHudProjectionService.getSnapshot().frame?.byNodeId.selected).toBeDefined()
    expect(documentStore.getSnapshot().textEditing?.nodeId).toBe(nodeId)

    await act(async () => {
      editor!.innerText = 'Typing works'
      editor!.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 's' }))
    })

    expect(host.querySelector(`[data-editing="${nodeId}"]`)).toBe(editor)
    expect(documentStore.getSnapshot().file?.nodes[nodeId]).toMatchObject({ text: 'Typing works' })
    expect(documentStore.getSnapshot().textEditing?.nodeId).toBe(nodeId)
  })

  it('mounts the plaintext editor from the measured text projection during a real edit session', async () => {
    window.matchMedia = (() => ({
      matches: false,
      media: '(max-width: 760px)',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })) as typeof window.matchMedia
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true

    const [{ SelectionHud }, { documentStore }, { sceneGeometry }, { canvasHudProjectionService }] = await Promise.all([
      import('./SelectionHud'),
      import('./document-store'),
      import('./scene-geometry'),
      import('./canvas-hud-projection-service'),
    ])
    const textFile: FileDocument = {
      schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
      fileId: 'hud-client-file',
      revision,
      pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
      nodes: {
        root: { id: 'root', type: 'root' },
        text: {
          id: 'text', type: 'text', name: 'Heading', text: 'Editable',
          styles: { relativeTransform: [1, 0, 0, 1, -70, 10], width: 100, height: 24 },
          textStyle: { fontFamily: 'Inter, sans-serif', fontStyle: 'normal', fontWeight: 400, fontSize: 16, lineHeight: { kind: 'px', value: 24 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false },
          textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
          layout: { item: { position: { mode: 'freeform' } } },
        },
      },
      relationships: { text: { parentId: 'root', orderKey: 'V' } },
      theme: { tokens: {} },
    }
    documentStore.clear()
    sceneGeometry.clear()
    canvasHudProjectionService.stop()
    documentStore.load(textFile, [], { replace: true, pageId: 'page' })
    documentStore.setViewport({ x: 0, y: 0, zoom: 2 })
    documentStore.setViewportSize({ width: 800, height: 600 })
    sceneGeometry.update({
      text: {
        canvasKind: 'text', documentRevision: revision, layoutGeneration,
        rect: { x: -70, y: 10, width: 100, height: 24 }, worldAabb: { x: -70, y: 10, width: 100, height: 24 },
        offset: { x: -70, y: 10, width: 100, height: 24, origin: { x: 50, y: 12 } },
        offsetParentNodeId: null, directChild: true, transform: [1, 0, 0, 1, 0, 0], offsetParentToRoot: [1, 0, 0, 1, 0, 0],
        text: { resolvedLineHeight: 24 },
      },
    }, { documentRevision: revision, layoutGeneration, measurementRevision })
    canvasHudProjectionService.start()
    expect(documentStore.commands.text.begin('text')).not.toBeNull()

    const host = document.createElement('div')
    document.body.append(host)
    mountedRoot = createRoot(host)
    await act(async () => { mountedRoot?.render(createElement(SelectionHud)) })

    const editor = host.querySelector<HTMLElement>('.canvas-text-editor')
    expect(editor).not.toBeNull()
    expect(editor?.getAttribute('contenteditable')).toBe('plaintext-only')
    expect(editor?.getAttribute('aria-label')).toBe('Edit text in Heading')
    expect(editor?.textContent).toBe('Editable')
    expect(editor?.style.transform).toBe('rotate(0deg) scale(2)')

    await act(async () => {
      editor!.innerText = 'First update'
      editor!.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'e' }))
    })
    expect(host.querySelector('.canvas-text-editor')).toBe(editor)
    expect(documentStore.getSnapshot().file?.nodes.text).toMatchObject({ text: 'First update' })

    await act(async () => {
      editor!.innerText = 'Second update'
      editor!.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'e' }))
    })
    expect(host.querySelector('.canvas-text-editor')).toBe(editor)
    expect(documentStore.getSnapshot().file?.nodes.text).toMatchObject({ text: 'Second update' })
  })
})
