import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPreviewRuntime } from '../src/index.js'
import { fixtureRegistry } from './fixture-registry.js'
// Protocol v4: every document node carries its effective theme; the plain light fallback is not explicit.
const lightTheme = { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false } as const

// LAY-FLEX-001, LAY-FLEX-002, LAY-FLEX-003 and LAY-BLOCK-001 at the DOM level: a Vite preview build of the fixture
// repository in headless Edge, driven over postMessage protocol v7. The card (`.fixture-card`: padding 28, border 1)
// is the only root of a 480 wide host with 24 padding, so it is 432 wide. Its content box starts 1 + 28 = 29 px inside
// its border box on both axes and is 432 - 2 - 56 = 374 wide, so it ends at x 29 + 374 = 403. The three children are
// cards too, sized through the five-field placement (border-box, no flex shrink) with their padding set to zero.
// Every position below is a child's border-box offset from the card's border-box corner, derived by hand.

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const registry = fixtureRegistry
const frameSize = { width: 480, height: 640, direction: 'column', gap: 16, padding: 24, clip: false }
const ids = ['item-a', 'item-b', 'item-c'] as const
const documentWith = (order: readonly string[]) => ({
  version: 3, revision: 1, rootIds: ['card-1'], frame: frameSize,
  nodes: {
    'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', theme: lightTheme, props: {}, children: { children: [...order] } },
    ...Object.fromEntries(ids.map(id => [id, { id, componentId: 'atom-card', exportName: 'Card', theme: lightTheme, props: {}, children: {} }])),
  },
})
type Position = { x: number; y: number }
type Positions = Record<'a' | 'b' | 'c', Position>
type Geometry = { layoutGeneration?: number }
const noPadding = { 'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px' }
/** Card declarations plus three children of one size in a given order; `card` may carry a five-field height. */
function items(card: Record<string, string>, size: { width: number; height: number }, options: { cardHeight?: number; order?: readonly string[]; child?: Partial<Record<(typeof ids)[number], Record<string, string>>> } = {}) {
  const order = options.order ?? ids
  return [
    { nodeId: 'card-1', mode: 'flow', x: 0, y: 0, order: 0, ...(options.cardHeight !== undefined ? { height: options.cardHeight } : {}), declarations: card },
    ...order.map((nodeId, index) => ({ nodeId, mode: 'flow', x: 0, y: 0, order: index, width: size.width, height: size.height, declarations: { ...noPadding, ...(options.child?.[nodeId as (typeof ids)[number]] ?? {}) } })),
  ]
}
const flex = (direction: string, wrap: string, extra: Record<string, string> = {}) => ({ display: 'flex', 'flex-direction': direction, 'flex-wrap': wrap, 'justify-content': 'flex-start', 'align-items': 'flex-start', 'column-gap': '10px', 'row-gap': '10px', ...extra })

let browser: Browser | undefined
let page: Page
let frame: Frame
let dispose: (() => Promise<void>) | undefined
let send: (payload: Record<string, unknown>) => Promise<void>
let generationCounter = 100

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Preview observation timed out')
}
const positions = (): Promise<Positions> => frame.evaluate(() => {
  const card = document.querySelector('[data-preview-instance="card-1"]')!.getBoundingClientRect()
  const at = (id: string) => { const rect = document.querySelector(`[data-preview-instance="${id}"]`)!.getBoundingClientRect(); return { x: Math.round(rect.left - card.left), y: Math.round(rect.top - card.top) } }
  return { a: at('item-a'), b: at('item-b'), c: at('item-c') }
})
const cardStyle = () => frame.evaluate(() => { const card = document.querySelector<HTMLElement>('[data-preview-instance="card-1"]')!; const style = getComputedStyle(card); return { display: style.display, columnGap: style.columnGap, rowGap: style.rowGap, inline: card.getAttribute('style') ?? '' } })
const domOrder = () => frame.evaluate(() => [...document.querySelector('[data-preview-instance="card-1"]')!.children].map(child => child.getAttribute('data-preview-instance')))
/** Sends a layout with a fresh generation, waits for the geometry measured after it landed, then reads positions. */
async function apply(layoutItems: unknown[]): Promise<Positions> {
  const generation = ++generationCounter
  await send({ type: 'set-layout', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', items: layoutItems, layoutGeneration: generation })
  await waitFor(() => page.evaluate(wanted => (window as unknown as { received: Geometry[] }).received.some(message => (message as { type?: string }).type === 'geometry' && message.layoutGeneration === wanted), generation), found => found)
  return positions()
}
async function setOrder(order: readonly string[]) {
  await send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: documentWith(order) })
  await waitFor(domOrder, value => value.join(',') === order.join(','))
}

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
    const command = { channel: 'design-editor-preview', version: 10, generation, ...payload }
    await page.evaluate(([data, origin]) => { document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string) }, [command, previewOrigin] as const)
  }
  await setOrder(ids)
}, 90_000)

