import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPreviewRuntime } from '../src/index.js'
import { fixtureRegistry } from './fixture-registry.js'
// Protocol v4: every document node carries its effective theme; the plain light fallback is not explicit.
const lightTheme = { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false } as const

// LAY-ROOT-001, LAY-ROOT-002, LAY-SEC-001 and LAY-GRID-007 through the real boundary: a Vite preview build of the
// fixture repository loaded cross-origin in headless Edge, driven over postMessage with protocol v7. Expected pixel
// values are derived by hand from the fixture stylesheet (card border 1px) and the host frame (480 wide, 24 padding):
// card width 432; authored padding 12 on each side; content width 432 - 2 - 24 = 406; with columns `1fr 120px` and an
// 8px column gap the fr track is 406 - 120 - 8 = 278.

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const registry = fixtureRegistry
const frameSize = { width: 480, height: 640, direction: 'column', gap: 16, padding: 24, clip: false }
const previewDocument = {
  version: 3, revision: 1, rootIds: ['card-1', 'button-1'], frame: frameSize,
  nodes: {
    'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', theme: lightTheme, props: {}, children: { children: ['input-1', 'label-1'] } },
    'input-1': { id: 'input-1', componentId: 'atom-input', exportName: 'Input', theme: lightTheme, props: { id: 'grid-email', type: 'email' }, children: {} },
    'label-1': { id: 'label-1', componentId: 'atom-label', exportName: 'Label', theme: lightTheme, props: { children: 'Email', htmlFor: 'grid-email' }, children: {} },
    'button-1': { id: 'button-1', componentId: 'atom-button', exportName: 'Button', theme: lightTheme, props: { children: 'Go', type: 'button' }, children: {} },
  },
}
const gridCard = { display: 'grid', 'grid-template-columns': '1fr 120px', 'grid-template-rows': 'auto', 'grid-auto-flow': 'row', 'column-gap': '8px', 'row-gap': '4px', 'padding-top': '12px', 'padding-right': '12px', 'padding-bottom': '12px', 'padding-left': '12px' }
const items = (cardDeclarations: Record<string, string> = gridCard, inputDeclarations: Record<string, string> = { 'grid-column-start': '2', 'margin-top': '3px' }) => [
  { nodeId: 'card-1', mode: 'flow', x: 0, y: 0, order: 0, declarations: cardDeclarations },
  { nodeId: 'input-1', mode: 'flow', x: 0, y: 0, order: 0, declarations: inputDeclarations },
  { nodeId: 'label-1', mode: 'flow', x: 0, y: 0, order: 1 },
  { nodeId: 'button-1', mode: 'flow', x: 0, y: 0, order: 1 },
]
type Observed = { count: number; card: { parent: string; inline: string; display: string; columns: string; columnGap: string; paddingLeft: string }; input: { parent: string; gridColumnStart: string; marginTop: string } }
type Geometry = { layoutGeneration?: number; unsupported?: { instanceId: string; status: string }[]; items: { instanceId: string; parentInstanceId?: string | null; directChild?: boolean; layout?: { status: string; conflicts: string[] }; grid?: { columns: number[]; rows: number[]; columnGap: number; rowGap: number; padding: Record<string, number> } }[] }

let browser: Browser | undefined
let page: Page
let frame: Frame
let dispose: (() => Promise<void>) | undefined
let send: (payload: Record<string, unknown>) => Promise<void>
let generationCounter = 10

