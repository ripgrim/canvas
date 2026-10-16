import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPreviewRuntime, type PreviewBinding } from '../src/index.js'
import type { PreviewDocument, PreviewNodeTheme } from '../src/protocol.js'
import { fixtureRegistry } from './fixture-registry.js'

// CC-NT-010 through CC-NT-014 and CC-NT-016 through the real boundary: Vite preview builds of the fixture repository
// (with its verified theme adapter `src/preview-theme-adapter.tsx`) loaded cross-origin in headless Edge and driven
// over postMessage with protocol v7. Every expected color comes from `fixtures/component-repo/src/globals.css`:
//   :root                 --surface: #ffffff  --ink: #202124
//   [data-theme='dark']   --surface: #242427  --ink: #eeeeef
//   .fixture-card         background: var(--surface); color: var(--ink)
// so a light card paints rgb(255, 255, 255) and a dark card paints #242427 = rgb(0x24, 0x24, 0x27) = rgb(36, 36, 39),
// with dark ink #eeeeef = rgb(238, 238, 239). There is no `[data-theme='light']` rule: the base light theme is the
// absence of the attribute (`attribute: null`).

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const registry = fixtureRegistry
const themeAdapters = [{ entryPath: 'src/preview-theme-adapter.tsx', exportName: 'previewThemeAdapter', evidence: { configPath: 'components.json' } }]
const frameSize = { width: 480, height: 640, direction: 'column', gap: 16, padding: 24, clip: false } as const

const light: PreviewNodeTheme = { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false }
const lightOverride: PreviewNodeTheme = { ...light, explicit: true }
const dark: PreviewNodeTheme = { mode: 'dark', designThemeId: 'dark', attribute: 'dark', colorScheme: 'dark', explicit: true }
const inheritedDark: PreviewNodeTheme = { ...dark, explicit: false }

type Geometry = { type: string; layoutGeneration?: number; items: { instanceId: string; theme?: string }[]; theme?: { nodes: { instanceId: string; status: string }[]; unownedPortals: number } }
type Root = { tag: string; theme: string | null; inline: string; background: string; color: string; colorScheme: string; surface: string; hostParent: boolean; parentInstance: string | null }
type Preview = { page: Page; frame: Frame; send: (payload: Record<string, unknown>) => Promise<void>; close: () => Promise<void> }
type FrameHooks = { __adapterCalls?: { instanceId: string; theme: PreviewNodeTheme }[]; __themeAdapter: { claim: (instanceId: string, root: Element) => void; release: (root: Element) => boolean; owners: () => string[] }; __kept: Record<string, Element> }

let browser: Browser | undefined
let layoutGeneration = 100

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, attempts = 200): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Preview observation timed out')
}

async function openPreview(binding: PreviewBinding, ready: string): Promise<Preview> {
  let previewUrl = ''
  const parent = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><script>window.received = []; addEventListener('message', event => { if (event.data && event.data.channel === 'design-editor-preview') { window.received.push(event.data); if (window.received.length > 400) window.received.splice(0, 100) } })</script><iframe sandbox="allow-scripts allow-same-origin" src="${previewUrl}" style="width:800px;height:700px;border:0"></iframe>`)
  })
  await new Promise<void>(resolveListen => parent.listen(0, '127.0.0.1', resolveListen))
  const editorOrigin = `http://127.0.0.1:${(parent.address() as AddressInfo).port}`
  const service = createPreviewRuntime({ repositoryRoot, editorOrigin, executionTrust: 'fixture-only' })
  const close = async () => {
    await page?.close()
    await service.dispose()
    parent.closeAllConnections()
    await new Promise<void>(resolveClose => parent.close(() => resolveClose()))
  }
  let page: Page | undefined
  const result = await service.start(binding)
  if (result.status !== 'ready' || !result.url || !result.origin) { await close(); throw new Error(`Preview did not build: ${JSON.stringify(result.diagnostics)}`) }
  previewUrl = result.url
  const previewOrigin = result.origin
  const generation = result.activeGeneration
  page = await browser!.newPage({ viewport: { width: 1000, height: 900 } })
  await page.goto(editorOrigin)
  const frame = await waitFor(async () => page!.frames().find(candidate => candidate.url() === previewUrl), value => Boolean(value)) as Frame
  await frame.waitForSelector(ready)
  const target = page
  const send = async (payload: Record<string, unknown>) => {
    const command = { channel: 'design-editor-preview', version: 9, generation, ...payload }
    await target.evaluate(([data, origin]) => { document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string) }, [command, previewOrigin] as const)
  }
  return { page, frame, send, close }
}

