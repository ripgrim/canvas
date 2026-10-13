import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPreviewRuntime } from '../src/index.js'
import { fixtureRegistry } from './fixture-registry.js'

// PAPER-TEXT-002 and PAPER-TEXT-003 cross the real preview boundary. The assertions below read computed CSS and
// layout geometry from an actual Edge iframe. Expected values are literal browser outcomes, not values recomputed by
// the production style helpers. The one-pixel fixed nodes are negative controls for accidental fixed-size mapping.

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const evidencePath = resolve(import.meta.dirname, '../../../docs/research/evidence/paper-text/text-sizing-browser.png')
const textStyle = {
  fontFamily: '"Courier New", monospace',
  fontStyle: 'normal',
  fontWeight: 400,
  fontSize: 20,
  lineHeight: { kind: 'px', value: 24 },
  letterSpacing: 0,
  horizontalAlign: 'left',
  verticalAlign: 'top',
  case: 'none',
  wrap: 'normal',
  keepWords: false,
} as const

const textNode = (
  id: string,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  textSizing: Record<string, unknown>,
  style: Record<string, unknown> = textStyle,
  parentId: string | null = null,
) => ({ id, kind: 'text', name: id, x, y, width, height, rotation: 0, parentId, text, textStyle: style, textSizing })

const repeatedCopy = 'LINE 1\nLINE 2\nLINE 3\nLINE 4\nLINE 5\nLINE 6'
const previewDocument = {
  version: 2,
  revision: 1,
  rootIds: [],
  nodes: {},
  frame: { width: 760, height: 620, direction: 'column', gap: 0, padding: 0, clip: false },
  canvas: {
    elements: [
      textNode('fixed', 'FIXED BOX WRAPS', -360, -250, 132, 72, { width: { mode: 'fixed' }, height: { mode: 'fixed' } }),
      textNode('fit-width', 'FIT WIDTH SINGLE LINE', -180, -250, 1, 48, { width: { mode: 'fit' }, height: { mode: 'fixed' } }),
      textNode('fixed-width-negative', 'FIT WIDTH SINGLE LINE', -180, -170, 1, 48, { width: { mode: 'fixed' }, height: { mode: 'fixed' } }),
      textNode('fit-height', repeatedCopy, 95, -250, 132, 1, { width: { mode: 'fixed' }, height: { mode: 'fit' } }),
      textNode('fixed-height-negative', repeatedCopy, 260, -250, 132, 1, { width: { mode: 'fixed' }, height: { mode: 'fixed' } }),
      textNode('clamped', repeatedCopy, -360, 40, 132, 1, { width: { mode: 'fixed' }, height: { mode: 'fit' } }, { ...textStyle, maxLines: 2 }),
      textNode('unclamped', repeatedCopy, -180, 40, 132, 1, { width: { mode: 'fixed' }, height: { mode: 'fit' } }),
      textNode('formatted', 'Paper parity keeps words', 40, 40, 300, 112, { width: { mode: 'fixed' }, height: { mode: 'fixed' } }, {
        ...textStyle,
        horizontalAlign: 'right',
        verticalAlign: 'bottom',
        case: 'uppercase',
        wrap: 'balance',
        keepWords: true,
      }),
      textNode('tracked', 'TRACKED', 40, 170, 160, 40, { width: { mode: 'fixed' }, height: { mode: 'fixed' } }, { ...textStyle, letterSpacing: 12.5 }),
      textNode('metric-unitless', 'UNITLESS', 220, 170, 140, 40, { width: { mode: 'fixed' }, height: { mode: 'fixed' } }, { ...textStyle, lineHeight: { kind: 'unitless', value: 1.5 } }),
      textNode('metric-normal', 'NORMAL', 220, 215, 140, 40, { width: { mode: 'fixed' }, height: { mode: 'fixed' } }, { ...textStyle, lineHeight: { kind: 'normal' } }),
      textNode('fit-anchor-left', 'ANCHOR', 0, 210, 180, 30, { width: { mode: 'fit' }, height: { mode: 'fit' } }),
      textNode('fit-anchor-center', 'ANCHOR', 0, 245, 180, 30, { width: { mode: 'fit' }, height: { mode: 'fit' } }, { ...textStyle, horizontalAlign: 'center' }),
      textNode('fit-anchor-right', 'ANCHOR', 0, 280, 180, 30, { width: { mode: 'fit' }, height: { mode: 'fit' } }, { ...textStyle, horizontalAlign: 'right' }),
      textNode('empty-creation', '', 280, 280, 1, 1, { width: { mode: 'fit' }, height: { mode: 'fit' } }),
      { id: 'fill-parent', kind: 'frame', name: 'Fill parent', x: -360, y: 210, width: 240, height: 90, rotation: 0, parentId: null, clip: false },
      textNode('nested-fill', 'FILL / FILL', 0, 0, 1, 1, { width: { mode: 'fill' }, height: { mode: 'fill' } }, { ...textStyle, fontSize: 16, lineHeight: { kind: 'px', value: 20 } }, 'fill-parent'),
      textNode('nested-fixed-negative', 'X', 230, 80, 1, 1, { width: { mode: 'fixed' }, height: { mode: 'fixed' } }, { ...textStyle, fontSize: 16, lineHeight: { kind: 'px', value: 20 } }, 'fill-parent'),
      { id: 'relative-parent', kind: 'frame', name: 'Relative parent', x: -80, y: 210, width: 240, height: 120, rotation: 0, parentId: null, clip: false },
      textNode('nested-relative', 'RELATIVE 50% / 25%', 0, 0, 1, 1, { width: { mode: 'relative', value: 50 }, height: { mode: 'relative', value: 25 } }, { ...textStyle, fontSize: 16, lineHeight: { kind: 'px', value: 20 } }, 'relative-parent'),
    ],
  },
}