const observe = (): Promise<Observed> => frame.evaluate(() => {
  const card = document.querySelector<HTMLElement>('[data-preview-instance="card-1"]')!
  const input = document.querySelector<HTMLElement>('[data-preview-instance="input-1"]')!
  const style = getComputedStyle(card), inputStyle = getComputedStyle(input)
  return {
    count: document.getElementById('preview-root')!.getElementsByTagName('*').length,
    card: { parent: card.parentElement!.tagName.toLowerCase() + (card.parentElement!.hasAttribute('data-preview-host') ? '[host]' : ''), inline: card.getAttribute('style') ?? '', display: style.display, columns: style.gridTemplateColumns, columnGap: style.columnGap, paddingLeft: style.paddingLeft },
    input: { parent: input.parentElement!.getAttribute('data-preview-instance') ?? input.parentElement!.tagName.toLowerCase(), gridColumnStart: inputStyle.gridColumnStart, marginTop: inputStyle.marginTop },
  }
})
const geometryFor = (layoutGeneration: number): Promise<Geometry> => waitFor(() => page.evaluate(generation => {
  const all = (window as unknown as { received: Geometry[] }).received
  return all.filter(message => (message as unknown as { type: string }).type === 'geometry' && message.layoutGeneration === generation).at(-1) ?? null
}, layoutGeneration), value => value !== null) as Promise<Geometry>
async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Preview observation timed out')
}
/** Sends a layout with a fresh generation and waits for the geometry measured after it landed. */
async function applyLayout(layoutItems: unknown[]): Promise<{ geometry: Geometry; observed: Observed; generation: number }> {
  const generation = ++generationCounter
  await send({ type: 'set-layout', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', items: layoutItems, layoutGeneration: generation })
  const geometry = await geometryFor(generation)
  return { geometry, observed: await observe(), generation }
}
const byId = (geometry: Geometry) => Object.fromEntries(geometry.items.map(item => [item.instanceId, item]))

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
  await send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: previewDocument })
  await waitFor(observe, value => value.input.parent === 'card-1')
}, 90_000)

afterAll(async () => { await dispose?.() }, 30_000)

