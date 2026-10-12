import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPreviewRuntime } from '../src/index.js'
import { fixtureRegistry } from './fixture-registry.js'

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const policy = 'preserve-matching-committed-handoff'
const document = (revision = 1) => ({
  version: 2 as const, revision, rootIds: [], nodes: {},
  frame: { width: 800, height: 600, direction: 'column' as const, gap: 0, padding: 0, clip: false },
  canvas: { elements: [
    { id: 'absolute', kind: 'rectangle' as const, name: 'Absolute', x: 0, y: 0, width: 40, height: 20, rotation: 0, parentId: null, appearance: { fills: [{ type: 'solid' as const, color: '#ff0000' }] }, layout: { mode: 'absolute' as const, declarations: { position: 'absolute' } } },
    { id: 'flow', kind: 'rectangle' as const, name: 'Flow', x: revision === 1 ? 200 : 210, y: revision === 1 ? 100 : 110, width: 40, height: 20, rotation: 0, parentId: null, appearance: { fills: [{ type: 'solid' as const, color: '#00ff00' }] } },
  ] },
})

let browser: Browser | undefined
let page: Page
let frame: Frame
let previewOrigin = ''
let generation = 0
let dispose: (() => Promise<void>) | undefined

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Flow-drag browser observation timed out')
}
const send = async (payload: Record<string, unknown>) => page.evaluate(([data, origin]) => {
  document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string)
}, [{ channel: 'design-editor-preview', version: 8, generation, ...payload }, previewOrigin] as const)
const measurement = async () => {
  let previous = -1
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    const current = await page.evaluate(() => {
      const messages = ((window as unknown as { previewMessages?: Array<{ type?: string; measurementRevision?: number }> }).previewMessages ?? []).filter(message => message.type === 'geometry')
      return messages.at(-1)?.measurementRevision ?? 0
    })
    if (current > 0 && current === previous) return current
    previous = current
  }
  throw new Error('Geometry revision did not stabilize')
}
const geometry = (x: number, y: number) => ({ coordinateSpace: 'world', semanticSize: { width: 40, height: 20 }, quad: [{ x, y }, { x: x + 40, y }, { x: x + 40, y: y + 20 }, { x, y: y + 20 }], aabb: { x, y, width: 40, height: 20 } })
const relationship = { parentId: 'page-root', orderKey: 'a', slot: { presence: 'absent' } }
const common = (interactionId: string, sequence: number, fence: Record<string, unknown>, nodeId: string, mode: 'flow' | 'absolute') => ({
  kind: 'flow-drag', coordinateSpace: 'world', identity: { interactionId, gestureGeneration: 1, sampleSequence: sequence }, fence,
  retention: { kind: 'active', gestureGeneration: 1, sampleSequence: sequence }, pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: 10, y: 10 } },
  original: {
    documentNodeId: nodeId, kind: 'rectangle', name: mode === 'flow' ? 'Flow' : 'Absolute', sourceRelationship: relationship,
    sourceIndex: mode === 'flow' ? 1 : 0, mode, source: mode === 'flow' ? geometry(200, 100) : { coordinateSpace: 'world', semanticSize: { width: 40, height: 20 }, quad: [{ x: 190, y: 90 }, { x: 150, y: 90 }, { x: 150, y: 110 }, { x: 190, y: 110 }], aabb: { x: 150, y: 90, width: 40, height: 20 } },
    current: mode === 'flow' ? geometry(210, 110) : { coordinateSpace: 'world', semanticSize: { width: 40, height: 20 }, quad: [{ x: 200, y: 100 }, { x: 160, y: 100 }, { x: 160, y: 120 }, { x: 200, y: 120 }], aabb: { x: 160, y: 100, width: 40, height: 20 } },
    sourceOffsetParentPose: mode === 'absolute' ? { coordinateSpace: 'source-offset-parent', offsetParentNodeId: null, sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0], matrix: [-1, 0, 0, 1, 200, 100] } : null,
    dom: mode === 'flow' ? { treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null } : { treatment: 'unchanged', opacity: null, opacityPriority: 'normal', zIndex: null },
    namePresentation: { visible: true, anchor: mode === 'flow' ? 'source' : 'current', pose: mode === 'flow' ? geometry(200, 100) : { coordinateSpace: 'world', semanticSize: { width: 40, height: 20 }, quad: [{ x: 200, y: 100 }, { x: 160, y: 100 }, { x: 160, y: 120 }, { x: 200, y: 120 }], aabb: { x: 160, y: 100, width: 40, height: 20 } } },
  },
  movingVisual: mode === 'flow' ? { kind: 'fill-ghost', documentNodeId: null, geometry: geometry(210, 110), fill: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 }, hitTesting: 'none', a11y: 'hidden' } : { kind: 'document-node', documentNodeId: nodeId, geometry: { coordinateSpace: 'world', semanticSize: { width: 40, height: 20 }, quad: [{ x: 200, y: 100 }, { x: 160, y: 100 }, { x: 160, y: 120 }, { x: 200, y: 120 }], aabb: { x: 160, y: 100, width: 40, height: 20 } } },
  supportClone: mode === 'flow' ? { key: { kind: 'flow-support-clone', interactionId, gestureGeneration: 1, cloneGeneration: 1 }, documentNodeId: null, generation: 1, sourceRelationship: relationship, sourceIndex: 1, entryMode: 'flow', entry: null, world: geometry(200, 100), hiddenUntilCommit: true, role: 'inert-marker', layoutParticipation: 'none', hitTesting: 'none', a11y: 'hidden' } : null,
  target: null, hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
  mobileQuickActions: { mounted: true, hidden: true, inert: true, transition: { property: 'opacity', durationMs: 150, source: 'wonder' } },
})
const transaction = (presentation: ReturnType<typeof common>, operation: Record<string, unknown> = { kind: 'publish', presentation }) => ({
  key: { interactionId: presentation.identity.interactionId, gestureGeneration: 1, sequence: presentation.identity.sampleSequence }, sourceFence: presentation.fence, operation,
})
const atGeneration = (presentation: ReturnType<typeof common>, gestureGeneration: number) => ({
  ...presentation,
  identity: { ...presentation.identity, gestureGeneration },
  retention: { ...presentation.retention, gestureGeneration },
  supportClone: presentation.supportClone ? {
    ...presentation.supportClone,
    key: { ...presentation.supportClone.key, gestureGeneration },
  } : null,
})

