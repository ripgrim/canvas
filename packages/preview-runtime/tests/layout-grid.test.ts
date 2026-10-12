import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { layoutDeclarations } from '../../repo-engine/src/file-preview.js'
import type { ContentDistribution, GridItem, NodeLayout } from '../../repo-engine/src/layout.js'
import { gridCellAt, gridOverlay } from '../../editor/src/features/editor/grid-overlay'
import { createPreviewRuntime } from '../src/index.js'
import { fixtureRegistry } from './fixture-registry.js'
// Protocol v4: every document node carries its effective theme; the plain light fallback is not explicit.
const lightTheme = { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false } as const

// LAY-GRID-007 and LAY-GRID-006 at the DOM level: a Vite preview build of the fixture repository in headless Edge,
// driven over postMessage protocol v7. The card's Grid comes from the real projection (`layoutDeclarations`), the
// preview measures it, the editor overlay predicts every cell from that measurement, and the real child boxes must sit
// on the predicted cells within 1 px.
//
// Hand derivation. Host frame 480 wide with 24 padding: card 432 wide; the item height is 200 (border-box). Card
// stylesheet border 1; authored padding 12. Content box: left/top inset 1 + 12 = 13, width 432 - 2 - 24 = 406,
// height 200 - 2 - 24 = 174. Columns 100 and 120 with an 8 gap leave 406 - 228 = 178; rows 40 and 30 with a 4 gap
// leave 174 - 74 = 100.
//   space-between columns: column 1 at 13..113, column 2 at 13 + 100 + 8 + 178 = 299..419 (419 + 13 = 432).
//   space-around rows: 50 per track, 25 at each edge: row 1 at 13 + 25 = 38..78, row 2 at 78 + 4 + 50 = 132..162.
//   end columns: offset 178: column 1 at 191..291, column 2 at 299..419.
//   center rows: offset 50: row 1 at 63..103, row 2 at 107..137.
// Children: a and b both explicit at (1, 1) (a collision the browser keeps), c and d automatic. The sparse cursor finds
// (1, 1) taken, so c lands on (2, 1); d finds row 1 full and opens (1, 2).

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const registry = fixtureRegistry
const frameSize = { width: 480, height: 640, direction: 'column', gap: 16, padding: 24, clip: false }
const labels = ['label-a', 'label-b', 'label-c', 'label-d']
const previewDocument = {
  version: 2, revision: 1, rootIds: ['card-1'], frame: frameSize,
  nodes: {
    'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', theme: lightTheme, props: {}, children: { children: labels } },
    ...Object.fromEntries(labels.map(id => [id, { id, componentId: 'atom-label', exportName: 'Label', theme: lightTheme, props: { children: id.slice(-1).toUpperCase() }, children: {} }])),
  },
}
const px = (value: number) => ({ kind: 'px' as const, value })
const cardLayout = (justifyContent: ContentDistribution, alignContent: ContentDistribution): NodeLayout => ({
  item: { position: { mode: 'flow' }, height: { value: px(200) } },
  container: { display: 'grid', gap: { x: 8, y: 4 }, grid: { columns: [px(100), px(120)], rows: [px(40), px(30)], autoFlow: 'row', justifyContent, alignContent } },
  spacing: { padding: 12 },
})
const childLayouts: Record<string, NodeLayout | undefined> = {
  'label-a': { item: { position: { mode: 'flow' }, grid: { columnStart: 1, rowStart: 1 } satisfies GridItem } },
  'label-b': { item: { position: { mode: 'flow' }, grid: { columnStart: 1, rowStart: 1 } satisfies GridItem } },
  'label-c': undefined,
  'label-d': undefined,
}
const entries = (justifyContent: ContentDistribution, alignContent: ContentDistribution) => [
  // Px heights travel in the placement fields, not in the declarations (see `layoutDeclarations`).
  { nodeId: 'card-1', mode: 'flow', x: 0, y: 0, order: 0, height: 200, declarations: layoutDeclarations(cardLayout(justifyContent, alignContent), null) },
  ...labels.map((nodeId, order) => { const declarations = layoutDeclarations(childLayouts[nodeId], 'grid'); return { nodeId, mode: 'flow', x: 0, y: 0, order, ...(declarations ? { declarations } : {}) } }),
]