describe('layout layer on real component roots', () => {
  it('LAY-ROOT-001 and LAY-GRID-007: Grid declarations land on the actual card root, children stay direct, tracks are measured', async () => {
    const before = await observe()
    expect(before.card).toMatchObject({ parent: 'div[host]', inline: '', display: 'flex' })
    const { geometry, observed, generation } = await applyLayout(items())
    expect(observed.count).toBe(before.count)
    expect(observed.card).toMatchObject({ parent: 'div[host]', display: 'grid', columns: '278px 120px', columnGap: '8px', paddingLeft: '12px' })
    expect(observed.input).toMatchObject({ parent: 'card-1', gridColumnStart: '2', marginTop: '3px' })
    expect(geometry.layoutGeneration).toBe(generation)
    const measured = byId(geometry)
    expect(measured['card-1']).toMatchObject({ parentInstanceId: null, directChild: true, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, -216, -296], layout: { status: 'applied', conflicts: [] }, grid: { columns: [278, 120], columnGap: 8, rowGap: 4, padding: { top: 12, right: 12, bottom: 12, left: 12 } } })
    // The input holds column 2 of row 1, so the sparse cursor cannot return to column 1: the label opens row 2 (input 37 + 3 margin = 40, label 26).
    expect(measured['card-1']!.grid!.rows).toEqual([40, 26])
    expect(measured['input-1']).toMatchObject({ parentInstanceId: 'card-1', directChild: true, layout: { status: 'applied', conflicts: [] } })
    expect(measured['label-1']).toMatchObject({ parentInstanceId: 'card-1', directChild: true })
    expect(measured['button-1']).toMatchObject({ parentInstanceId: null, directChild: true, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, -216, -296] })
    expect(measured['button-1']!.grid).toBeUndefined()
  })

  it('LAY-SEC-001: a stylesheet !important rule on a controlled longhand is reported and wins', async () => {
    await frame.evaluate(() => { const sheet = document.createElement('style'); sheet.id = 'forced'; sheet.textContent = '.fixture-card { display: flex !important; }'; document.head.append(sheet) })
    const forced = await applyLayout(items({ ...gridCard, 'row-gap': '5px' }))
    expect(forced.observed.card.display).toBe('flex')
    expect(byId(forced.geometry)['card-1']!.layout).toEqual({ status: 'applied', conflicts: ['display'] })
    await frame.evaluate(() => document.getElementById('forced')!.remove())
    const released = await applyLayout(items())
    expect(released.observed.card.display).toBe('grid')
    expect(byId(released.geometry)['card-1']!.layout).toEqual({ status: 'applied', conflicts: [] })
  })

  it('LAY-ROOT-002: an ambiguous root reports unsupported and nothing is written to either element', async () => {
    await frame.evaluate(() => { const fake = document.createElement('div'); fake.id = 'fake-card'; fake.setAttribute('data-preview-instance', 'card-1'); fake.setAttribute('data-preview-component', 'atom-card'); document.querySelector('[data-preview-host]')!.append(fake) })
    const { geometry, observed } = await applyLayout(items({ ...gridCard, 'column-gap': '9px' }))
    expect(observed.card).toMatchObject({ inline: '', display: 'flex' })
    expect(await frame.evaluate(() => document.getElementById('fake-card')!.getAttribute('style'))).toBeNull()
    // With two elements claiming card-1 the measurement has no single root either, so the status travels in the unsupported list.
    expect(byId(geometry)['card-1']).toBeUndefined()
    expect(geometry.unsupported).toEqual([{ instanceId: 'card-1', status: 'unsupported-ambiguous-root' }])
    expect(byId(geometry)['input-1']!.layout).toEqual({ status: 'applied', conflicts: [] })
    await frame.evaluate(() => document.getElementById('fake-card')!.remove())
    const restored = await applyLayout(items())
    expect(restored.observed.card.display).toBe('grid')
    expect(restored.geometry.unsupported).toBeUndefined()
  })

  it('LAY-ROOT-002: a modeled child that is not a direct DOM child blocks container declarations but not item declarations', async () => {
    await frame.evaluate(() => { const input = document.querySelector('[data-preview-instance="input-1"]')!; const wrapper = document.createElement('div'); wrapper.id = 'wrapper'; input.parentElement!.insertBefore(wrapper, input); wrapper.append(input) })
    const { geometry, observed } = await applyLayout(items({ ...gridCard, 'column-gap': '10px' }, { 'margin-top': '7px' }))
    expect(observed.card).toMatchObject({ display: 'flex', columnGap: '12px' })
    expect(observed.card.inline).not.toContain('grid')
    expect(observed.input).toMatchObject({ parent: 'div', marginTop: '7px' })
    const measured = byId(geometry)
    expect(measured['card-1']!.layout).toEqual({ status: 'unsupported-indirect-children', conflicts: [] })
    expect(measured['input-1']).toMatchObject({ parentInstanceId: 'card-1', directChild: false })
    await frame.evaluate(() => { const wrapper = document.getElementById('wrapper')!; wrapper.replaceWith(...wrapper.childNodes) })
    const repaired = await applyLayout(items())
    expect(repaired.observed.card.display).toBe('grid')
    expect(byId(repaired.geometry)['card-1']!.layout).toEqual({ status: 'applied', conflicts: [] })
  })

  it('LAY-SEC-001: declarations outside the grammar reject the whole command and leave the previous projection', async () => {
    const applied = await applyLayout(items())
    expect(applied.observed.card.display).toBe('grid')
    for (const bad of [{ display: 'inline-flex' }, { 'grid-template-columns': 'url(x)' }, { width: 'calc(100% - 2px)' }, { color: 'red' }, { 'column-gap': '8px; top: 0' }]) {
      const generation = ++generationCounter
      await send({ type: 'set-layout', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', items: items({ ...gridCard, ...bad }), layoutGeneration: generation })
      await new Promise(resolveWait => setTimeout(resolveWait, 150))
      expect(await page.evaluate(generation => (window as unknown as { received: Geometry[] }).received.some(message => message.layoutGeneration === generation), generation)).toBe(false)
      expect((await observe()).card).toMatchObject({ display: 'grid', columns: '278px 120px', columnGap: '8px' })
    }
  })

  it('LAY-SIZE-001: percent and intrinsic sizes resolve against the real parent box', async () => {
    // Card keeps its stylesheet flex column with 28px padding: content width 432 - 2 - 56 = 374, so 50% is 187px.
    const { observed, geometry } = await applyLayout(items({}, { width: '50%' }).concat())
    expect(observed.card.display).toBe('flex')
    expect(await frame.evaluate(() => getComputedStyle(document.querySelector('[data-preview-instance="input-1"]')!).width)).toBe('187px')
    expect(byId(geometry)['card-1']!.box).toEqual({ padding: { top: 28, right: 28, bottom: 28, left: 28 }, border: { top: 1, right: 1, bottom: 1, left: 1 } })
    const hugged = await applyLayout([{ nodeId: 'button-1', mode: 'flow', x: 0, y: 0, order: 1, declarations: { width: 'fit-content' } }])
    const button = await frame.evaluate(() => { const element = document.querySelector<HTMLElement>('[data-preview-instance="button-1"]')!; return { width: getComputedStyle(element).width, scroll: element.scrollWidth } })
    expect(Number.parseFloat(button.width)).toBeLessThan(432)
    expect(Math.round(Number.parseFloat(button.width))).toBe(button.scroll)
    expect(byId(hugged.geometry)['button-1']!.bounds.width).toBeCloseTo(Number.parseFloat(button.width), 0)
  })

  it('LAY-GEST-004 runtime half: authored right/bottom insets replace the five-field left/top on a root', async () => {
    const { observed } = await applyLayout([{ nodeId: 'button-1', mode: 'absolute', x: 40, y: 60, order: 1, declarations: { right: '10px', bottom: '20px' } }])
    const button = await frame.evaluate(() => { const element = document.querySelector<HTMLElement>('[data-preview-instance="button-1"]')!; const style = getComputedStyle(element); return { inline: element.getAttribute('style'), position: style.position, right: style.right, bottom: style.bottom, left: style.left } })
    expect(button.position).toBe('absolute')
    expect(button.right).toBe('10px')
    expect(button.bottom).toBe('20px')
    expect(button.inline).not.toMatch(/left:|top:/)
    expect(observed.card.display).toBe('flex')
  })

  it('LAY-HUG-001: fit-content with only absolute children takes the children extent plus trailing padding and border', async () => {
    // Children: input at (5, 6) 120 wide, label at (10, 50). Card padding 28 and border 1 (stylesheet). Absolute insets
    // count from the padding edge, so the extent ignores the leading padding: width 1 + (5 + 120) + 28 + 1 = 155;
    // height 1 + max(6 + 37, 50 + 26) + 28 + 1 = 1 + 76 + 29 = 106.
    const { observed, geometry } = await applyLayout([
      { nodeId: 'card-1', mode: 'flow', x: 0, y: 0, order: 0, declarations: { width: 'fit-content', height: 'fit-content' } },
      { nodeId: 'input-1', mode: 'absolute', x: 5, y: 6, order: 0, width: 120 },
      { nodeId: 'label-1', mode: 'absolute', x: 10, y: 50, order: 1 },
      { nodeId: 'button-1', mode: 'flow', x: 0, y: 0, order: 1 },
    ])
    const card = await frame.evaluate(() => { const element = document.querySelector<HTMLElement>('[data-preview-instance="card-1"]')!; const style = getComputedStyle(element); return { width: style.width, height: style.height, position: style.position, boxSizing: style.boxSizing } })
    expect(card).toEqual({ width: '155px', height: '106px', position: 'relative', boxSizing: 'border-box' })
    expect(byId(geometry)['card-1']!.bounds).toMatchObject({ width: 155, height: 106 })
    expect(observed.input).toMatchObject({ parent: 'card-1' })
    // A flow child again: the fallback stops and fit-content is the component's own intrinsic size.
    const released = await applyLayout([
      { nodeId: 'card-1', mode: 'flow', x: 0, y: 0, order: 0, declarations: { width: 'fit-content' } },
      { nodeId: 'input-1', mode: 'absolute', x: 5, y: 6, order: 0, width: 120 },
      { nodeId: 'label-1', mode: 'flow', x: 0, y: 0, order: 1 },
      { nodeId: 'button-1', mode: 'flow', x: 0, y: 0, order: 1 },
    ])
    expect(released.observed.card.inline).toContain('width: fit-content')
    expect(released.observed.card.inline).not.toContain('155px')
  })

  it('LAY-ROOT-001: clearing the layout restores the stylesheet layout and leaves no inline residue', async () => {
    const cleared = await applyLayout([])
    expect(cleared.observed.card).toMatchObject({ inline: '', display: 'flex', columnGap: '12px', paddingLeft: '28px' })
    expect(cleared.observed.input.marginTop).toBe('0px')
    expect(await frame.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-preview-instance]')].map(element => element.style.length))).toEqual([0, 0, 4, 0])
  })
})