/** Sends a layout with a fresh generation; the geometry tagged with it was measured after every earlier command landed. */
async function probe(preview: Preview, items: unknown[] = []): Promise<Geometry> {
  const generation = ++layoutGeneration
  await preview.send({ type: 'set-layout', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', items, layoutGeneration: generation })
  return waitFor(() => preview.page.evaluate(wanted => (window as unknown as { received: Geometry[] }).received.filter(message => message.type === 'geometry' && message.layoutGeneration === wanted).at(-1) ?? null, generation), value => value !== null) as Promise<Geometry>
}
const clearReceived = (preview: Preview) => preview.page.evaluate(() => { (window as unknown as { received: unknown[] }).received.length = 0 })
/** Waits for any geometry event published after `clearReceived` that satisfies the predicate, without sending a command. */
const publishedGeometry = (preview: Preview, predicate: (geometry: Geometry) => boolean, attempts = 80) => waitFor(() => preview.page.evaluate(() => (window as unknown as { received: Geometry[] }).received.filter(message => message.type === 'geometry')), list => list.some(predicate), attempts)
const byId = (geometry: Geometry) => Object.fromEntries(geometry.items.map(item => [item.instanceId, item]))
const unowned = (geometry: Geometry) => geometry.theme?.unownedPortals ?? 0

const readRoot = (frame: Frame, selector: string): Promise<Root> => frame.evaluate(query => {
  const element = document.querySelector<HTMLElement>(query)!
  const style = getComputedStyle(element)
  const ancestor = element.parentElement?.closest('[data-preview-instance]')
  return {
    tag: element.tagName.toLowerCase(),
    theme: element.getAttribute('data-theme'),
    inline: element.getAttribute('style') ?? '',
    background: style.backgroundColor,
    color: style.color,
    colorScheme: style.colorScheme,
    surface: style.getPropertyValue('--surface').trim(),
    hostParent: element.parentElement?.hasAttribute('data-preview-host') ?? false,
    parentInstance: element.parentElement === ancestor ? ancestor?.getAttribute('data-preview-instance') ?? null : null,
  }
}, selector)
const instance = (id: string) => `[data-preview-instance="${id}"]`
const elementCount = (frame: Frame) => frame.evaluate(() => document.getElementById('preview-root')!.getElementsByTagName('*').length)
/** Keeps a reference to an element inside the frame so identity and detached state can be checked later. */
const keep = (frame: Frame, name: string, selector: string) => frame.evaluate(([key, query]) => { const hooks = window as unknown as FrameHooks; hooks.__kept = { ...(hooks.__kept ?? {}), [key!]: document.querySelector(query!)! } }, [name, selector])
const kept = (frame: Frame, name: string) => frame.evaluate(key => { const element = (window as unknown as FrameHooks).__kept[key] as HTMLElement; return { connected: element.isConnected, theme: element.getAttribute('data-theme'), inline: element.getAttribute('style') ?? '' } }, name)
const sameAsKept = (frame: Frame, name: string, selector: string) => frame.evaluate(([key, query]) => (window as unknown as FrameHooks).__kept[key!] === document.querySelector(query!), [name, selector])
const setPrior = (frame: Frame, selector: string) => frame.evaluate(query => { const element = document.querySelector<HTMLElement>(query)!; element.setAttribute('data-theme', 'paper'); element.style.setProperty('color-scheme', 'light', 'important') }, selector)
/** Inline longhands with priority, so the theme layer's effect on another layer's declarations is compared per property. */
const inlineMap = (frame: Frame, selector: string) => frame.evaluate(query => {
  const style = document.querySelector<HTMLElement>(query)!.style
  return Object.fromEntries(Array.from({ length: style.length }, (_, index) => style.item(index)).map(name => [name, `${style.getPropertyValue(name)}${style.getPropertyPriority(name) ? ' !important' : ''}`]))
}, selector)

beforeAll(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }) }, 30_000)
afterAll(async () => { await browser?.close() }, 30_000)

