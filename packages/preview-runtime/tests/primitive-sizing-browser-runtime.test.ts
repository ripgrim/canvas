import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPreviewRuntime } from '../src/index.js'
import { fixtureRegistry } from './fixture-registry.js'

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const solid = (color: string) => ({ fills: [{ type: 'solid', color }] })
const semanticLayout = { mode: 'freeform', declarations: { width: '100%', height: '50%' } } as const
const leaf = (id: string, kind: 'frame' | 'rectangle' | 'shape' | 'shader', color: string, semantic: boolean) => ({
  id, kind, name: id, x: 10, y: 20, width: 77, height: 66, rotation: 0, parentId: 'parent', appearance: solid(color),
  ...(kind === 'frame' ? { clip: false } : {}),
  ...(semantic ? { layout: semanticLayout } : {}),
})
const intrinsicFrame = (id: string, x: number, size: 'fit-content' | 'auto') => ({
  id, kind: 'frame', name: id, x, y: 80, width: 310, height: 210, rotation: 0, parentId: null, clip: false, appearance: solid('#29292c'),
  layout: { mode: 'freeform', declarations: { display: 'flex', 'flex-direction': 'row', width: size, height: size, 'padding-top': '10px', 'padding-right': '10px', 'padding-bottom': '10px', 'padding-left': '10px' } },
})
const child = (id: string, parentId: string) => ({
  id, kind: 'rectangle', name: id, x: 999, y: 999, width: 80, height: 30, rotation: 0, parentId, appearance: solid('#60a5fa'),
  layout: { mode: 'flow', declarations: {} },
})
const previewDocument = (width: number, height: number, semantic = true, revision = 1) => ({
  version: 2,
  revision,
  rootIds: [],
  nodes: {},
  frame: { width: 800, height: 700, direction: 'column', gap: 0, padding: 0, clip: false },
  canvas: {
    elements: [
      { id: 'parent', kind: 'frame', name: 'Parent', x: -340, y: -260, width, height, rotation: 0, parentId: null, clip: false, appearance: solid('#111827') },
      leaf('free-frame', 'frame', '#f472b6', semantic),
      leaf('free-rectangle', 'rectangle', '#fb7185', semantic),
      leaf('free-shape', 'shape', '#4ade80', semantic),
      leaf('free-shader', 'shader', '#facc15', semantic),
      intrinsicFrame('fit-frame', 40, 'fit-content'),
      child('fit-child', 'fit-frame'),
      intrinsicFrame('auto-frame', 180, 'auto'),
      child('auto-child', 'auto-frame'),
    ],
  },
})

type Observation = { width: string; height: string; rect: { width: number; height: number } }
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
  throw new Error('Primitive sizing preview observation timed out')
}

const observe = (id: string): Promise<Observation> => frame.evaluate(nodeId => {
  const element = document.querySelector<HTMLElement>(`[data-preview-canvas="${nodeId}"]`)!
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return { width: style.width, height: style.height, rect: { width: rect.width, height: rect.height } }
}, id)

const postDocument = async (preview: ReturnType<typeof previewDocument>) => {
  const command = { channel: 'design-editor-preview', version: 8, generation, type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: preview, theme: { attribute: null, colorScheme: 'light' } }
  await page.evaluate(([data, origin]) => { document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string) }, [command, previewOrigin] as const)
}

beforeAll(async () => {
  let previewUrl = ''
  const parent = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><style>html,body{margin:0}</style><iframe title="Primitive sizing preview" sandbox="allow-scripts allow-same-origin" src="${previewUrl}" style="width:800px;height:700px;border:0;display:block"></iframe>`)
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
}, 90_000)

afterAll(async () => { await dispose?.() }, 30_000)

describe('PAPER-FLEX-003 freeform primitive sizing in a real preview iframe', () => {
  it('resolves every canvas primitive percentage against its fixed Frame parent and follows parent changes', async () => {
    await postDocument(previewDocument(300, 200, true, 1))
    await frame.waitForSelector('[data-preview-canvas="free-shader"]')
    for (const id of ['free-frame', 'free-rectangle', 'free-shape', 'free-shader']) {
      const initial = await waitFor(() => observe(id), value => value.rect.width === 300 && value.rect.height === 100)
      expect(initial).toEqual({ width: '300px', height: '100px', rect: { width: 300, height: 100 } })
    }

    await postDocument(previewDocument(500, 240, true, 2))
    for (const id of ['free-frame', 'free-rectangle', 'free-shape', 'free-shader']) {
      const resized = await waitFor(() => observe(id), value => value.rect.width === 500 && value.rect.height === 120)
      expect(resized).toEqual({ width: '500px', height: '120px', rect: { width: 500, height: 120 } })
    }
  })

  it('uses in-flow child and padding math for intrinsic Frame Fit and Auto', async () => {
    await postDocument(previewDocument(300, 200, true, 3))
    const fit = await waitFor(() => observe('fit-frame'), value => value.rect.width === 100 && value.rect.height === 50)
    const auto = await waitFor(() => observe('auto-frame'), value => value.rect.width === 100 && value.rect.height === 50)
    expect(fit).toEqual({ width: '100px', height: '50px', rect: { width: 100, height: 50 } })
    expect(auto).toEqual({ width: '100px', height: '50px', rect: { width: 100, height: 50 } })
  })

  it('restores the exact numeric fallback after semantic declarations are removed', async () => {
    await postDocument(previewDocument(500, 240, false, 4))
    for (const id of ['free-frame', 'free-rectangle', 'free-shape', 'free-shader']) {
      const fallback = await waitFor(() => observe(id), value => value.rect.width === 77 && value.rect.height === 66)
      expect(fallback).toEqual({ width: '77px', height: '66px', rect: { width: 77, height: 66 } })
    }
  })
})