type Box = { x: number; y: number; width: number; height: number }
type Sides = { top: number; right: number; bottom: number; left: number }
type Geometry = { layoutGeneration?: number; items: { instanceId: string; bounds: Box; box?: { padding: Sides; border: Sides }; layout?: { status: string; conflicts: string[] }; grid?: { columns: number[]; rows: number[]; columnGap: number; rowGap: number; padding: Sides } }[] }
type Dom = { card: Box; children: Record<string, Box>; columnStarts: Record<string, string> }

let browser: Browser | undefined
let page: Page
let frame: Frame
let dispose: (() => Promise<void>) | undefined
let send: (payload: Record<string, unknown>) => Promise<void>
let generationCounter = 100

const readDom = (): Promise<Dom> => frame.evaluate(ids => {
  const box = (element: Element) => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
  const card = document.querySelector('[data-preview-instance="card-1"]')!
  const children: Record<string, Box> = {}, columnStarts: Record<string, string> = {}
  for (const id of ids) { const element = document.querySelector(`[data-preview-instance="${id}"]`)!; children[id] = box(element); columnStarts[id] = getComputedStyle(element).gridColumnStart }
  return { card: box(card), children, columnStarts }
}, labels)
async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Preview observation timed out')
}
async function applyLayout(layoutItems: unknown[]): Promise<{ geometry: Geometry; dom: Dom }> {
  const generation = ++generationCounter
  await send({ type: 'set-layout', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', items: layoutItems, layoutGeneration: generation })
  const geometry = await waitFor(() => page.evaluate(wanted => {
    const all = (window as unknown as { received: (Geometry & { type: string })[] }).received
    return all.filter(message => message.type === 'geometry' && message.layoutGeneration === wanted).at(-1) ?? null
  }, generation), value => value !== null) as Geometry
  return { geometry, dom: await readDom() }
}
const byId = (geometry: Geometry) => Object.fromEntries(geometry.items.map(item => [item.instanceId, item]))
/** Child box relative to the card's top-left corner, rounded to whole pixels for hand comparison. */
const relative = (dom: Dom, id: string) => { const child = dom.children[id]!; return { left: Math.round(child.x - dom.card.x), top: Math.round(child.y - dom.card.y), right: Math.round(child.x + child.width - dom.card.x), bottom: Math.round(child.y + child.height - dom.card.y) } }
const within = (actual: Box, expected: Box, tolerance = 1) => ['x', 'y', 'width', 'height'].every(key => Math.abs(actual[key as keyof Box] - expected[key as keyof Box]) <= tolerance)

beforeAll(async () => {
  let previewUrl = ''
  const parent = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><script>window.received = []; addEventListener('message', event => { if (event.data && event.data.channel === 'design-editor-preview') { window.received.push(event.data); if (window.received.length > 400) window.received.splice(0, 100) } })</script><iframe sandbox="allow-scripts allow-same-origin" src="${previewUrl}" style="width:800px;height:700px;border:0"></iframe>`)
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
  const result = await service.start({ componentId: 'fixture-login', entryPath: 'src/PreviewLogin.tsx', exportName: 'PreviewLogin', styles: ['src/globals.css'], registry })
  if (result.status !== 'ready' || !result.url || !result.origin) throw new Error(`Preview did not build: ${JSON.stringify(result.diagnostics)}`)
  previewUrl = result.url
  const previewOrigin = result.origin
  const generation = result.activeGeneration
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  await page.goto(editorOrigin)
  frame = await waitFor(async () => page.frames().find(candidate => candidate.url() === previewUrl), value => Boolean(value)) as Frame
  await frame.waitForSelector('.fixture-input')
  send = async payload => {
    const command = { channel: 'design-editor-preview', version: 8, generation, ...payload }
    await page.evaluate(([data, origin]) => { document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string) }, [command, previewOrigin] as const)
  }
  await send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: previewDocument })
  await waitFor(() => frame.evaluate(() => document.querySelectorAll('[data-preview-instance="card-1"] > [data-preview-instance]').length), count => count === 4)
}, 90_000)

afterAll(async () => { await dispose?.() }, 30_000)

describe('Grid overlay against real child boxes', () => {
  it('LAY-GRID-007: space-between columns and space-around rows: the measured-plus-modelled overlay matches every child within 1 px', async () => {
    const { geometry, dom } = await applyLayout(entries('space-between', 'space-around'))
    const card = byId(geometry)['card-1']!
    expect(card.layout).toEqual({ status: 'applied', conflicts: [] })
    // What the preview measures: resolved sizes, gaps and padding, but no track offsets.
    expect(card.grid).toEqual({ columns: [100, 120], rows: [40, 30], columnGap: 8, rowGap: 4, padding: { top: 12, right: 12, bottom: 12, left: 12 }, justifyContent: 'space-between', alignContent: 'space-around' })
    expect(card.box!.border).toEqual({ top: 1, right: 1, bottom: 1, left: 1 })
    expect(card.bounds).toMatchObject({ width: 432, height: 200 })
    // The measured bounds and the frame's own boxes share one coordinate space here.
    expect(within(card.bounds, dom.card, 0.01)).toBe(true)

    // Hand-derived boxes relative to the card corner.
    expect(relative(dom, 'label-a')).toEqual({ left: 13, top: 38, right: 113, bottom: 78 })
    expect(relative(dom, 'label-b')).toEqual({ left: 13, top: 38, right: 113, bottom: 78 })
    expect(relative(dom, 'label-c')).toEqual({ left: 299, top: 38, right: 419, bottom: 78 })
    expect(relative(dom, 'label-d')).toEqual({ left: 13, top: 132, right: 113, bottom: 162 })

    const measured = { container: card.bounds, grid: card.grid!, border: card.box!.border, children: {}, distribution: { justifyContent: 'space-between' as const, alignContent: 'space-around' as const } }
    const overlay = gridOverlay(measured)
    expect(overlay.positions).toBe('modelled')
    const cellOf: Record<string, [number, number]> = { 'label-a': [1, 1], 'label-b': [1, 1], 'label-c': [2, 1], 'label-d': [1, 2] }
    for (const [id, [column, row]] of Object.entries(cellOf)) {
      expect(within(dom.children[id]!, overlay.cells[row - 1]![column - 1]!), id).toBe(true)
      const child = dom.children[id]!
      expect(gridCellAt(measured, { x: child.x + child.width / 2, y: child.y + child.height / 2 })).toEqual({ column, row })
    }
    // A point in the widened column gap (card x + 200) is the gutter, not a cell.
    expect(gridCellAt(measured, { x: dom.card.x + 200, y: dom.card.y + 58 })).toEqual({ axis: 'columns', index: 1 })

    // Negative control: tracks plus gaps alone (no distribution) put column 2 at 13 + 108 = 121, far from the real 299.
    const packed = gridOverlay({ ...measured, distribution: {} })
    expect(Math.round(packed.cells[0]![1]!.x - dom.card.x)).toBe(121)
    expect(within(dom.children['label-c']!, packed.cells[0]![1]!)).toBe(false)
  })

  it('LAY-GRID-007: end columns and centred rows', async () => {
    const { geometry, dom } = await applyLayout(entries('end', 'center'))
    const card = byId(geometry)['card-1']!
    expect(relative(dom, 'label-a')).toEqual({ left: 191, top: 63, right: 291, bottom: 103 })
    expect(relative(dom, 'label-c')).toEqual({ left: 299, top: 63, right: 419, bottom: 103 })
    expect(relative(dom, 'label-d')).toEqual({ left: 191, top: 107, right: 291, bottom: 137 })
    const overlay = gridOverlay({ container: card.bounds, grid: card.grid!, border: card.box!.border, children: {}, distribution: { justifyContent: 'end', alignContent: 'center' } })
    expect(within(dom.children['label-a']!, overlay.cells[0]![0]!)).toBe(true)
    expect(within(dom.children['label-c']!, overlay.cells[0]![1]!)).toBe(true)
    expect(within(dom.children['label-d']!, overlay.cells[1]![0]!)).toBe(true)
  })

  it('LAY-GRID-006: the explicit collision persists in the DOM and the automatic children avoid the occupied cell', async () => {
    const { dom } = await applyLayout(entries('start', 'start'))
    expect(dom.columnStarts['label-a']).toBe('1')
    expect(dom.columnStarts['label-b']).toBe('1')
    expect(dom.columnStarts['label-c']).toBe('auto')
    // Start packing: column 1 at 13..113, column 2 at 121..241; row 1 at 13..53, row 2 at 57..87.
    expect(relative(dom, 'label-a')).toEqual({ left: 13, top: 13, right: 113, bottom: 53 })
    expect(relative(dom, 'label-b')).toEqual(relative(dom, 'label-a'))
    expect(relative(dom, 'label-c')).toEqual({ left: 121, top: 13, right: 241, bottom: 53 })
    expect(relative(dom, 'label-d')).toEqual({ left: 13, top: 57, right: 113, bottom: 87 })
  })
})