type TextObservation = {
  inline: {
    display: string
    lineClamp: string
    boxOrient: string
  }
  computed: {
    width: string
    height: string
    whiteSpace: string
    textWrap: string
    overflow: string
    overflowWrap: string
    wordBreak: string
    textAlign: string
    alignContent: string
    textTransform: string
    display: string
    lineClamp: string
    lineHeight: string
    letterSpacing: string
  }
  rect: { x: number; y: number; width: number; height: number }
  scroll: { width: number; height: number }
  inlineLeft: string
}

let browser: Browser | undefined
let page: Page
let frame: Frame
let dispose: (() => Promise<void>) | undefined

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Text preview observation timed out')
}

const observe = (id: string): Promise<TextObservation> => frame.evaluate(nodeId => {
  const element = document.querySelector<HTMLElement>(`[data-preview-canvas="${nodeId}"]`)!
  const computed = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return {
    inline: {
      display: element.style.display,
      lineClamp: element.style.webkitLineClamp,
      boxOrient: element.style.webkitBoxOrient,
    },
    computed: {
      width: computed.width,
      height: computed.height,
      whiteSpace: computed.whiteSpace,
      textWrap: computed.textWrap,
      overflow: computed.overflow,
      overflowWrap: computed.overflowWrap,
      wordBreak: computed.wordBreak,
      textAlign: computed.textAlign,
      alignContent: computed.alignContent,
      textTransform: computed.textTransform,
      display: computed.display,
      lineClamp: computed.webkitLineClamp,
      lineHeight: computed.lineHeight,
      letterSpacing: computed.letterSpacing,
    },
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    scroll: { width: element.scrollWidth, height: element.scrollHeight },
    inlineLeft: element.style.left,
  }
}, id)

beforeAll(async () => {
  let previewUrl = ''
  const parent = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><style>html,body{margin:0;background:#f6f6f7}</style><iframe title="Text preview" sandbox="allow-scripts allow-same-origin" src="${previewUrl}" style="width:800px;height:700px;border:0;display:block"></iframe><script>window.__geometry=[];addEventListener('message',event=>{if(event.data?.type==='geometry')window.__geometry.push(event.data)})</script>`)
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
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 700 }, deviceScaleFactor: 1 })
  await page.goto(editorOrigin)
  frame = await waitFor(async () => page.frames().find(candidate => candidate.url() === previewUrl), value => Boolean(value)) as Frame
  await frame.waitForSelector('.fixture-input')
  const command = { channel: 'design-editor-preview', version: 8, generation: result.activeGeneration, type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: previewDocument, theme: { attribute: null, colorScheme: 'light' } }
  await page.evaluate(([data, origin]) => { document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string) }, [command, result.origin] as const)
  await frame.waitForSelector('[data-preview-canvas="formatted"]')
  await waitFor(() => observe('fit-height'), value => value.rect.height > 24)
}, 90_000)