beforeAll(async () => {
  let previewUrl = ''
  const parent = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><script>window.previewMessages=[];addEventListener('message',event=>window.previewMessages.push(event.data))</script><iframe sandbox="allow-scripts allow-same-origin" src="${previewUrl}" style="width:800px;height:600px;border:0"></iframe>`)
  })
  await new Promise<void>(resolveListen => parent.listen(0, '127.0.0.1', resolveListen))
  const editorOrigin = `http://127.0.0.1:${(parent.address() as AddressInfo).port}`
  const service = createPreviewRuntime({ repositoryRoot, editorOrigin, executionTrust: 'fixture-only' })
  dispose = async () => { await browser?.close(); await service.dispose(); parent.closeAllConnections(); await new Promise<void>(resolveClose => parent.close(() => resolveClose())) }
  const result = await service.start({ componentId: 'fixture-login', entryPath: 'src/PreviewLogin.tsx', exportName: 'PreviewLogin', styles: ['src/globals.css'], registry: fixtureRegistry })
  if (result.status !== 'ready' || !result.url || !result.origin) throw new Error(`Preview did not build: ${JSON.stringify(result.diagnostics)}`)
  previewUrl = result.url; previewOrigin = result.origin; generation = result.activeGeneration
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 })
  await page.goto(editorOrigin)
  frame = await waitFor(async () => page.frames().find(candidate => candidate.url() === previewUrl), Boolean) as Frame
}, 90_000)
afterAll(async () => { await dispose?.() }, 30_000)

