import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPreviewRuntime } from '../src/index.js'
import { apply } from '../../repo-engine/src/layout-matrix.js'
import { worldMatrixOf } from '../../editor/src/features/editor/layout-pose'
import type { MeasuredNode } from '../../editor/src/features/editor/scene-geometry'
// Protocol v3: every document node carries its effective theme; the plain light fallback is not explicit.
const lightTheme = { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false } as const

// LAY-GEST-003 measurement half: the runtime's offset, origin and transform measurements, chained by the editor's
// pose module, reproduce the real transformed boxes of a child under a rotated and scaled parent within 0.5 px.
// The camera is identity (zoom 1, no pan), so screen = viewport center + world and the host origin is
// (-480/2 + 24, -640/2 + 24) = (-216, -296).

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const registry = ['Card', 'Label', 'Input', 'Button'].map(exportName => ({ componentId: `atom-${exportName.toLowerCase()}`, exportName, entryPath: `src/atoms/${exportName}.tsx` }))
const frameSize = { width: 480, height: 640, direction: 'column', gap: 16, padding: 24, clip: false }
const previewDocument = {
  version: 1, revision: 1, rootIds: ['card-1'], frame: frameSize,
  nodes: {
    'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', theme: lightTheme, props: {}, children: { children: ['input-1'] } },
    'input-1': { id: 'input-1', componentId: 'atom-input', exportName: 'Input', theme: lightTheme, props: { id: 'pose-email', type: 'email' }, children: {} },
  },
}
type Item = { instanceId: string; bounds: { x: number; y: number; width: number; height: number }; box?: MeasuredNode['box']; offset?: MeasuredNode['offset']; offsetParentInstanceId?: string | null; transform?: MeasuredNode['transform'] }
type Geometry = { layoutGeneration?: number; camera?: { width: number; height: number }; items: Item[] }

let browser: Browser | undefined
let page: Page
let frame: Frame
let dispose: (() => Promise<void>) | undefined
let send: (payload: Record<string, unknown>) => Promise<void>

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Preview observation timed out')
}
const geometryFor = (layoutGeneration: number): Promise<Geometry> => waitFor(() => page.evaluate(generation => {
  const all = (window as unknown as { received: Geometry[] }).received
  return all.filter(message => (message as unknown as { type: string }).type === 'geometry' && message.layoutGeneration === generation).at(-1) ?? null
}, layoutGeneration), value => value !== null) as Promise<Geometry>

beforeAll(async () => {
  let previewUrl = ''
  const parent = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><script>window.received = []; addEventListener('message', event => { if (event.data && event.data.channel === 'design-editor-preview') { window.received.push(event.data); if (window.received.length > 400) window.received.splice(0, 100) } })</script><iframe sandbox="allow-scripts allow-same-origin" src="${previewUrl}" style="width:800px;height:700px;border:0"></iframe>`)
  })
  await new Promise<void>(resolveListen => parent.listen(0, '127.0.0.1', resolveListen))
  const editorOrigin = `http://127.0.0.1:${(parent.address() as AddressInfo).port}`
  const service = createPreviewRuntime({ repositoryRoot, editorOrigin, executionTrust: 'fixture-only' })
  dispose = async () => { await browser?.close(); await service.dispose(); parent.closeAllConnections(); await new Promise<void>(resolveClose => parent.close(() => resolveClose())) }
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
  await send({ type: 'set-document', document: previewDocument })
  await waitFor(() => frame.evaluate(() => document.querySelectorAll('[data-preview-instance]').length), value => value === 2)
}, 90_000)

afterAll(async () => { await dispose?.() }, 30_000)

describe('pose measurement', () => {
  it('LAY-GEST-003: chained offsets, origins and transforms reproduce the rotated child box within 0.5 px', async () => {
    await send({ type: 'set-layout', layoutGeneration: 5, items: [
      { nodeId: 'card-1', mode: 'absolute', x: 60, y: 80, order: 0, width: 300, height: 200, declarations: { transform: 'rotate(30deg) scale(1.5)' } },
      { nodeId: 'input-1', mode: 'absolute', x: 5, y: 6, order: 0, width: 120 },
    ] })
    const geometry = await geometryFor(5)
    const camera = geometry.camera!
    const nodes: Record<string, MeasuredNode> = Object.fromEntries(geometry.items.map(item => [item.instanceId, { componentId: 'c', rect: item.bounds, ...(item.box ? { box: item.box } : {}), ...(item.offset ? { offset: item.offset } : {}), ...(item.offsetParentInstanceId !== undefined ? { offsetParentInstanceId: item.offsetParentInstanceId } : {}), ...(item.transform ? { transform: item.transform } : {}) }]))
    expect(nodes['card-1']!.offsetParentInstanceId).toBeNull()
    expect(nodes['input-1']!.offsetParentInstanceId).toBe('card-1')
    // The card's own untransformed box is its authored placement: 300 x 200 at host-relative (60 + 216, 80 + 296) = (276, 376).
    expect(nodes['card-1']!.offset).toMatchObject({ x: 276, y: 376, width: 300, height: 200 })
    // Origin defaults to the center of the untransformed border box.
    expect(nodes['card-1']!.offset!.origin).toEqual({ x: 150, y: 100 })
    expect(nodes['input-1']!.offset).toMatchObject({ x: 5, y: 6, width: 120 })
    const host = { x: -216, y: -296 }
    for (const id of ['card-1', 'input-1']) {
      const matrix = worldMatrixOf(nodes, id, host)!
      const { width, height } = nodes[id]!.offset!
      const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: 0, y: height }, { x: width, y: height }].map(corner => apply(matrix, corner))
      const predicted = { x: Math.min(...corners.map(corner => corner.x)) + camera.width / 2, y: Math.min(...corners.map(corner => corner.y)) + camera.height / 2, right: Math.max(...corners.map(corner => corner.x)) + camera.width / 2, bottom: Math.max(...corners.map(corner => corner.y)) + camera.height / 2 }
      const real = nodes[id]!.rect
      expect(Math.abs(predicted.x - real.x)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(predicted.y - real.y)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(predicted.right - (real.x + real.width))).toBeLessThanOrEqual(0.5)
      expect(Math.abs(predicted.bottom - (real.y + real.height))).toBeLessThanOrEqual(0.5)
    }
    // Negative control: ignoring the parent transform predicts a different box for the child.
    const flat: Record<string, MeasuredNode> = { ...nodes, 'card-1': { ...nodes['card-1']!, transform: undefined as never } }
    delete (flat['card-1'] as { transform?: unknown }).transform
    const naive = apply(worldMatrixOf(flat, 'input-1', host)!, { x: 0, y: 0 })
    expect(Math.abs(naive.x + camera.width / 2 - nodes['input-1']!.rect.x) > 0.5 || Math.abs(naive.y + camera.height / 2 - nodes['input-1']!.rect.y) > 0.5).toBe(true)
  })
})