afterAll(async () => { await dispose?.() }, 30_000)

describe('Flex and Block on the real card root', () => {
  it('LAY-FLEX-001: four directions render in the expected visual order', async () => {
    const small = { width: 100, height: 40 }
    // row: a at 29, b at 29 + 100 + 10 = 139, c at 139 + 110 = 249; all at y 29.
    expect(await apply(items(flex('row', 'nowrap'), small))).toEqual({ a: { x: 29, y: 29 }, b: { x: 139, y: 29 }, c: { x: 249, y: 29 } })
    // row-reverse: a ends at the content end 403 -> 303; b 303 - 10 - 100 = 193; c 83.
    expect(await apply(items(flex('row-reverse', 'nowrap'), small))).toEqual({ a: { x: 303, y: 29 }, b: { x: 193, y: 29 }, c: { x: 83, y: 29 } })
    // column: y 29, 29 + 40 + 10 = 79, 129; all at x 29.
    expect(await apply(items(flex('column', 'nowrap'), small))).toEqual({ a: { x: 29, y: 29 }, b: { x: 29, y: 79 }, c: { x: 29, y: 129 } })
    // column-reverse in a content-sized card: content height 3 * 40 + 2 * 10 = 140, so a sits at 29 + 140 - 40 = 129, then 79, then 29.
    expect(await apply(items(flex('column-reverse', 'nowrap'), small))).toEqual({ a: { x: 29, y: 129 }, b: { x: 29, y: 79 }, c: { x: 29, y: 29 } })
  }, 30_000)

  it('LAY-FLEX-001: nowrap, wrap and wrap-reverse with children too wide for one line', async () => {
    // Three 150 wide children need 150 * 3 + 2 * 10 = 470 > 374; two need 310, so wrapping puts c on a second line.
    const wide = { width: 150, height: 40 }
    // nowrap (no shrink): 29, 189, 349; c overflows the content box (ends at 499 > 403).
    expect(await apply(items(flex('row', 'nowrap'), wide))).toEqual({ a: { x: 29, y: 29 }, b: { x: 189, y: 29 }, c: { x: 349, y: 29 } })
    // wrap: line 1 a, b; line 2 c at y 29 + 40 + 10 = 79.
    expect(await apply(items(flex('row', 'wrap'), wide))).toEqual({ a: { x: 29, y: 29 }, b: { x: 189, y: 29 }, c: { x: 29, y: 79 } })
    // wrap-reverse: the lines stack from the bottom of the 90 px cross size, so line 1 is at y 79 and line 2 at y 29.
    expect(await apply(items(flex('row', 'wrap-reverse'), wide))).toEqual({ a: { x: 29, y: 79 }, b: { x: 189, y: 79 }, c: { x: 29, y: 29 } })
    // row-reverse with wrap: a at 403 - 150 = 253, b at 253 - 10 - 150 = 93, c starts line 2 at 253.
    expect(await apply(items(flex('row-reverse', 'wrap'), wide))).toEqual({ a: { x: 253, y: 29 }, b: { x: 93, y: 29 }, c: { x: 253, y: 79 } })
    // column wrap in a 160 tall card (content height 160 - 58 = 102): a 29..69 and b 79..119 fit, c (would end at 169)
    // opens a second column at x 29 + 150 + 10 = 189. align-content flex-start keeps the free width out of the lines.
    expect(await apply(items(flex('column', 'wrap', { 'align-content': 'flex-start' }), wide, { cardHeight: 160 }))).toEqual({ a: { x: 29, y: 29 }, b: { x: 29, y: 79 }, c: { x: 189, y: 29 } })
  }, 30_000)

  it('LAY-FLEX-002: the swapped values a direction switch writes keep the anchor; unswapped values move it', async () => {
    // Card 300 tall: content box y 29..271 (242 high), x 29..403 (374 wide). Children 100 x 40, gap 10.
    const small = { width: 100, height: 40 }
    const group = (at: Positions) => ({ right: Math.max(at.a.x, at.b.x, at.c.x) + 100, middle: (Math.min(at.a.y, at.b.y, at.c.y) + Math.max(at.a.y, at.b.y, at.c.y) + 40) / 2 })
    // row, justify end, align center: main run 320 ends at 403 -> a 83, b 193, c 303; y 29 + (242 - 40) / 2 = 130.
    const row = await apply(items(flex('row', 'nowrap', { 'justify-content': 'flex-end', 'align-items': 'center' }), small, { cardHeight: 300 }))
    expect(row).toEqual({ a: { x: 83, y: 130 }, b: { x: 193, y: 130 }, c: { x: 303, y: 130 } })
    // column after the swap (justify center, align end): run 140 centred -> y 29 + 51 = 80, 130, 180; x 403 - 100 = 303.
    const column = await apply(items(flex('column', 'nowrap', { 'justify-content': 'center', 'align-items': 'flex-end' }), small, { cardHeight: 300 }))
    expect(column).toEqual({ a: { x: 303, y: 80 }, b: { x: 303, y: 130 }, c: { x: 303, y: 180 } })
    // Same anchor: the group's right edge is 403 and its vertical middle is 150 in both.
    expect(group(row)).toEqual({ right: 403, middle: 150 })
    expect(group(column)).toEqual({ right: 403, middle: 150 })
    // Negative control: keeping justify end / align center in a column puts the group bottom-centre instead.
    // y 29 + 242 - 140 = 131, x 29 + (374 - 100) / 2 = 166 -> right edge 266, middle 131 + 70 = 201.
    expect(group(await apply(items(flex('column', 'nowrap', { 'justify-content': 'flex-end', 'align-items': 'center' }), small, { cardHeight: 300 })))).toEqual({ right: 266, middle: 201 })
    // space-between stays on the main axis: row spreads x 29, 29 + 100 + 37 = 166, 303; column spreads y 29, 130, 231.
    expect(await apply(items(flex('row', 'nowrap', { 'justify-content': 'space-between', 'align-items': 'flex-end' }), small, { cardHeight: 300 }))).toEqual({ a: { x: 29, y: 231 }, b: { x: 166, y: 231 }, c: { x: 303, y: 231 } })
    expect(await apply(items(flex('column', 'nowrap', { 'justify-content': 'space-between', 'align-items': 'flex-end' }), small, { cardHeight: 300 }))).toEqual({ a: { x: 303, y: 29 }, b: { x: 303, y: 130 }, c: { x: 303, y: 231 } })
  }, 30_000)

  it('LAY-FLEX-003: independent column and row gaps apply, and dropping them restores the stylesheet gap with no inline residue', async () => {
    const wide = { width: 150, height: 40 }
    // column-gap 6: b at 29 + 150 + 6 = 185; row-gap 20: c at 29 + 40 + 20 = 89.
    expect(await apply(items(flex('row', 'wrap', { 'column-gap': '6px', 'row-gap': '20px' }), wide))).toEqual({ a: { x: 29, y: 29 }, b: { x: 185, y: 29 }, c: { x: 29, y: 89 } })
    expect(await cardStyle()).toMatchObject({ display: 'flex', columnGap: '6px', rowGap: '20px' })
    // No gap declarations: the stylesheet's gap 12 is back on both axes (b 29 + 162 = 191, c 29 + 52 = 81).
    const { 'column-gap': _column, 'row-gap': _row, ...withoutGap } = flex('row', 'wrap')
    expect(await apply(items(withoutGap, wide))).toEqual({ a: { x: 29, y: 29 }, b: { x: 191, y: 29 }, c: { x: 29, y: 81 } })
    const style = await cardStyle()
    expect(style).toMatchObject({ columnGap: '12px', rowGap: '12px' })
    expect(style.inline).not.toMatch(/gap/)
  }, 30_000)

  it('LAY-BLOCK-001: a Block conversion of a column-reverse Flex (reversed order, margin-top from the gap) looks the same', async () => {
    const small = { width: 100, height: 40 }
    // Flex column-reverse with gap 12: content height 3 * 40 + 2 * 12 = 144, so a at 29 + 144 - 40 = 133, b 81, c 29.
    const before = await apply(items(flex('column-reverse', 'nowrap', { 'column-gap': '12px', 'row-gap': '12px' }), small))
    expect(before).toEqual({ a: { x: 29, y: 133 }, b: { x: 29, y: 81 }, c: { x: 29, y: 29 } })
    const margin = { 'margin-top': '12px', 'margin-right': '0px', 'margin-bottom': '0px', 'margin-left': '0px' }
    // Negative control: Block with the margins but the old document order stacks a, b, c downwards: a 29, b 81, c 133.
    expect(await apply(items({ display: 'block' }, small, { child: { 'item-b': margin, 'item-c': margin } }))).toEqual({ a: { x: 29, y: 29 }, b: { x: 29, y: 81 }, c: { x: 29, y: 133 } })
    // The conversion: document order c, b, a and margin-top 12 on b and a. c 29, b 29 + 40 + 12 = 81, a 81 + 52 = 133.
    await setOrder(['item-c', 'item-b', 'item-a'])
    const after = await apply(items({ display: 'block' }, small, { order: ['item-c', 'item-b', 'item-a'], child: { 'item-b': margin, 'item-a': margin } }))
    expect((await cardStyle()).display).toBe('block')
    expect(after).toEqual(before)
    // Negative control: without the margins the stack closes up (b 69, a 109), so the margins carry the gap.
    expect(await apply(items({ display: 'block' }, small, { order: ['item-c', 'item-b', 'item-a'] }))).toEqual({ a: { x: 29, y: 109 }, b: { x: 29, y: 69 }, c: { x: 29, y: 29 } })
    await setOrder(ids)
  }, 30_000)
})
