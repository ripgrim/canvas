import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPreviewRuntime } from '../src/index.js'
import { fixtureRegistry } from './fixture-registry.js'

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const previewDocument = {
  version: 3,
  revision: 1,
  rootIds: [],
  nodes: {},
  frame: { width: 400, height: 300, direction: 'column', gap: 0, padding: 0, clip: false },
  canvas: {
    elements: [{
      id: 'interactive-card', kind: 'frame', name: 'Interactive card', relativeTransform: [1, 0, 0, 1, -80, -50], width: 160, height: 100, parentId: null,
      interactions: [
        { trigger: 'pointer-hover', targetId: 'card-face', appearance: { fills: [{ type: 'solid', color: '#ff0000' }] }, transition: { type: 'smart-animate', durationMs: 180, easing: 'ease-out' } },
        { trigger: 'pointer-press', targetId: 'card-face', appearance: { fills: [{ type: 'solid', color: '#0000ff' }] } },
      ],
    }, {
      id: 'card-face', kind: 'rectangle', name: 'Card face', relativeTransform: [1, 0, 0, 1, 40, 30], width: 80, height: 40, parentId: 'interactive-card',
      appearance: { fills: [{ type: 'solid', color: '#8844aa' }] },
    }, {
      id: 'nested-component', kind: 'frame', name: 'Nested component', relativeTransform: [1, 0, 0, 1, 110, 8], width: 40, height: 24, parentId: 'interactive-card',
      interactions: [{ trigger: 'pointer-hover', targetId: 'nested-face', appearance: { fills: [{ type: 'solid', color: '#00ff00' }] } }],
    }, {
      id: 'nested-face', kind: 'rectangle', name: 'Nested face', relativeTransform: [1, 0, 0, 1, 4, 4], width: 32, height: 16, parentId: 'nested-component',
      appearance: { fills: [{ type: 'solid', color: '#404348' }] },
    }],
  },
}

let browser: Browser | undefined
let page: Page
let frame: Frame
let previewOrigin = ''
let generation = 0
let dispose: (() => Promise<void>) | undefined

const post = async (payload: Record<string, unknown>) => page.evaluate(([data, origin]) => {
  document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string)
}, [{ channel: 'design-editor-preview', version: 10, generation, ...payload }, previewOrigin] as const)

const background = (id = 'card-face') => frame.locator(`[data-preview-canvas="${id}"]`).evaluate(element => getComputedStyle(element).backgroundColor)
const expectBackground = async (color: string, id = 'card-face') => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await background(id) === color) return
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
  expect(await background(id)).toBe(color)
}

beforeAll(async () => {
  let previewUrl = ''
  const parent = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><script>window.previewMessages=[];addEventListener('message',event=>window.previewMessages.push(event.data))</script><iframe title="Component interaction preview" sandbox="allow-scripts allow-same-origin" src="${previewUrl}" style="width:400px;height:300px;border:0"></iframe>`)
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
  if (result.status !== 'ready' || !result.url || !result.origin || !result.activeGeneration) throw new Error(`Preview did not build: ${JSON.stringify(result.diagnostics)}`)
  previewUrl = result.url
  previewOrigin = result.origin
  generation = result.activeGeneration
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 420, height: 320 }, deviceScaleFactor: 1 })
  await page.goto(editorOrigin)
  frame = page.frames().find(candidate => candidate.url() === previewUrl)!
  await frame.waitForSelector('.fixture-input')
  await post({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: previewDocument, theme: { attribute: null, colorScheme: 'light' }, renderSequence: 12 })
  await frame.waitForSelector('[data-preview-canvas="interactive-card"]')
  await page.waitForFunction(() => (window as unknown as { previewMessages: { type?: string; renderSequence?: number }[] }).previewMessages.some(message => message.type === 'document-applied' && message.renderSequence === 12))
}, 90_000)

afterAll(async () => { await dispose?.() }, 30_000)

describe('COMP-V2-UI-073/074 component-root interactions in the real preview runtime', () => {
  it('acknowledges the exact document only after its DOM render completes', async () => {
    const messages = await page.evaluate(() => (window as unknown as { previewMessages: unknown[] }).previewMessages)
    expect(messages).toContainEqual(expect.objectContaining({ type: 'document-applied', renderSequence: 12, documentRevision: 1 }))
  })

  it('owns hover and press at the component root, isolates a nested owner, and restores configured appearance', async () => {
    const card = frame.locator('[data-preview-canvas="interactive-card"]')
    const face = frame.locator('[data-preview-canvas="card-face"]')
    const nested = frame.locator('[data-preview-canvas="nested-component"]')
    await expectBackground('rgb(136, 68, 170)')

    await card.hover({ position: { x: 10, y: 50 } })
    await expectBackground('rgb(255, 0, 0)')
    expect(await face.evaluate(element => (element as HTMLElement).style.transition)).toBe('180ms ease-out')

    await card.dispatchEvent('pointerdown', { pointerId: 1 })
    await expectBackground('rgb(0, 0, 255)')
    await card.dispatchEvent('pointerup', { pointerId: 1 })
    await expectBackground('rgb(255, 0, 0)')

    await page.mouse.move(5, 5)
    await expectBackground('rgb(136, 68, 170)')
    await card.hover({ position: { x: 10, y: 50 } })
    await expectBackground('rgb(255, 0, 0)')

    await nested.hover()
    await expectBackground('rgb(136, 68, 170)')
    await expectBackground('rgb(0, 255, 0)', 'nested-face')
    await card.hover({ position: { x: 10, y: 50 } })
    await expectBackground('rgb(255, 0, 0)')
    await expectBackground('rgb(64, 67, 72)', 'nested-face')

    await card.dispatchEvent('pointerdown', { pointerId: 2 })
    await expectBackground('rgb(0, 0, 255)')
    await card.dispatchEvent('pointercancel', { pointerId: 2 })
    await expectBackground('rgb(136, 68, 170)')

    await page.mouse.move(5, 5)
    await card.hover({ position: { x: 10, y: 50 } })
    await expectBackground('rgb(255, 0, 0)')
    await frame.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expectBackground('rgb(136, 68, 170)')

    await page.mouse.move(5, 5)
    await card.hover({ position: { x: 10, y: 50 } })
    await expectBackground('rgb(255, 0, 0)')
    await post({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: { ...previewDocument, revision: 2 }, theme: { attribute: null, colorScheme: 'light' }, renderSequence: 13 })
    await page.waitForFunction(() => (window as unknown as { previewMessages: { type?: string; renderSequence?: number }[] }).previewMessages.some(message => message.type === 'document-applied' && message.renderSequence === 13))
    await expectBackground('rgb(136, 68, 170)')

    await page.mouse.move(5, 5)
    await expectBackground('rgb(136, 68, 170)')
    await post({ type: 'set-interaction-mode', mode: 'select' })
    await card.hover()
    await expectBackground('rgb(136, 68, 170)')

    await page.mouse.move(5, 5)
    await post({ type: 'set-interaction-mode', mode: 'pan' })
    await card.hover()
    await expectBackground('rgb(136, 68, 170)')
  })
})
