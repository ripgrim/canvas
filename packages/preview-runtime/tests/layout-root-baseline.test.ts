import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPreviewRuntime } from '../src/index.js'
import { fixtureRegistry } from './fixture-registry.js'
// Protocol v3: every document node carries its effective theme; the plain light fallback is not explicit.
const lightTheme = { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false } as const

// LAY-ROOT-001 baseline. `applyLayout` and `originalLayout` live inside `startPreview` and are not exported, so this
// drives them through the real boundary: a Vite preview build of the fixture repository, loaded cross-origin in a
// headless Edge iframe, receiving `set-document` and `set-layout` over postMessage. The Electron selection test
// (selection.test.ts, AT-APP-005) already checks button identity, host parent, and byte-equal style restore for a
// component that owns inline styles; this test adds the element count, every root's parent chain, every root's
// declaration priorities, and nested absolute placement.

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const registry = fixtureRegistry
type Declaration = [name: string, value: string, priority: string]
type Root = { id: string; tag: string; chain: string[]; same: boolean | null; declarations: Declaration[]; computed: Record<string, string> }
type Observation = { elementCount: number; roots: Root[] }

const frameSize = { width: 480, height: 640, direction: 'column', gap: 16, padding: 24, clip: false }
const nodes = (buttonAppearance?: object) => ({
  'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', theme: lightTheme, props: { heading: 'Sign in' }, children: { children: ['input-1', 'label-1'] } },
  'input-1': { id: 'input-1', componentId: 'atom-input', exportName: 'Input', theme: lightTheme, props: { id: 'baseline-email', type: 'email' }, children: {} },
  'label-1': { id: 'label-1', componentId: 'atom-label', exportName: 'Label', theme: lightTheme, props: { children: 'Email', htmlFor: 'baseline-email' }, children: {} },
  'button-1': { id: 'button-1', componentId: 'atom-button', exportName: 'Button', theme: lightTheme, props: { children: 'Go', type: 'button' }, children: {}, ...(buttonAppearance ? { appearance: buttonAppearance } : {}) },
})
const previewDocument = (revision: number, buttonAppearance?: object) => ({ version: 1, revision, rootIds: ['card-1', 'button-1'], nodes: nodes(buttonAppearance), frame: frameSize })
const layoutItems = [
  { nodeId: 'button-1', mode: 'absolute', x: 40, y: 60, order: 0, width: 200, height: 44 },
  { nodeId: 'input-1', mode: 'absolute', x: 5, y: 6, order: 0, width: 120 },
  { nodeId: 'label-1', mode: 'flow', x: 0, y: 0, order: 1 },
]
const host = 'div[data-preview-host=]'
const card = 'section[data-preview-instance=card-1][data-preview-component=atom-card]'
// Inline declarations the test itself puts on the mounted roots before any layout or appearance is applied.
const authored: Record<string, Declaration[]> = {
  'button-1': [['width', '150px', 'important'], ['opacity', '0.9', 'important'], ['left', '3px', ''], ['translate', '3px 4px', 'important']],
  'input-1': [['top', '4px', '']],
  'card-1': [['margin-top', '2px', '']],
}

let browser: Browser | undefined
let page: Page
let frame: Frame
let dispose: (() => Promise<void>) | undefined
let send: (payload: Record<string, unknown>) => Promise<void>
const observations: { baseline?: Observation; applied?: Observation; transient?: Observation; transientRestored?: Observation; restored?: Observation } = {}
let sessionMessages: string[] = []

const observe = (): Promise<Observation> => frame.evaluate(() => {
  const container = document.getElementById('preview-root')!
  const label = (element: Element) => element.tagName.toLowerCase() + [...element.attributes].filter(attribute => attribute.name.startsWith('data-preview-') && attribute.name !== 'data-preview-selected').map(attribute => `[${attribute.name}=${attribute.value}]`).join('')
  const chain = (element: Element) => {
    const names: string[] = []
    let node = element.parentElement
    while (node && node !== container) { names.push(label(node)); node = node.parentElement }
    return node === container ? names : [...names, 'outside preview root']
  }
  const known = (window as unknown as { baselineRoots?: Map<string, Element> }).baselineRoots
  const roots = [...container.querySelectorAll<HTMLElement>('[data-preview-instance]')].map(element => {
    const id = element.getAttribute('data-preview-instance')!
    const style = getComputedStyle(element)
    return {
      id, tag: element.tagName.toLowerCase(), chain: chain(element), same: known ? known.get(id) === element : null,
      declarations: Array.from({ length: element.style.length }, (_, index) => element.style.item(index)).map(name => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)] as [string, string, string]),
      computed: { position: style.position, left: style.left, top: style.top, width: style.width, height: style.height, opacity: style.opacity, backgroundColor: style.backgroundColor, order: style.order, translate: style.translate },
    }
  })
  return { elementCount: document.body.getElementsByTagName('*').length, roots }
})
const byId = (observation: Observation) => Object.fromEntries(observation.roots.map(root => [root.id, root]))
const values = (declarations: Declaration[]) => declarations.map(([name, value]) => [name, value])
async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Preview observation timed out')
}
const received = (): Promise<string[]> => page.evaluate(() => (window as unknown as { received: string[] }).received)

