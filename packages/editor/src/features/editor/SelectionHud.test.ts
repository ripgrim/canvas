import { createElement } from 'react'
import type { FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { createDocumentStore } from './document-store'
import type { CanvasHudProjectionSnapshot } from './canvas-hud-projection-service'
import type { HudHandlePose, HudProjectionEntry, HudProjectionFrame, HudQuad } from './canvas-hud-projection'
import { resizeHandlePoses, rotationHandlePoses, SelectionHud } from './SelectionHud'

const quad: HudQuad = [{ x: 470, y: 300 }, { x: 470, y: 440 }, { x: 270, y: 440 }, { x: 270, y: 300 }]
const handleNames = ['top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left'] as const
const anchors = ['q0', 'q0-q1', 'q1', 'q1-q2', 'q2', 'q2-q3', 'q3', 'q3-q0'] as const
const centers = [quad[0], { x: 470, y: 370 }, quad[1], { x: 370, y: 440 }, quad[2], { x: 270, y: 370 }, quad[3], { x: 370, y: 300 }] as const
const handles = handleNames.map((handle, index): HudHandlePose => ({ handle, anchor: anchors[index]!, center: centers[index]!, rect: { x: centers[index]!.x - 3.5, y: centers[index]!.y - 3.5, width: 7, height: 7 }, size: 7, active: handle === 'top-left' })) as unknown as HudProjectionEntry['handles']

const file = (locked = false): FileDocument => ({
  schemaVersion: 9, fileId: 'file', revision: 4,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: { root: { id: 'root', type: 'root' }, selected: { id: 'selected', type: 'rectangle', name: 'Selected', isLocked: locked, styles: { left: 0, top: 0, width: 35, height: 50 } } },
  relationships: { selected: { parentId: 'root', orderKey: 'V' } }, theme: { tokens: {} },
})

function entry(policy: { locked?: boolean; readOnly?: boolean } = {}): HudProjectionEntry {
  const interactive = !policy.locked && !policy.readOnly
  return {
    nodeId: 'selected', name: 'Selected', kind: 'rectangle', parentId: null,
    worldQuad: [{ x: 30, y: 10 }, { x: 30, y: 80 }, { x: -70, y: 80 }, { x: -70, y: 10 }], worldAabb: { x: -70, y: 10, width: 100, height: 70 },
    screenQuad: quad, screenAabb: { x: 270, y: 300, width: 200, height: 140 }, dimensions: { width: 35, height: 50 },
    policy: { selected: true, hovered: false, locked: policy.locked ?? false, readOnly: policy.readOnly ?? false, showOutline: true, showLabel: true, showDimensions: true, showHandles: interactive, showQuickActions: false },
    label: { start: quad[3], end: quad[0], normal: { x: 0, y: -1 }, origin: { x: 270, y: 293 }, angle: 0, maxWidth: 200 },
    dimension: { anchor: { x: 370, y: 446 }, width: 35, height: 50 }, handles, controls: interactive ? handles : [], effectiveHandle: 'top-left',
  }
}

function frame(node: HudProjectionEntry, hover: string | null = null): HudProjectionFrame {
  return { key: { fileId: 'file', pageId: 'page', fileRevision: 4, measurementRevision: 12, documentRevision: 4, layoutGeneration: 0, camera: { x: 0, y: 0, zoom: 2 }, size: { width: 800, height: 600 }, selection: ['selected'], hover, tool: 'scale', readOnly: node.policy.readOnly, mobile: false }, entries: [node], byNodeId: { selected: node }, flowDrag: null }
}

function render(node: HudProjectionEntry, locked = false, flowDrag: HudProjectionFrame['flowDrag'] = null, hover: string | null = null) {
  const store = createDocumentStore(() => 'id')
  store.load(file(locked), [], { replace: true, pageId: 'page' })
  store.select('selected')
  store.setHover(hover)
  if (node.policy.readOnly) store.setReadOnly(true)
  const snapshot: CanvasHudProjectionSnapshot = Object.freeze({ generation: 4, frame: { ...frame(node, hover), flowDrag } })
  const projections = { getSnapshot: () => snapshot, subscribe: (_listener: () => void) => () => undefined }
  const TestSelectionHud = SelectionHud as FunctionComponent<NonNullable<Parameters<typeof SelectionHud>[0]>>
  const html = renderToStaticMarkup(createElement(TestSelectionHud, { projections, documents: store }))
  store.dispose()
  return html
}

describe('PAPER-FLEX-006-HUD canonical DOM HUD targets', () => {
  it('CANVAS-RESIZE-SIDES-001 places all corner and one-axis targets at literal projected points', () => {
    const projected = entry()
    const poses = resizeHandlePoses(projected)
    expect(poses[0]).toMatchObject({ handle: 'top-left', center: { x: 470, y: 300 }, active: true, cursor: 'nesw-resize' })
    expect(poses[1]).toMatchObject({ handle: 'top', center: { x: 470, y: 370 }, active: false, cursor: 'ew-resize' })
    const rotation = rotationHandlePoses(projected)
    expect(rotation.map(pose => pose.handle)).toEqual(['top-left', 'top-right', 'bottom-right', 'bottom-left'])
    expect(rotation[0]!.center.x).toBeGreaterThan(470)
    expect(rotation[0]!.center.y).toBeLessThan(300)
    expect(Math.hypot(rotation[0]!.center.x - quad[0].x, rotation[0]!.center.y - quad[0].y)).toBeCloseTo(24)

    const html = render(projected)
    expect(html).toContain('data-hud-generation="4"')
    expect(html).toContain('data-handles-for="selected"')
    expect(html).toContain('data-handle="top-left"')
    expect(html.match(/data-handle=/g)).toHaveLength(8)
    for (const side of ['top', 'right', 'bottom', 'left']) expect(html).toContain(`data-handle="${side}" data-edge="true"`)
    expect(html).toContain('data-rotation-handles-for="selected"')
    expect(html).toContain('data-rotation-handle="top-left"')
    expect(html).toContain('data-active="true"')
    expect(html).toContain('left:470px;top:300px')
    expect(html).not.toContain('left:0%')
    expect(html).not.toContain('width:200px;height:140px')
  })

  it('reveals four inward radius targets only while the eligible selection is hovered', () => {
    const idle = render(entry())
    expect(idle).not.toContain('data-radius-handles-for')

    const hovered = render(entry(), false, null, 'selected')
    expect(hovered).toContain('data-radius-handles-for="selected"')
    expect(hovered.match(/data-radius-handle=/g)).toHaveLength(4)
    expect(hovered).toContain('data-radius-handle="topLeft"')
    expect(hovered).toContain('left:458px;top:312px')
  })

  it('renders passive chrome with zero DOM interaction targets for locked and read-only nodes', () => {
    const locked = render(entry({ locked: true }), true)
    const readOnly = render(entry({ readOnly: true }))
    for (const html of [locked, readOnly]) {
      expect(html).toContain('class="canvas-hud"')
      expect(html).not.toContain('<button')
      expect(html).not.toContain('data-handles-for')
      expect(html).not.toContain('mobile-selection-actions')
    }
  })

  it('keeps the active and retained flow-drag handle layer absent from the DOM', () => {
    const base = entry()
    const hidden = { ...base, policy: { ...base.policy, showOutline: false, showLabel: false, showDimensions: false, showHandles: false, showQuickActions: false }, controls: [] }
    const flow = { documentNodeId: 'selected', identity: { interactionId: 'flow-1', gestureGeneration: 2, sampleSequence: 9 } } as HudProjectionFrame['flowDrag']
    const html = render(hidden, false, flow)
    expect(html).toContain('data-hud-generation="4"')
    expect(html).not.toContain('data-handles-for')
    expect(html).not.toContain('data-handle=')
    expect(html).not.toContain('<button')
  })

  it('renders no interactive chrome when the active projection is absent', () => {
    const store = createDocumentStore(() => 'id')
    store.load(file(), [], { replace: true, pageId: 'page' })
    store.select('selected')
    const snapshot: CanvasHudProjectionSnapshot = Object.freeze({ generation: 5, frame: null })
    const projections = { getSnapshot: () => snapshot, subscribe: (_listener: () => void) => () => undefined }
    const TestSelectionHud = SelectionHud as FunctionComponent<NonNullable<Parameters<typeof SelectionHud>[0]>>
    expect(renderToStaticMarkup(createElement(TestSelectionHud, { projections, documents: store }))).toBe('')
    store.dispose()
  })

  it('fails closed when the observed projection is superseded before DOM rendering', () => {
    const store = createDocumentStore(() => 'id')
    store.load(file(), [], { replace: true, pageId: 'page' })
    store.select('selected')
    const projected = { ...frame(entry()), key: { ...frame(entry()).key, mobile: true } }
    const observed: CanvasHudProjectionSnapshot = Object.freeze({ generation: 5, frame: projected })
    const current: CanvasHudProjectionSnapshot = Object.freeze({ generation: 6, frame: projected })
    let reads = 0
    const projections = { getSnapshot: () => reads++ === 0 ? observed : current, subscribe: (_listener: () => void) => () => undefined }
    const TestSelectionHud = SelectionHud as FunctionComponent<NonNullable<Parameters<typeof SelectionHud>[0]>>

    expect(renderToStaticMarkup(createElement(TestSelectionHud, { projections, documents: store }))).toBe('')
    store.dispose()
  })
})
