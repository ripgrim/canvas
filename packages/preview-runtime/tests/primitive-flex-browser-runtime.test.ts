import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPreviewRuntime } from '../src/index.js'
import { fixtureRegistry } from './fixture-registry.js'

// PAPER-FLEX-001/002 crosses the actual isolated-preview boundary. Expected rectangles and computed declarations are
// independent browser outcomes. The legacy frame beside the flex frame is the negative control for freeform drift.
const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const evidencePath = resolve(import.meta.dirname, '../../../docs/research/evidence/paper-flex/primitive-flex-browser.png')
const solid = (color: string) => ({ fills: [{ type: 'solid', color }] })
const rectangle = (id: string, parentId: string, width: number, height: number, color: string, layout?: object) => ({
  id, kind: 'rectangle', name: id, relativeTransform: [1, 0, 0, 1, 0, 0] as const, width, height, parentId, appearance: solid(color), ...(layout ? { layout } : {}),
})
const previewDocument = {
  version: 2,
  revision: 7,
  rootIds: [],
  nodes: {},
  frame: { width: 800, height: 700, direction: 'column', gap: 0, padding: 0, clip: false },
  canvas: {
    elements: [
      {
        id: 'flex-frame', kind: 'frame', name: 'Flex frame', relativeTransform: [1, 0, 0, 1, -300, -180], width: 260, height: 190, parentId: null, clip: false, appearance: solid('#29292c'),
        layout: { mode: 'freeform', declarations: { display: 'flex', 'flex-direction': 'row', 'flex-wrap': 'wrap', 'justify-content': 'flex-start', 'align-items': 'flex-start', 'align-content': 'flex-start', 'column-gap': '10px', 'row-gap': '10px', 'padding-top': '10px', 'padding-right': '10px', 'padding-bottom': '10px', 'padding-left': '10px' } },
      },
      rectangle('flow-a', 'flex-frame', 100, 60, '#fb7185', { mode: 'flow', declarations: { width: '100px', height: '60px', 'flex-shrink': '0' } }),
      rectangle('flow-b', 'flex-frame', 100, 60, '#60a5fa', { mode: 'flow', declarations: { width: '100px', height: '60px', 'flex-shrink': '0' } }),
      rectangle('flow-c', 'flex-frame', 100, 60, '#4ade80', { mode: 'flow', declarations: { width: '100px', height: '60px', 'flex-shrink': '0' } }),
      { ...rectangle('rotated-flow', 'flex-frame', 50, 30, '#f472b6', { mode: 'flow', declarations: { width: '50px', height: '30px', 'flex-shrink': '0' } }), relativeTransform: [0, 1, -1, 0, 0, 0] as const },
      rectangle('absolute-child', 'flex-frame', 40, 40, '#facc15', { mode: 'absolute', declarations: { position: 'absolute', left: '150px', top: '130px' } }),
      { ...rectangle('rotated-absolute', 'flex-frame', 80, 40, '#22d3ee', { mode: 'absolute', declarations: { position: 'absolute', left: '70px', top: '135px' } }), relativeTransform: [0, 1, -1, 0, 0, 0] as const },
      rectangle('right-edge', 'flex-frame', 30, 20, '#f97316', { mode: 'absolute', declarations: { position: 'absolute', right: '12px', top: '10px' } }),
      rectangle('bottom-edge', 'flex-frame', 30, 20, '#a3e635', { mode: 'absolute', declarations: { position: 'absolute', left: '10px', bottom: '14px' } }),
      rectangle('mixed-edge', 'flex-frame', 25, 25, '#e879f9', { mode: 'absolute', declarations: { position: 'absolute', right: '18px', bottom: '16px' } }),
      {
        id: 'center-frame', kind: 'frame', name: 'Centered flex frame', relativeTransform: [1, 0, 0, 1, 40, 60], width: 200, height: 160, parentId: null, clip: false, appearance: solid('#29292c'),
        layout: { mode: 'freeform', declarations: { display: 'flex', 'justify-content': 'center', 'align-items': 'center' } },
      },
      rectangle('center-child', 'center-frame', 40, 20, '#38bdf8', { mode: 'flow', declarations: { width: '40px', height: '20px', 'flex-shrink': '0' } }),
      { id: 'legacy-frame', kind: 'frame', name: 'Legacy frame', relativeTransform: [1, 0, 0, 1, 40, -180], width: 200, height: 190, parentId: null, clip: false, appearance: solid('#29292c') },
      { id: 'legacy-child', kind: 'rectangle', name: 'Legacy child', relativeTransform: [1, 0, 0, 1, 20, 30], width: 80, height: 40, parentId: 'legacy-frame', appearance: solid('#c084fc') },
    ],
  },
} as const