describe('per-node theme layer in composition mode', () => {
  let preview: Preview
  // card-1 holds a nested card-2 and button-1; card-3 is a light sibling control. card-1 may move under card-3 (remount).
  const compose = (themes: Partial<Record<'card-1' | 'card-2' | 'card-3' | 'button-1', PreviewNodeTheme>> = {}, options: { moved?: boolean; cardAppearance?: boolean } = {}): PreviewDocument => ({
    version: 2, revision: 1, rootIds: options.moved ? ['card-3'] : ['card-1', 'card-3'], frame: frameSize,
    nodes: {
      'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', props: {}, children: { children: ['card-2', 'button-1'] }, theme: themes['card-1'] ?? light, ...(options.cardAppearance ? { appearance: { opacity: 0.5 } } : {}) },
      'card-2': { id: 'card-2', componentId: 'atom-card', exportName: 'Card', props: { heading: 'Nested' }, children: {}, theme: themes['card-2'] ?? light },
      'button-1': { id: 'button-1', componentId: 'atom-button', exportName: 'Button', props: { children: 'Go', type: 'button' }, children: {}, theme: themes['button-1'] ?? light },
      'card-3': { id: 'card-3', componentId: 'atom-card', exportName: 'Card', props: { heading: 'Sibling' }, children: { children: options.moved ? ['card-1'] : [] }, theme: themes['card-3'] ?? light },
    },
  })
  const darkCard = (options: { moved?: boolean; cardAppearance?: boolean } = {}) => compose({ 'card-1': dark, 'card-2': inheritedDark, 'button-1': inheritedDark }, options)
  const lightTheme = { attribute: null, colorScheme: 'light' }

  beforeAll(async () => {
    preview = await openPreview({ componentId: 'fixture-login', entryPath: 'src/PreviewLogin.tsx', exportName: 'PreviewLogin', styles: ['src/globals.css'], registry, themeAdapters }, '.fixture-input')
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: compose(), theme: lightTheme })
    await waitFor(() => preview.frame.evaluate(() => document.querySelectorAll('[data-preview-instance]').length), count => count === 4)
  }, 90_000)
  afterAll(async () => { await preview?.close() }, 30_000)

  it('CC-NT-010: an explicit dark card stamps its actual section root; the nested child inherits through the DOM and the document stays light', async () => {
    await probe(preview)
    const before = { count: await elementCount(preview.frame), card: await readRoot(preview.frame, instance('card-1')) }
    // Host div + card-1 section + card-2 section + button + card-3 section; headings are text nodes.
    expect(before.count).toBe(5)
    expect(before.card).toMatchObject({ tag: 'section', theme: null, inline: '', background: 'rgb(255, 255, 255)', hostParent: true })
    await keep(preview.frame, 'card', instance('card-1'))

    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: darkCard(), theme: lightTheme })
    const geometry = await probe(preview)
    const card = await readRoot(preview.frame, instance('card-1'))
    expect(await sameAsKept(preview.frame, 'card', instance('card-1'))).toBe(true)
    expect(await elementCount(preview.frame)).toBe(5)
    expect(card).toEqual({ tag: 'section', theme: 'dark', inline: 'color-scheme: dark;', background: 'rgb(36, 36, 39)', color: 'rgb(238, 238, 239)', colorScheme: 'dark', surface: '#242427', hostParent: true, parentInstance: null })
    // The nested card has no attribute or inline value of its own and still paints the dark surface through inheritance.
    expect(await readRoot(preview.frame, instance('card-2'))).toMatchObject({ tag: 'section', theme: null, inline: '', background: 'rgb(36, 36, 39)', colorScheme: 'dark', parentInstance: 'card-1' })
    // Negative controls: the sibling card and the document root stay on the light fallback.
    expect(await readRoot(preview.frame, instance('card-3'))).toMatchObject({ theme: null, inline: '', background: 'rgb(255, 255, 255)', surface: '#ffffff' })
    expect(await preview.frame.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(), scheme: document.documentElement.style.colorScheme }))).toEqual({ theme: null, surface: '#ffffff', scheme: 'light' })
    const measured = byId(geometry)
    expect(measured['card-1']!.theme).toBe('applied')
    expect(measured['card-2']!.theme).toBeUndefined()
    expect(geometry.theme).toBeUndefined()

    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: compose(), theme: lightTheme })
    await probe(preview)
    expect(await readRoot(preview.frame, instance('card-1'))).toMatchObject({ theme: null, inline: '', background: 'rgb(255, 255, 255)' })
    expect(await readRoot(preview.frame, instance('card-2'))).toMatchObject({ background: 'rgb(255, 255, 255)' })
  })

  it('CC-NT-012: the adapter boundary receives each claimed instance and its effective theme without adding DOM', async () => {
    await preview.frame.evaluate(() => { (window as unknown as FrameHooks).__adapterCalls = [] })
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: darkCard(), theme: lightTheme })
    await probe(preview)
    const calls = await preview.frame.evaluate(() => [...(window as unknown as FrameHooks).__adapterCalls!].sort((left, right) => left.instanceId.localeCompare(right.instanceId)))
    // One render: every atom-card node once with its own theme; button-1 is not a component the adapter claims.
    expect(calls).toEqual([
      { instanceId: 'card-1', theme: { mode: 'dark', designThemeId: 'dark', attribute: 'dark', colorScheme: 'dark', explicit: true } },
      { instanceId: 'card-2', theme: { mode: 'dark', designThemeId: 'dark', attribute: 'dark', colorScheme: 'dark', explicit: false } },
      { instanceId: 'card-3', theme: { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false } },
    ])
    expect(await readRoot(preview.frame, instance('card-1'))).toMatchObject({ hostParent: true })
    expect(await readRoot(preview.frame, instance('card-2'))).toMatchObject({ parentInstance: 'card-1' })
    expect(await readRoot(preview.frame, instance('button-1'))).toMatchObject({ parentInstance: 'card-1' })
    expect(await elementCount(preview.frame)).toBe(5)
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: compose(), theme: lightTheme })
    await probe(preview)
  })

  it('CC-NT-016: a theme update leaves layout and appearance declarations on the same root untouched', async () => {
    const layout = [{ nodeId: 'card-1', mode: 'flow', x: 0, y: 0, order: 0, declarations: { 'padding-top': '12px', 'row-gap': '4px' } }]
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: compose({}, { cardAppearance: true }), theme: lightTheme })
    await probe(preview, layout)
    const baseline = await inlineMap(preview.frame, instance('card-1'))
    // Appearance opacity 0.5 and the two layout longhands are present before any theme is involved.
    expect(baseline).toMatchObject({ opacity: '0.5', 'padding-top': '12px', 'row-gap': '4px' })
    expect(baseline['color-scheme']).toBeUndefined()

    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: darkCard({ cardAppearance: true }), theme: lightTheme })
    await probe(preview, layout)
    expect(await inlineMap(preview.frame, instance('card-1'))).toEqual({ ...baseline, 'color-scheme': 'dark' })
    const themed = await preview.frame.evaluate(() => { const element = document.querySelector<HTMLElement>('[data-preview-instance="card-1"]')!; const style = getComputedStyle(element); return { theme: element.getAttribute('data-theme'), opacity: style.opacity, paddingTop: style.paddingTop, rowGap: style.rowGap, background: style.backgroundColor } })
    expect(themed).toEqual({ theme: 'dark', opacity: '0.5', paddingTop: '12px', rowGap: '4px', background: 'rgb(36, 36, 39)' })

    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: compose({}, { cardAppearance: true }), theme: lightTheme })
    await probe(preview, layout)
    expect(await inlineMap(preview.frame, instance('card-1'))).toEqual(baseline)
    expect((await readRoot(preview.frame, instance('card-1'))).theme).toBeNull()
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: compose(), theme: lightTheme })
    await probe(preview, [])
    expect(await readRoot(preview.frame, instance('card-1'))).toMatchObject({ inline: '' })
  })

  it('CC-NT-014: an ambiguous or missing root is reported and left alone; unclaimed body children count as unowned portals', async () => {
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: darkCard(), theme: lightTheme })
    expect(byId(await probe(preview))['card-1']!.theme).toBe('applied')
    await preview.frame.evaluate(() => { const fake = document.createElement('div'); fake.id = 'fake-card'; fake.setAttribute('data-preview-instance', 'card-1'); fake.setAttribute('data-preview-component', 'atom-card'); document.querySelector('[data-preview-host]')!.append(fake) })
    const ambiguous = await probe(preview)
    expect(ambiguous.theme).toEqual({ nodes: [{ instanceId: 'card-1', status: 'unsupported-ambiguous-root' }], unownedPortals: 0 })
    expect(byId(ambiguous)['card-1']).toBeUndefined()
    expect(await readRoot(preview.frame, '.fixture-card[data-preview-instance="card-1"]')).toMatchObject({ theme: null, inline: '', background: 'rgb(255, 255, 255)' })
    expect(await readRoot(preview.frame, '#fake-card')).toMatchObject({ theme: null, inline: '' })
    await preview.frame.evaluate(() => document.getElementById('fake-card')!.remove())
    const repaired = await probe(preview)
    expect(repaired.theme).toBeUndefined()
    expect(byId(repaired)['card-1']!.theme).toBe('applied')
    expect((await readRoot(preview.frame, instance('card-1'))).theme).toBe('dark')

    // Without its instance attribute the card has no root at all.
    await preview.frame.evaluate(() => document.querySelector('[data-preview-instance="card-1"]')!.setAttribute('data-preview-instance', 'detached-card'))
    const missing = await probe(preview)
    expect(missing.theme).toEqual({ nodes: [{ instanceId: 'card-1', status: 'unsupported-no-root' }], unownedPortals: 0 })
    expect(await readRoot(preview.frame, '[data-preview-instance="detached-card"]')).toMatchObject({ theme: null, inline: '' })
    await preview.frame.evaluate(() => document.querySelector('[data-preview-instance="detached-card"]')!.setAttribute('data-preview-instance', 'card-1'))
    expect(byId(await probe(preview))['card-1']!.theme).toBe('applied')

    // A plain element and a dialog nobody pressed for are both unattributable, so both are counted and neither is styled.
    await preview.frame.evaluate(() => { const stray = document.createElement('div'); stray.id = 'stray'; document.body.append(stray) })
    expect(unowned(await probe(preview))).toBe(1)
    await preview.frame.evaluate(() => { const dialog = document.createElement('div'); dialog.id = 'stray-dialog'; dialog.setAttribute('role', 'dialog'); document.body.append(dialog) })
    expect(unowned(await probe(preview))).toBe(2)
    expect(await readRoot(preview.frame, '#stray-dialog')).toMatchObject({ theme: null, inline: '' })
    await preview.frame.evaluate(() => { document.getElementById('stray')!.remove(); document.getElementById('stray-dialog')!.remove() })
    const cleared = await probe(preview)
    expect(unowned(cleared)).toBe(0)
    expect(cleared.theme).toBeUndefined()
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: compose(), theme: lightTheme })
    await probe(preview)
  })

  it('CC-NT-011: a prior attribute and important inline value are restored after removal, root replacement and dispose', async () => {
    await setPrior(preview.frame, instance('card-1'))
    await keep(preview.frame, 'first', instance('card-1'))
    await probe(preview)
    expect(await readRoot(preview.frame, instance('card-1'))).toMatchObject({ theme: 'paper', inline: 'color-scheme: light !important;' })

    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: darkCard(), theme: lightTheme })
    await probe(preview)
    // The prior inline value was important, so the override keeps that priority.
    expect(await readRoot(preview.frame, instance('card-1'))).toMatchObject({ theme: 'dark', inline: 'color-scheme: dark !important;', background: 'rgb(36, 36, 39)' })

    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: compose(), theme: lightTheme })
    await probe(preview)
    expect(await readRoot(preview.frame, instance('card-1'))).toMatchObject({ theme: 'paper', inline: 'color-scheme: light !important;', background: 'rgb(255, 255, 255)' })

    // Moving card-1 under card-3 makes React mount a new section; the old one is restored, the new one is stamped fresh.
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: darkCard(), theme: lightTheme })
    await probe(preview)
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: darkCard({ moved: true }), theme: lightTheme })
    await probe(preview)
    expect(await sameAsKept(preview.frame, 'first', instance('card-1'))).toBe(false)
    expect(await kept(preview.frame, 'first')).toEqual({ connected: false, theme: 'paper', inline: 'color-scheme: light !important;' })
    expect(await readRoot(preview.frame, instance('card-1'))).toMatchObject({ theme: 'dark', inline: 'color-scheme: dark;', parentInstance: 'card-3', background: 'rgb(36, 36, 39)' })

    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: compose({}, { moved: true }), theme: lightTheme })
    await probe(preview)
    expect(await readRoot(preview.frame, instance('card-1'))).toMatchObject({ theme: null, inline: '' })
    await setPrior(preview.frame, instance('card-1'))
    await keep(preview.frame, 'last', instance('card-1'))
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: darkCard({ moved: true }), theme: lightTheme })
    await probe(preview)
    expect(await readRoot(preview.frame, instance('card-1'))).toMatchObject({ theme: 'dark', inline: 'color-scheme: dark !important;' })
    await preview.send({ type: 'dispose' })
    await waitFor(() => preview.frame.evaluate(() => document.querySelector('[data-preview-host]') === null), gone => gone)
    expect(await kept(preview.frame, 'last')).toEqual({ connected: false, theme: 'paper', inline: 'color-scheme: light !important;' })
  })
})