afterAll(async () => { await dispose?.() }, 30_000)

describe('PAPER-TEXT-002 and PAPER-TEXT-003 text sizing in a real preview iframe', () => {
  it('keeps a new empty Fit/Fit text node measurable for the editor overlay without drawing visible copy', async () => {
    const empty = await observe('empty-creation')
    const content = await frame.evaluate(() => document.querySelector('[data-preview-canvas="empty-creation"]')?.textContent)
    expect(content).toBe('\u00a0')
    expect(empty.rect.width).toBeGreaterThan(0)
    expect(empty.rect.height).toBe(24)
    const item = await waitFor(
      () => page.evaluate(() => {
        const messages = (window as unknown as { __geometry: { items: Record<string, unknown>[] }[] }).__geometry
        return messages.flatMap(message => message.items).find(candidate => candidate.instanceId === 'empty-creation') ?? null
      }),
      value => value,
    )
    expect(item).toMatchObject({ source: 'canvas', canvasKind: 'text', offset: { width: expect.any(Number), height: 24 } })
  })

  it('publishes native text geometry with the DOM used size for editor HUD reconciliation', async () => {
    const item = await waitFor(
      () => page.evaluate(() => {
        const messages = (window as unknown as { __geometry: { items: Record<string, unknown>[] }[] }).__geometry
        return messages.flatMap(message => message.items).find(candidate => candidate.instanceId === 'fit-width') ?? null
      }),
      value => value,
    )
    expect(item).toMatchObject({ source: 'canvas', canvasKind: 'text', offset: { width: expect.any(Number), height: expect.any(Number) }, text: { resolvedLineHeight: 24 } })
    expect((item.offset as { width: number }).width).toBeGreaterThan(200)
    expect((item.offset as { height: number }).height).toBeGreaterThan(0)
  })

  it('publishes browser-resolved unitless line height and the exact normal fallback', async () => {
    const metrics = await waitFor(
      () => page.evaluate(() => {
        const messages = (window as unknown as { __geometry: { items: { instanceId?: string; text?: { resolvedLineHeight: number } }[] }[] }).__geometry
        const items = messages.flatMap(message => message.items)
        return Object.fromEntries(['metric-unitless', 'metric-normal'].map(id => [id, [...items].reverse().find(candidate => candidate.instanceId === id)?.text?.resolvedLineHeight]))
      }),
      value => value['metric-unitless'] !== undefined && value['metric-normal'] !== undefined,
    )
    expect(metrics).toEqual({ 'metric-unitless': 30, 'metric-normal': 24 })
  })

  it('keeps Fixed/Fixed authored bounds while text wraps inside them', async () => {
    const fixed = await observe('fixed')
    expect(fixed.computed).toMatchObject({ width: '132px', height: '72px', whiteSpace: 'pre-wrap', textWrap: 'wrap', overflow: 'hidden', lineHeight: '24px' })
    expect(fixed.rect).toMatchObject({ width: 132, height: 72 })
    expect(fixed.scroll.height).toBeGreaterThan(24)
  })

  it('makes Fit width intrinsic and no-wrap instead of retaining the authored fallback width', async () => {
    const fit = await observe('fit-width')
    const fixedNegative = await observe('fixed-width-negative')
    expect(fit.computed).toMatchObject({ whiteSpace: 'pre', textWrap: 'nowrap', overflow: 'hidden' })
    // scrollWidth is integer CSS pixels while getBoundingClientRect preserves subpixels.
    expect(Math.abs(fit.rect.width - fit.scroll.width)).toBeLessThan(1)
    expect(fit.scroll.width).toBeGreaterThan(200)
    expect(fixedNegative.rect.width).toBe(1)
    expect(fit.rect.width).toBeGreaterThan(fixedNegative.rect.width * 200)
  })

  it('lets Fit height grow to wrapped content instead of retaining the authored fallback height', async () => {
    const fit = await observe('fit-height')
    const fixedNegative = await observe('fixed-height-negative')
    expect(fit.computed).toMatchObject({ width: '132px', whiteSpace: 'pre-wrap', textWrap: 'wrap', overflow: 'visible' })
    // Six explicit lines at the literal 24px line-height occupy 144px.
    expect(fit.rect.height).toBe(6 * 24)
    expect(fit.scroll.height).toBe(6 * 24)
    expect(fixedNegative.rect.height).toBe(1)
    expect(fit.rect.height).toBeGreaterThan(fixedNegative.rect.height * 100)
  })

  it('clamps only a Fit-height node to two lines without changing width', async () => {
    const clamped = await observe('clamped')
    const unclamped = await observe('unclamped')
    expect(clamped.inline).toEqual({ display: '-webkit-box', lineClamp: '2', boxOrient: 'vertical' })
    expect(clamped.computed).toMatchObject({ width: '132px', overflow: 'hidden', lineClamp: '2', lineHeight: '24px' })
    expect(clamped.rect.height).toBe(48)
    expect(clamped.rect.width).toBe(unclamped.rect.width)
    expect(clamped.rect.height).toBeLessThan(unclamped.rect.height)
    expect(unclamped.rect.height).toBe(unclamped.scroll.height)
  })

  it('applies alignment, case, wrap and keep-words as browser-observable CSS', async () => {
    const formatted = await observe('formatted')
    expect(formatted.computed).toMatchObject({
      width: '300px',
      height: '112px',
      textAlign: 'right',
      alignContent: 'end',
      textTransform: 'uppercase',
      textWrap: 'balance',
      overflowWrap: 'normal',
      wordBreak: 'normal',
    })
  })

  it('resolves nested Fill and Relative axes from their real frame parent content boxes', async () => {
    const fillParent = await observe('fill-parent')
    const fill = await observe('nested-fill')
    const fixedNegative = await observe('nested-fixed-negative')
    const relativeParent = await observe('relative-parent')
    const relative = await observe('nested-relative')

    expect(fillParent.rect).toMatchObject({ width: 240, height: 90 })
    expect(fill.computed).toMatchObject({ width: '240px', height: '90px', whiteSpace: 'pre-wrap', overflow: 'hidden' })
    expect(fill.rect).toMatchObject({ width: fillParent.rect.width, height: fillParent.rect.height })
    expect(fixedNegative.rect).toMatchObject({ width: 1, height: 1 })
    expect(fill.rect.width).toBeGreaterThan(fixedNegative.rect.width * 200)
    expect(fill.rect.height).toBeGreaterThan(fixedNegative.rect.height * 80)

    expect(relativeParent.rect).toMatchObject({ width: 240, height: 120 })
    expect(relative.computed).toMatchObject({ width: '120px', height: '30px', whiteSpace: 'pre-wrap', overflow: 'hidden' })
    expect(relative.rect).toMatchObject({ width: relativeParent.rect.width / 2, height: relativeParent.rect.height / 4 })
  })

  it('treats Paper tracking as a percentage of font size in the real browser', async () => {
    const tracked = await observe('tracked')
    expect(tracked.computed.letterSpacing).toBe('2.5px')
  })

  it('keeps intrinsic text attached to its authored left, center, or right alignment anchor', async () => {
    const left = await observe('fit-anchor-left')
    const center = await observe('fit-anchor-center')
    const right = await observe('fit-anchor-right')

    expect(left.inlineLeft).toBe('0px')
    expect(center.inlineLeft).toBe('90px')
    expect(right.inlineLeft).toBe('180px')
    expect(center.rect.x + center.rect.width / 2 - left.rect.x).toBeCloseTo(90, 5)
    expect(right.rect.x + right.rect.width - left.rect.x).toBeCloseTo(180, 5)
  })

  it('captures deterministic browser evidence when explicitly requested', async () => {
    if (process.env.CAPTURE_PAPER_TEXT_EVIDENCE !== '1') return
    await frame.evaluate(() => {
      const style = document.createElement('style')
      style.setAttribute('data-paper-text-evidence', '')
      style.textContent = `
        html, body { background: #1f1f1f !important; color: #f4f4f5; }
        [data-preview-canvas] { outline: 1px solid #e864ff; outline-offset: 2px; background: rgb(232 100 255 / 8%); }
        [data-preview-kind="text"] { color: #f4f4f5 !important; }
        [data-preview-canvas="fixed-width-negative"], [data-preview-canvas="fixed-height-negative"], [data-preview-canvas="nested-fixed-negative"] { outline-color: #fb7185; }
      `
      document.head.append(style)
    })
    await mkdir(resolve(evidencePath, '..'), { recursive: true })
    await page.locator('iframe').screenshot({ path: evidencePath })
  })
})