type Observation = { position: string; display: string; flexWrap: string; width: string; height: string; left: string; right: string; top: string; bottom: string; rect: { x: number; y: number; width: number; height: number } }
let browser: Browser | undefined
let page: Page
let frame: Frame
let previewOrigin = ''
let generation = 0
let dispose: (() => Promise<void>) | undefined

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Primitive flex preview observation timed out')
}

const observe = (id: string): Promise<Observation> => frame.evaluate(nodeId => {
  const element = document.querySelector<HTMLElement>(`[data-preview-canvas="${nodeId}"]`)!
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return { position: style.position, display: style.display, flexWrap: style.flexWrap, width: style.width, height: style.height, left: style.left, right: style.right, top: style.top, bottom: style.bottom, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
}, id)

beforeAll(async () => {
  let previewUrl = ''
  const parent = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><style>html,body{margin:0;background:#1f1f1f}</style><iframe title="Primitive flex preview" sandbox="allow-scripts allow-same-origin" src="${previewUrl}" style="width:800px;height:700px;border:0;display:block"></iframe><script>window.__geometry=[];addEventListener('message',event=>{if(event.data?.type==='geometry')window.__geometry.push(event.data)})</script>`)
  })
  await new Promise<void>(resolveListen => parent.listen(0, '127.0.0.1', resolveListen))
  const editorOrigin = `http://127.0.0.1:${(parent.address() as AddressInfo).port}`
  const service = createPreviewRuntime({ repositoryRoot, editorOrigin, executionTrust: 'fixture-only' })
  dispose = async () => {
    await browser?.close()
    await service.dispose()
    parent.closeAllConnections()
    await new Promise<void>(resolveClose => parent.close(() => resolveClose()))
  }
  const result = await service.start({ componentId: 'fixture-login', entryPath: 'src/PreviewLogin.tsx', exportName: 'PreviewLogin', styles: ['src/globals.css'], registry: fixtureRegistry })
  if (result.status !== 'ready' || !result.url || !result.origin) throw new Error(`Preview did not build: ${JSON.stringify(result.diagnostics)}`)
  previewUrl = result.url
  previewOrigin = result.origin
  generation = result.activeGeneration
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 700 }, deviceScaleFactor: 1 })
  await page.goto(editorOrigin)
  frame = await waitFor(async () => page.frames().find(candidate => candidate.url() === previewUrl), value => Boolean(value)) as Frame
  await frame.waitForSelector('.fixture-input')
  const command = { channel: 'design-editor-preview', version: 9, generation: result.activeGeneration, type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: previewDocument, theme: { attribute: null, colorScheme: 'light' } }
  await page.evaluate(([data, origin]) => { document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string) }, [command, result.origin] as const)
  await frame.waitForSelector('[data-preview-canvas="flow-c"]')
  await waitFor(() => observe('flow-c'), value => value.rect.y > 200)
}, 90_000)

afterAll(async () => { await dispose?.() }, 30_000)