beforeAll(async () => {
  let previewUrl = ''
  const parent = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><script>window.received = []; addEventListener('message', event => { if (event.data && event.data.channel === 'design-editor-preview') window.received.push(event.data.type === 'diagnostic' ? 'diagnostic: ' + event.data.message : event.data.type) })</script><iframe sandbox="allow-scripts allow-same-origin" src="${previewUrl}" style="width:900px;height:800px;border:0"></iframe>`)
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
    const command = { channel: 'design-editor-preview', version: 3, generation, ...payload }
    await page.evaluate(([data, origin]) => { document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string) }, [command, previewOrigin] as const)
  }

  await send({ type: 'set-document', document: previewDocument(1) })
  await waitFor(observe, value => value.roots.length === 4)
  await frame.evaluate(styles => {
    const roots = new Map<string, Element>()
    for (const element of document.querySelectorAll<HTMLElement>('[data-preview-instance]')) {
      const id = element.getAttribute('data-preview-instance')!
      roots.set(id, element)
      for (const [name, value, priority] of styles[id] ?? []) element.style.setProperty(name, value, priority)
    }
    (window as unknown as { baselineRoots: Map<string, Element> }).baselineRoots = roots
  }, authored)
  observations.baseline = await observe()

  await send({ type: 'set-document', document: previewDocument(2, { opacity: 0.5, fills: [{ type: 'solid', color: '#ff00ff' }] }) })
  await send({ type: 'set-layout', items: layoutItems, layoutGeneration: 0 })
  observations.applied = await waitFor(observe, value => byId(value)['button-1']?.computed.width === '200px' && byId(value)['button-1']?.computed.opacity === '0.5' && byId(value)['input-1']?.computed.position === 'absolute')

  await send({ type: 'set-transient-move', items: [{ nodeId: 'button-1', dx: 18, dy: -7 }] })
  observations.transient = await waitFor(observe, value => byId(value)['button-1']?.declarations.find(([name]) => name === 'translate')?.[1] === '21px -3px')
  await send({ type: 'set-transient-move', items: [] })
  observations.transientRestored = await waitFor(observe, value => byId(value)['button-1']?.declarations.find(([name]) => name === 'translate')?.[1] === '3px 4px')

  // The authoritative pointer-up document must retire the active transient itself. A later clear message is not
  // required for correctness and must not be the thing that prevents a one-frame stale-position flash.
  await send({ type: 'set-transient-move', items: [{ nodeId: 'button-1', dx: 31, dy: 12 }] })
  await waitFor(observe, value => byId(value)['button-1']?.declarations.find(([name]) => name === 'translate')?.[1] === '34px 16px')

  await send({ type: 'set-document', document: previewDocument(3) })
  await send({ type: 'set-layout', items: [], layoutGeneration: 0 })
  observations.restored = await waitFor(observe, value => byId(value)['button-1']?.computed.width === '150px' && byId(value)['button-1']?.computed.opacity === '0.9' && byId(value)['input-1']?.computed.position === 'static')
  // A ping is answered with ready only while the preview has not failed, so it also proves no uncaught render error.
  await send({ type: 'ping' })
  sessionMessages = await waitFor(received, messages => messages.includes('ready'))
}, 90_000)

afterAll(async () => { await dispose?.() }, 30_000)

describe('LAY-ROOT-001 layout and appearance apply to the bound component roots', () => {
  it('starts from four bound roots under the host with only the authored inline declarations', () => {
    const baseline = observations.baseline!
    // #preview-root, the host, and the section, input, label, and button the atoms render (the built entry script sits in head).
    expect(baseline.elementCount).toBe(6)
    expect(baseline.roots.map(root => [root.id, root.tag, root.chain])).toEqual([
      ['card-1', 'section', [host]],
      ['input-1', 'input', [card, host]],
      ['label-1', 'label', [card, host]],
      ['button-1', 'button', [host]],
    ])
    const roots = byId(baseline)
    expect(roots['button-1']!.declarations).toEqual(authored['button-1'])
    expect(roots['input-1']!.declarations).toEqual(authored['input-1'])
    expect(roots['card-1']!.declarations).toEqual(authored['card-1'])
    // The Label atom owns `padding: 4px 0`; it arrives as four longhands.
    expect(roots['label-1']!.declarations).toEqual([['padding-top', '4px', ''], ['padding-right', '0px', ''], ['padding-bottom', '4px', ''], ['padding-left', '0px', '']])
  })

  it('places and paints the same elements, inserting nothing between the container and any root', () => {
    const applied = observations.applied!
    expect(applied.elementCount).toBe(6)
    expect(applied.roots.map(root => [root.id, root.chain, root.same])).toEqual([
      ['card-1', [host], true],
      ['input-1', [card, host], true],
      ['label-1', [card, host], true],
      ['button-1', [host], true],
    ])
    const roots = byId(applied)
    // A root node uses world coordinates against the host origin (-480/2 + 24, -640/2 + 24) = (-216, -296).
    expect(roots['button-1']!.computed).toMatchObject({ position: 'absolute', left: '256px', top: '356px', width: '200px', height: '44px', opacity: '0.5', backgroundColor: 'rgb(255, 0, 255)', order: '0' })
    // A nested node positions against its component parent, which becomes the containing block.
    expect(roots['input-1']!.computed).toMatchObject({ position: 'absolute', left: '5px', top: '6px', width: '120px', order: '0' })
    expect(roots['card-1']!.computed.position).toBe('relative')
    expect(roots['label-1']!.computed.order).toBe('1')
  })

  it('restores every root to its original inline values and keeps the same elements and parent chain', () => {
    const { baseline, restored } = observations as Required<typeof observations>
    expect(restored.elementCount).toBe(6)
    expect(restored.roots.map(root => [root.id, root.chain, root.same])).toEqual(baseline.roots.map(root => [root.id, root.chain, true]))
    const before = byId(baseline)
    const after = byId(restored)
    for (const id of ['card-1', 'input-1', 'label-1']) expect(after[id]!.declarations, id).toEqual(before[id]!.declarations)
    expect(values(after['button-1']!.declarations)).toEqual(values(before['button-1']!.declarations))
    // The appearance layer restores the priority of the declaration it overrode.
    expect(after['button-1']!.declarations.find(([name]) => name === 'opacity')).toEqual(['opacity', '0.9', 'important'])
    for (const id of ['card-1', 'input-1', 'label-1', 'button-1']) expect(after[id]!.computed, id).toEqual(before[id]!.computed)
    expect(after['button-1']!.computed).toMatchObject({ position: 'static', width: '150px', opacity: '0.9' })
  })

  it('AT-CAN-005 moves the mounted node and restores its authored translate exactly on clear', () => {
    const moved = byId(observations.transient!)['button-1']!
    const restored = byId(observations.transientRestored!)['button-1']!
    expect(moved.declarations.find(([name]) => name === 'translate')).toEqual(['translate', '21px -3px', 'important'])
    expect(restored.declarations.find(([name]) => name === 'translate')).toEqual(['translate', '3px 4px', 'important'])
    expect(restored.computed.translate).toBe(byId(observations.applied!)['button-1']!.computed.translate)
  })

  it('AT-CAN-005 replaces an active transient with the authoritative document without a later clear command', () => {
    const before = byId(observations.baseline!)['button-1']!
    const after = byId(observations.restored!)['button-1']!
    expect(after.declarations.find(([name]) => name === 'translate')).toEqual(['translate', '3px 4px', 'important'])
    expect(after.computed.translate).toBe(before.computed.translate)
    expect(after.computed.left).toBe(before.computed.left)
    expect(after.computed.top).toBe(before.computed.top)
  })

  it('accepted every command without a diagnostic or a render failure', () => {
    expect(sessionMessages).toContain('ready')
    expect(sessionMessages.filter(message => message.startsWith('diagnostic'))).toEqual([])
  })

  // Defect: restoreLayout assigns saved values through `element.style[name] = value`, which drops `!important`.
  // When fixed, this starts passing and `it.fails` turns red; then make it a plain `it`.
  // Observed today: ['width', '150px', ''] after set-layout [] (the value is restored, the priority is not).
  it('LAY-ROOT-001 restores the !important priority of an inline declaration that layout overrode', () => {
    expect(byId(observations.restored!)['button-1']!.declarations.find(([name]) => name === 'width')).toEqual(['width', '150px', 'important'])
  })
})