describe('portal ownership through the verified adapter in source mode', () => {
  let preview: Preview
  // The bound PreviewLogin: one Card holding two labelled inputs and the Sign in button that opens the dialog portal.
  const source = (themes: Partial<Record<'card-1' | 'button-1', PreviewNodeTheme>> = {}, rest: PreviewNodeTheme = light): PreviewDocument => ({
    version: 2, revision: 1, rootIds: ['card-1'], frame: frameSize,
    nodes: {
      'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', props: {}, children: { children: ['label-email', 'input-email', 'label-password', 'input-password', 'button-1'] }, theme: themes['card-1'] ?? light },
      'label-email': { id: 'label-email', componentId: 'atom-label', exportName: 'Label', props: { htmlFor: 'email', children: 'Email' }, children: {}, theme: rest },
      'input-email': { id: 'input-email', componentId: 'atom-input', exportName: 'Input', props: { id: 'email', type: 'email' }, children: {}, theme: rest },
      'label-password': { id: 'label-password', componentId: 'atom-label', exportName: 'Label', props: { htmlFor: 'password', children: 'Password' }, children: {}, theme: rest },
      'input-password': { id: 'input-password', componentId: 'atom-input', exportName: 'Input', props: { id: 'password', type: 'password' }, children: {}, theme: rest },
      'button-1': { id: 'button-1', componentId: 'atom-button', exportName: 'Button', props: { children: 'Sign in' }, children: {}, theme: themes['button-1'] ?? light },
    },
  })
  const darkLogin = () => source({ 'card-1': dark, 'button-1': inheritedDark }, inheritedDark)
  const overrideLogin = () => source({ 'card-1': dark, 'button-1': lightOverride }, inheritedDark)
  const dialog = '[role="dialog"]'
  const hooks = (script: string, owner?: string) => preview.frame.evaluate(([action, id]) => {
    const adapter = (window as unknown as FrameHooks).__themeAdapter
    const root = document.querySelector('[role="dialog"]')!
    if (action === 'claim') adapter.claim(id!, root)
    if (action === 'release') adapter.release(root)
    if (action === 'clear') { root.removeAttribute('data-theme'); root.removeAttribute('style') }
    return adapter.owners()
  }, [script, owner])

  beforeAll(async () => {
    preview = await openPreview({ componentId: 'fixture-login', entryPath: 'src/PreviewLogin.tsx', exportName: 'PreviewLogin', styles: ['src/globals.css'], registry, themeAdapters, sourceDocument: source() }, '[data-preview-instance="button-1"]')
  }, 90_000)
  afterAll(async () => { await preview?.close() }, 30_000)

  it('AT-PRV-001 mounts a newly inserted registered component as its real source export', async () => {
    const document = source()
    document.revision = 2
    document.rootIds = [...document.rootIds, 'card-added']
    document.nodes['card-added'] = { id: 'card-added', componentId: 'atom-card', exportName: 'Card', props: { heading: 'Added card' }, children: {}, theme: light }
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document })
    await preview.frame.waitForSelector('section[data-preview-instance="card-added"][data-preview-component="atom-card"]')
    const inserted = await preview.frame.locator('[data-preview-instance="card-added"]').evaluate(element => ({ tag: element.tagName.toLowerCase(), className: element.className, text: element.textContent }))
    expect(inserted).toEqual({ tag: 'section', className: 'fixture-card', text: 'Added card' })
  })

  it('CC-NT-013: a dialog portal opened from a dark card takes its owner theme, a child override wins, and releasing the claim restores the root', async () => {
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: darkLogin() })
    await probe(preview)
    expect(await readRoot(preview.frame, instance('card-1'))).toMatchObject({ tag: 'section', theme: 'dark', inline: 'color-scheme: dark;', background: 'rgb(36, 36, 39)' })
    expect(await preview.frame.locator(dialog).count()).toBe(0)

    await preview.frame.click('button:has-text("Sign in")')
    await preview.frame.waitForSelector(dialog)
    const opened = await probe(preview)
    // The pressed instance is button-1, whose effective (inherited, not explicit) theme is the card's dark theme.
    expect(await hooks('owners')).toEqual(['button-1'])
    expect(await preview.frame.evaluate(() => document.querySelector('[role="dialog"]')!.parentElement === document.body)).toBe(true)
    expect(await readRoot(preview.frame, dialog)).toMatchObject({ theme: 'dark', inline: 'color-scheme: dark;', colorScheme: 'dark', surface: '#242427' })
    expect(unowned(opened)).toBe(0)
    expect((await readRoot(preview.frame, instance('button-1'))).theme).toBeNull()

    // The child's own light override wins over the card for the portal it owns; the card stays dark.
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: overrideLogin() })
    await probe(preview)
    expect(await readRoot(preview.frame, dialog)).toMatchObject({ theme: null, inline: 'color-scheme: light;', colorScheme: 'light', surface: '#ffffff' })
    expect(await readRoot(preview.frame, instance('button-1'))).toMatchObject({ theme: null, inline: 'color-scheme: light;' })
    expect(await readRoot(preview.frame, instance('card-1'))).toMatchObject({ theme: 'dark', background: 'rgb(36, 36, 39)' })

    // Releasing the claim restores the root and leaves it as an unowned body child.
    expect(await hooks('release')).toEqual([])
    expect(await readRoot(preview.frame, dialog)).toMatchObject({ theme: null, inline: '', surface: '#ffffff' })
    expect(unowned(await probe(preview))).toBe(1)

    // A root with its own prior attribute and important inline value gets exactly those back when the claim goes.
    await preview.frame.evaluate(() => { const root = document.querySelector<HTMLElement>('[role="dialog"]')!; root.setAttribute('data-theme', 'paper'); root.style.setProperty('color-scheme', 'light', 'important') })
    expect(await hooks('claim', 'card-1')).toEqual(['card-1'])
    expect(await readRoot(preview.frame, dialog)).toMatchObject({ theme: 'dark', inline: 'color-scheme: dark !important;', surface: '#242427' })
    expect(unowned(await probe(preview))).toBe(0)
    await hooks('release')
    expect(await readRoot(preview.frame, dialog)).toMatchObject({ theme: 'paper', inline: 'color-scheme: light !important;' })
    await hooks('clear')
  })

  it('CC-NT-014: two owners with different themes make a conflicting portal that is left untouched', async () => {
    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: darkLogin() })
    expect(await hooks('claim', 'button-1')).toEqual(['button-1'])
    expect(await hooks('claim', 'card-1')).toEqual(['button-1', 'card-1'])
    // Negative control: both owners resolve to the same dark theme, so the root is styled and nothing conflicts.
    const agreeing = await probe(preview)
    expect(await readRoot(preview.frame, dialog)).toMatchObject({ theme: 'dark', inline: 'color-scheme: dark;' })
    expect(byId(agreeing)['card-1']!.theme).toBe('applied')
    expect(byId(agreeing)['button-1']!.theme).toBeUndefined()

    await preview.send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: overrideLogin() })
    const conflicting = await probe(preview)
    expect(byId(conflicting)['card-1']!.theme).toBe('conflicting-portal')
    expect(byId(conflicting)['button-1']!.theme).toBe('conflicting-portal')
    expect(await readRoot(preview.frame, dialog)).toMatchObject({ theme: null, inline: '' })
    // The owners' own roots are unaffected by the portal conflict.
    expect((await readRoot(preview.frame, instance('card-1'))).theme).toBe('dark')

    // A conflict created by a claim alone (no DOM or document change) is still published to the editor.
    await hooks('release')
    expect(await hooks('claim', 'button-1')).toEqual(['button-1'])
    expect(await readRoot(preview.frame, dialog)).toMatchObject({ theme: null, inline: 'color-scheme: light;' })
    await probe(preview)
    await clearReceived(preview)
    await hooks('claim', 'card-1')
    await publishedGeometry(preview, geometry => byId(geometry)['card-1']?.theme === 'conflicting-portal' && byId(geometry)['button-1']?.theme === 'conflicting-portal')
    expect(await readRoot(preview.frame, dialog)).toMatchObject({ theme: null, inline: '' })

    // Closing the dialog removes the root; its claims go with it and both owners are applied again.
    await preview.frame.click('button:has-text("Close preview")')
    await waitFor(() => preview.frame.locator(dialog).count(), count => count === 0)
    const closed = await probe(preview)
    expect(await preview.frame.evaluate(() => (window as unknown as FrameHooks).__themeAdapter.owners())).toEqual([])
    expect(byId(closed)['card-1']!.theme).toBe('applied')
    expect(byId(closed)['button-1']!.theme).toBe('applied')
    expect(closed.theme).toBeUndefined()
  })
})