describe('PAPER-FLEX-001/002 primitive DOM layout in a real preview iframe', () => {
  it('wraps direct primitive children with browser-native flex geometry', async () => {
    const parent = await observe('flex-frame')
    const a = await observe('flow-a')
    const b = await observe('flow-b')
    const c = await observe('flow-c')
    expect(parent).toMatchObject({ position: 'absolute', display: 'flex', flexWrap: 'wrap', width: '260px', height: '190px' })
    expect(a).toMatchObject({ position: 'relative', width: '100px', height: '60px' })
    expect(a.rect).toEqual({ x: parent.rect.x + 10, y: parent.rect.y + 10, width: 100, height: 60 })
    expect(b.rect).toEqual({ x: parent.rect.x + 120, y: parent.rect.y + 10, width: 100, height: 60 })
    expect(c.rect).toEqual({ x: parent.rect.x + 10, y: parent.rect.y + 80, width: 100, height: 60 })
  })

  it('preserves an absolute child inside flex and the matrix-native freeform path beside it', async () => {
    const parent = await observe('flex-frame')
    const absolute = await observe('absolute-child')
    const legacyParent = await observe('legacy-frame')
    const legacyChild = await observe('legacy-child')
    expect(absolute).toMatchObject({ position: 'absolute', left: '150px', top: '130px', width: '40px', height: '40px' })
    expect(absolute.rect).toEqual({ x: parent.rect.x + 150, y: parent.rect.y + 130, width: 40, height: 40 })
    expect(legacyParent).toMatchObject({ position: 'absolute', left: '0px', top: '0px', display: 'block', width: '200px', height: '190px' })
    expect(legacyChild).toMatchObject({ position: 'absolute', left: '0px', top: '0px', width: '80px', height: '40px' })
    expect(legacyChild.rect).toEqual({ x: legacyParent.rect.x + 20, y: legacyParent.rect.y + 30, width: 80, height: 40 })
  })

  it('keeps right-only, bottom-only, and mixed far-edge anchors exact in the browser', async () => {
    const parent = await observe('flex-frame')
    const right = await observe('right-edge')
    const bottom = await observe('bottom-edge')
    const mixed = await observe('mixed-edge')
    expect(right.right).toBe('12px')
    expect(right.rect.x + right.rect.width).toBe(parent.rect.x + parent.rect.width - 12)
    expect(bottom.bottom).toBe('14px')
    expect(bottom.rect.y + bottom.rect.height).toBe(parent.rect.y + parent.rect.height - 14)
    expect(mixed).toMatchObject({ right: '18px', bottom: '16px' })
    expect(mixed.rect.x + mixed.rect.width).toBe(parent.rect.x + parent.rect.width - 18)
    expect(mixed.rect.y + mixed.rect.height).toBe(parent.rect.y + parent.rect.height - 16)
  })

  it('keeps a centered flow child centered during an active parent resize', async () => {
    const parentBefore = await observe('center-frame')
    const childBefore = await observe('center-child')
    expect(childBefore.rect.x + childBefore.rect.width / 2).toBe(parentBefore.rect.x + parentBefore.rect.width / 2)
    expect(childBefore.rect.y + childBefore.rect.height / 2).toBe(parentBefore.rect.y + parentBefore.rect.height / 2)

    const geometry = await waitFor(
      () => page.evaluate(() => (window as unknown as { __geometry: Array<{ documentRevision: number; measurementRevision: number }> }).__geometry.filter(message => message.documentRevision === 7).at(-1) ?? null),
      value => value !== null,
    )
    await page.evaluate(([data, origin]) => {
      document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string)
    }, [{
      channel: 'design-editor-preview', version: 9, generation, type: 'set-transient-presentations',
      presentations: [{
        kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'center-resize', sampleSequence: 1,
        fence: { documentRevision: 7, layoutGeneration: 0, measurementRevision: geometry!.measurementRevision },
        items: [{ nodeId: 'center-frame', parentNodeId: null, startRect: { x: 40, y: 60, width: 200, height: 160 }, rect: { x: 40, y: 60, width: 300, height: 240 }, nodeTransform: [1, 0, 0, 1, 0, 0], transformOrigin: { x: 150, y: 120 } }],
      }],
    }, previewOrigin] as const)

    const parentDuring = await waitFor(() => observe('center-frame'), value => value.rect.width === 300 && value.rect.height === 240)
    const childDuring = await observe('center-child')
    expect(childDuring.rect.x + childDuring.rect.width / 2).toBe(parentDuring.rect.x + parentDuring.rect.width / 2)
    expect(childDuring.rect.y + childDuring.rect.height / 2).toBe(parentDuring.rect.y + parentDuring.rect.height / 2)
  })

  it('publishes revision-bound native geometry for every semantic primitive', async () => {
    const geometry = await waitFor(
      () => page.evaluate(() => (window as unknown as { __geometry: Array<{ documentRevision: number; items: Array<{ instanceId: string; bounds: object; worldAabb: object; offsetParentNodeId?: string | null; directChild?: boolean }> }> }).__geometry.find(message => message.documentRevision === 7 && message.items.some(item => item.instanceId === 'flow-c')) ?? null),
      value => value,
    )
    expect(geometry!.documentRevision).toBe(7)
    expect(Object.fromEntries(geometry!.items.map(item => [item.instanceId, item.bounds]))).toMatchObject({ 'flow-a': expect.any(Object), 'flow-b': expect.any(Object), 'flow-c': expect.any(Object), 'absolute-child': expect.any(Object), 'legacy-child': expect.any(Object) })
    expect(geometry!.items.find(item => item.instanceId === 'flow-a')).toMatchObject({ offsetParentNodeId: 'flex-frame', directChild: true, worldAabb: expect.any(Object) })
    expect(geometry!.items.find(item => item.instanceId === 'flex-frame')).toMatchObject({ offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true })
  })

  it('reports unrotated border boxes for one exact editor overlay rotation', async () => {
    const geometry = await waitFor(
      () => page.evaluate(() => (window as unknown as { __geometry: Array<{ documentRevision: number; items: Array<{ instanceId: string; bounds: { x: number; y: number; width: number; height: number }; worldAabb: { x: number; y: number; width: number; height: number } }> }> }).__geometry.find(message => message.documentRevision === 7 && message.items.some(item => item.instanceId === 'rotated-absolute')) ?? null),
      value => value,
    )
    const byId = Object.fromEntries(geometry!.items.map(item => [item.instanceId, item.bounds]))
    const visualById = Object.fromEntries(geometry!.items.map(item => [item.instanceId, item.worldAabb]))
    const flowVisual = await observe('rotated-flow')
    const absoluteVisual = await observe('rotated-absolute')
    expect(byId['rotated-flow']).toMatchObject({ width: 50, height: 30 })
    expect(byId['rotated-absolute']).toMatchObject({ width: 80, height: 40 })
    expect(visualById['rotated-flow']).toMatchObject({ width: 30, height: 50 })
    expect(visualById['rotated-absolute']).toMatchObject({ width: 40, height: 80 })
    expect(byId['rotated-flow']!.x + 25).toBe(flowVisual.rect.x + flowVisual.rect.width / 2)
    expect(byId['rotated-flow']!.y + 15).toBe(flowVisual.rect.y + flowVisual.rect.height / 2)
    expect(byId['rotated-absolute']!.x + 40).toBe(absoluteVisual.rect.x + absoluteVisual.rect.width / 2)
    expect(byId['rotated-absolute']!.y + 20).toBe(absoluteVisual.rect.y + absoluteVisual.rect.height / 2)
  })

  it('captures deterministic visual evidence when explicitly requested', async () => {
    if (process.env.CAPTURE_PAPER_FLEX_EVIDENCE !== '1') return
    await frame.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = '[data-preview-canvas] { outline: 1px solid #e864ff; outline-offset: -1px; }'
      document.head.append(style)
    })
    await mkdir(resolve(evidencePath, '..'), { recursive: true })
    await page.locator('iframe').screenshot({ path: evidencePath })
  })
})