describe('PAPER-FLEX-006-RUNTIME-V8, PAPER-FLEX-007-RUNTIME-V8, AT-CAN-005-RUNTIME-V8, and CLOUD-SYNC-GESTURE-001-RUNTIME-V8', () => {
  it('renders exact flow and transformed absolute projections, orders generations, and holds terminal pixels through a document-first commit', async () => {
    await send({ type: 'set-document', flowDragTerminalPolicy: policy, document: document(), theme: { attribute: null, colorScheme: 'light' } })
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    const diagnostics = await page.evaluate(() => (window as unknown as { previewMessages?: unknown[] }).previewMessages ?? [])
    expect(diagnostics.filter((message: any) => message.type === 'diagnostic')).toEqual([])
    await frame.waitForSelector('[data-preview-canvas="flow"]')
    const sourceMeasurement = await measurement()
    const fence = { fileId: 'file', fileRevision: 1, measurementRevision: sourceMeasurement, documentRevision: 1, layoutGeneration: 0, pageId: 'page', pageRootId: 'page-root' }
    const flow = common('flow-drag', 1, fence, 'flow', 'flow')
    const absolute = common('absolute-drag', 1, fence, 'absolute', 'absolute')
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(flow) })
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(absolute) })
    const active = await waitFor(() => frame.evaluate(() => {
      const flowRoot = document.querySelector<HTMLElement>('[data-preview-canvas="flow"]')!
      const absoluteRoot = document.querySelector<HTMLElement>('[data-preview-canvas="absolute"]')!
      const ghost = document.querySelector<HTMLElement>('[data-preview-flow-ghost]')!
      const marker = document.querySelector<HTMLElement>('[data-preview-flow-support-marker]')!
      return { opacity: flowRoot.style.getPropertyValue('opacity'), opacityPriority: flowRoot.style.getPropertyPriority('opacity'), transform: absoluteRoot.style.transform, translate: absoluteRoot.style.translate, rotate: absoluteRoot.style.rotate, scale: absoluteRoot.style.scale, ghosts: document.querySelectorAll('[data-preview-flow-ghost]').length, markerIdentity: marker?.hasAttribute('data-preview-canvas') || marker?.hasAttribute('data-preview-instance'), markerAria: marker?.getAttribute('aria-hidden'), ghostPointer: ghost?.style.pointerEvents }
    }), value => value.opacity === '0.6' && value.transform.includes('matrix('))
    expect(active).toMatchObject({ opacity: '0.6', opacityPriority: 'important', transform: 'matrix(-1, 0, 0, 1, 200, 100)', translate: 'none', rotate: 'none', scale: 'none', ghosts: 1, markerIdentity: false, markerAria: 'true', ghostPointer: 'none' })

    await send({ type: 'apply-flow-drag-transaction', transaction: { ...transaction(flow, { kind: 'tombstone' }), key: { interactionId: 'flow-drag', gestureGeneration: 0, sequence: 99 } } })
    expect(await frame.$eval('[data-preview-canvas="flow"]', element => (element as HTMLElement).style.opacity)).toBe('0.6')

    const terminal = { ...common('flow-drag', 2, fence, 'flow', 'flow'), retention: { kind: 'terminal-retained', gestureGeneration: 1, sampleSequence: 2, terminalReason: 'pointer-up', terminalSampleSequence: 2, holdUntil: 'authoritative-geometry' } }
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(terminal) })
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(terminal, { kind: 'committed-handoff', committed: { previewGeneration: generation, fileId: 'file', pageId: 'page', pageRootId: 'page-root', documentRevision: 2, layoutGeneration: 1, afterMeasurementRevision: sourceMeasurement + 1, terminalSequence: 2 } }) })
    await send({ type: 'set-document', flowDragTerminalPolicy: policy, document: document(2), theme: { attribute: null, colorScheme: 'light' } })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="flow"]', element => (element as HTMLElement).style.opacity), value => value === '0.6')).toBe('0.6')
    await send({ type: 'set-layout', flowDragTerminalPolicy: policy, items: [], layoutGeneration: 1 })
    expect(await waitFor(() => frame.evaluate(() => ({ opacity: document.querySelector<HTMLElement>('[data-preview-canvas="flow"]')!.style.opacity, ghosts: document.querySelectorAll('[data-preview-flow-ghost]').length, markers: document.querySelectorAll('[data-preview-flow-support-marker]').length })), value => value.opacity === '' && value.ghosts === 0)).toStrictEqual({ opacity: '', ghosts: 0, markers: 0 })

    await send({ type: 'apply-flow-drag-transaction', transaction: { ...transaction(absolute), key: { interactionId: 'absolute-drag', gestureGeneration: 2, sequence: 1 }, operation: { kind: 'tombstone' } } })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="absolute"]', element => (element as HTMLElement).style.transform), value => !value.includes('matrix(-1'))).not.toContain('matrix(-1')
  }, 90_000)

  it('keeps terminal pixels through a layout-first commit and never exposes a pre-document rollback frame', async () => {
    const sourceMeasurement = await measurement()
    const fence = { fileId: 'file', fileRevision: 2, measurementRevision: sourceMeasurement, documentRevision: 2, layoutGeneration: 1, pageId: 'page', pageRootId: 'page-root' }
    const active = common('layout-first', 1, fence, 'flow', 'flow')
    const terminal = { ...common('layout-first', 2, fence, 'flow', 'flow'), retention: { kind: 'terminal-retained', gestureGeneration: 1, sampleSequence: 2, terminalReason: 'pointer-up', terminalSampleSequence: 2, holdUntil: 'authoritative-geometry' } }
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(active) })
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(terminal) })
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(terminal, { kind: 'committed-handoff', committed: { previewGeneration: generation, fileId: 'file', pageId: 'page', pageRootId: 'page-root', documentRevision: 3, layoutGeneration: 2, afterMeasurementRevision: sourceMeasurement + 1, terminalSequence: 2 } }) })
    await frame.evaluate(() => {
      ;(window as unknown as { rollbackFrames: string[] }).rollbackFrames = []
      const sample = () => {
        const frames = (window as unknown as { rollbackFrames: string[] }).rollbackFrames
        frames.push(document.querySelector<HTMLElement>('[data-preview-canvas="flow"]')?.style.opacity ?? 'missing')
        if (frames.length < 8) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await send({ type: 'set-layout', flowDragTerminalPolicy: policy, items: [], layoutGeneration: 2 })
    await frame.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    expect(await frame.$eval('[data-preview-canvas="flow"]', element => (element as HTMLElement).style.opacity)).toBe('0.6')
    expect(await frame.evaluate(() => (window as unknown as { rollbackFrames: string[] }).rollbackFrames)).not.toContain('')
    await send({ type: 'set-document', flowDragTerminalPolicy: policy, document: document(3), theme: { attribute: null, colorScheme: 'light' } })
    expect(await waitFor(() => frame.evaluate(() => ({ opacity: document.querySelector<HTMLElement>('[data-preview-canvas="flow"]')!.style.opacity, ghosts: document.querySelectorAll('[data-preview-flow-ghost]').length })), value => value.opacity === '' && value.ghosts === 0)).toStrictEqual({ opacity: '', ghosts: 0 })
  }, 90_000)

  it('rejects stale live fences and same-node competitors, then gives same-sequence tombstones final rank with exact cancellation restoration', async () => {
    await frame.$eval('[data-preview-canvas="flow"]', element => (element as HTMLElement).style.setProperty('opacity', '0.82', 'important'))
    const currentMeasurement = await measurement()
    const currentFence = { fileId: 'file', fileRevision: 3, measurementRevision: currentMeasurement, documentRevision: 3, layoutGeneration: 2, pageId: 'page', pageRootId: 'page-root' }
    const staleFences = [
      { ...currentFence, fileRevision: 2, documentRevision: 2 },
      { ...currentFence, layoutGeneration: 1 },
      { ...currentFence, measurementRevision: currentMeasurement - 1 },
    ]
    for (const [index, staleFence] of staleFences.entries()) {
      const stale = common(`stale-${index}`, 1, staleFence, 'flow', 'flow')
      await send({ type: 'apply-flow-drag-transaction', transaction: transaction(stale) })
    }
    expect(await frame.evaluate(() => ({ opacity: document.querySelector<HTMLElement>('[data-preview-canvas="flow"]')!.style.opacity, ghosts: document.querySelectorAll('[data-preview-flow-ghost]').length }))).toStrictEqual({ opacity: '0.82', ghosts: 0 })

    const owner = common('cancel-owner', 1, currentFence, 'flow', 'flow')
    const competitor = common('cancel-competitor', 1, currentFence, 'flow', 'flow')
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(owner) })
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(competitor) })
    expect(await frame.evaluate(() => ({ opacity: document.querySelector<HTMLElement>('[data-preview-canvas="flow"]')!.style.opacity, ghosts: document.querySelectorAll('[data-preview-flow-ghost]').length }))).toStrictEqual({ opacity: '0.6', ghosts: 1 })
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(owner, { kind: 'tombstone' }) })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="flow"]', element => ({ value: (element as HTMLElement).style.getPropertyValue('opacity'), priority: (element as HTMLElement).style.getPropertyPriority('opacity') })), value => value.value === '0.82')).toStrictEqual({ value: '0.82', priority: 'important' })

    const terminal = { ...common('ranked', 2, currentFence, 'flow', 'flow'), retention: { kind: 'terminal-retained', gestureGeneration: 1, sampleSequence: 2, terminalReason: 'pointer-up', terminalSampleSequence: 2, holdUntil: 'authoritative-geometry' } }
    const handoff = transaction(terminal, { kind: 'committed-handoff', committed: { previewGeneration: generation, fileId: 'file', pageId: 'page', pageRootId: 'page-root', documentRevision: 4, layoutGeneration: 3, afterMeasurementRevision: currentMeasurement + 1, terminalSequence: 2 } })
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(terminal) })
    await send({ type: 'apply-flow-drag-transaction', transaction: handoff })
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(terminal, { kind: 'tombstone' }) })
    await send({ type: 'apply-flow-drag-transaction', transaction: handoff })
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(terminal) })
    expect(await waitFor(() => frame.evaluate(() => ({ opacity: document.querySelector<HTMLElement>('[data-preview-canvas="flow"]')!.style.opacity, ghosts: document.querySelectorAll('[data-preview-flow-ghost]').length })), value => value.ghosts === 0)).toStrictEqual({ opacity: '0.82', ghosts: 0 })
  }, 90_000)

  it('reclaims settled gesture state only after its live fence advances', async () => {
    const sourceMeasurement = await measurement()
    const sourceFence = { fileId: 'file', fileRevision: 3, measurementRevision: sourceMeasurement, documentRevision: 3, layoutGeneration: 2, pageId: 'page', pageRootId: 'page-root' }
    for (let index = 0; index < 24; index += 1) {
      const sample = common(`reclaim-${index}`, 1, sourceFence, 'flow', 'flow')
      await send({ type: 'apply-flow-drag-transaction', transaction: transaction(sample) })
      await send({ type: 'apply-flow-drag-transaction', transaction: transaction(sample, { kind: 'tombstone' }) })
    }
    expect(await waitFor(() => frame.evaluate(() => document.querySelectorAll('[data-preview-flow-ghost]').length), value => value === 0)).toBe(0)

    await frame.$eval('[data-preview-canvas="flow"]', element => (element as HTMLElement).style.width = '41px')
    const nextMeasurement = await measurement()
    expect(nextMeasurement).toBeGreaterThan(sourceMeasurement)

    const stale = common('reclaim-0', 2, sourceFence, 'flow', 'flow')
    await send({ type: 'apply-flow-drag-transaction', transaction: transaction(stale) })
    expect(await frame.evaluate(() => document.querySelectorAll('[data-preview-flow-ghost]').length)).toBe(0)

    const currentFence = { ...sourceFence, measurementRevision: nextMeasurement }
    const reused = atGeneration(common('reclaim-0', 1, currentFence, 'flow', 'flow'), 0)
    await send({ type: 'apply-flow-drag-transaction', transaction: { ...transaction(reused), key: { interactionId: 'reclaim-0', gestureGeneration: 0, sequence: 1 } } })
    expect(await waitFor(() => frame.evaluate(() => document.querySelectorAll('[data-preview-flow-ghost]').length), value => value === 1)).toBe(1)
    await send({ type: 'apply-flow-drag-transaction', transaction: { ...transaction(reused, { kind: 'tombstone' }), key: { interactionId: 'reclaim-0', gestureGeneration: 0, sequence: 1 } } })
    expect(await waitFor(() => frame.evaluate(() => document.querySelectorAll('[data-preview-flow-ghost]').length), value => value === 0)).toBe(0)
  }, 90_000)
})
