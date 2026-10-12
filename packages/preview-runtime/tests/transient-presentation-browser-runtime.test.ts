import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPreviewRuntime } from '../src/index.js'
import { fixtureRegistry } from './fixture-registry.js'

const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
const image = { fills: [{ type: 'image' as const, assetId: 'photo', fit: 'cover' as const }] }
const previewDocument = (revision = 12, includePrimitive = true) => ({
  version: 2 as const,
  revision,
  rootIds: ['button-1'],
  nodes: {
    'button-1': { id: 'button-1', componentId: 'atom-button', exportName: 'Button', props: { type: 'button', variant: 'quiet', children: 'Go' }, children: {}, appearance: image },
  },
  frame: { width: 800, height: 600, direction: 'column' as const, gap: 0, padding: 0, clip: false },
  canvas: { elements: includePrimitive ? [{ id: 'selected', kind: 'rectangle' as const, name: 'Selected', x: 0, y: 0, width: 20, height: 20, rotation: 0, parentId: null, appearance: image }] : [] },
  assets: { photo: { mime: 'image/png' as const, data: 'AAAA' } },
})

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
  throw new Error('Transient presentation browser observation timed out')
}

const send = async (payload: Record<string, unknown>) => {
  const command = { channel: 'design-editor-preview', version: 8, generation, ...payload }
  await page.evaluate(([data, origin]) => { document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string) }, [command, previewOrigin] as const)
}

const sendForGeneration = async (commandGeneration: number, payload: Record<string, unknown>) => {
  const command = { channel: 'design-editor-preview', version: 8, generation: commandGeneration, ...payload }
  await page.evaluate(([data, origin]) => { document.querySelector('iframe')!.contentWindow!.postMessage(data, origin as string) }, [command, previewOrigin] as const)
}

const currentMeasurementRevision = async () => {
  await new Promise(resolveWait => setTimeout(resolveWait, 75))
  return waitFor(() => page.evaluate(() => {
    const messages = ((window as unknown as { previewMessages?: { type?: string; measurementRevision?: number }[] }).previewMessages ?? []).filter(message => message.type === 'geometry')
    return messages.at(-1)?.measurementRevision ?? -1
  }), value => Number.isSafeInteger(value) && value >= 0)
}

const firstMeasurementRevision = async () => waitFor(() => page.evaluate(() => {
  const messages = ((window as unknown as { previewMessages?: { type?: string; measurementRevision?: number }[] }).previewMessages ?? []).filter(message => message.type === 'geometry')
  return messages[0]?.measurementRevision ?? -1
}), value => Number.isSafeInteger(value) && value >= 0)

beforeAll(async () => {
  let previewUrl = ''
  const parent = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><style>html,body{margin:0}</style><script>window.previewMessages=[];addEventListener('message',event=>window.previewMessages.push(event.data))</script><iframe title="Transient presentation preview" sandbox="allow-scripts allow-same-origin" src="${previewUrl}" style="width:800px;height:600px;border:0;display:block"></iframe>`)
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
  page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 })
  await page.goto(editorOrigin)
  frame = await waitFor(async () => page.frames().find(candidate => candidate.url() === previewUrl), value => Boolean(value)) as Frame
  await frame.waitForSelector('.fixture-input')
}, 90_000)

afterAll(async () => { await dispose?.() }, 30_000)

describe('PAPER-FLEX-007, AT-CAN-006, and CLOUD-SYNC-GESTURE-001 v8 browser presentation runtime', () => {
  it('applies one parent-padding projection, preserves transforms and assets, rejects stale samples, and restores every lifecycle edge', async () => {
    await send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: previewDocument(), theme: { attribute: null, colorScheme: 'light' } })
    await send({ type: 'set-camera', camera: { x: -400, y: -300, zoom: 1, width: 800, height: 600 } })
    await frame.waitForSelector('[data-preview-canvas="selected"]')
    await frame.evaluate(() => {
      const primitive = document.querySelector<HTMLElement>('[data-preview-canvas="selected"]')!
      primitive.style.setProperty('transform', 'matrix(0, 2, -2, 0, 0, 0)', 'important')
      primitive.style.setProperty('transform-origin', '0px 0px', 'important')
      primitive.style.setProperty('left', '11px', 'important')
      primitive.style.setProperty('top', '12px')
      const component = document.querySelector<HTMLElement>('[data-preview-instance="button-1"]')!
      component.style.setProperty('left', '13px', 'important')
      ;(window as unknown as { presentationMutations: number; presentationObserver: MutationObserver }).presentationMutations = 0
      const observer = new MutationObserver(records => { (window as unknown as { presentationMutations: number }).presentationMutations += records.filter(record => record.attributeName === 'style').length })
      observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] })
      ;(window as unknown as { presentationObserver: MutationObserver }).presentationObserver = observer
    })

    expect(await firstMeasurementRevision()).toBe(1)
    const initialMeasurementRevision = await currentMeasurementRevision()
    let fence = { documentRevision: 12, layoutGeneration: 0, measurementRevision: initialMeasurementRevision }
    const presentation = (sampleSequence: number) => ({
      kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'resize-1', sampleSequence, fence,
      items: [
        { nodeId: 'selected', parentNodeId: null, startRect: { x: 0, y: 0, width: 20, height: 20 }, rect: { x: 30, y: 10, width: 35, height: 50 }, appearance: { fills: [{ type: 'image', assetId: 'photo', fit: 'cover', geometry: { x: 4, y: 5, width: 60, height: 70 } }] } },
        { nodeId: 'button-1', parentNodeId: null, startRect: { x: 0, y: 0, width: 40, height: 20 }, rect: { x: -8, y: 14, width: 80, height: 30 }, appearance: { fills: [{ type: 'image', assetId: 'photo', fit: 'cover', geometry: { x: 6, y: 7, width: 90, height: 45 } }] } },
      ],
    })
    await send({ type: 'set-transient-presentations', presentations: [presentation(1)] })
    const applied = await waitFor(() => frame.evaluate(() => {
      const primitive = document.querySelector<HTMLElement>('[data-preview-canvas="selected"]')!
      const component = document.querySelector<HTMLElement>('[data-preview-instance="button-1"]')!
      const matrix = new DOMMatrix(getComputedStyle(primitive).transform)
      const left = Number.parseFloat(primitive.style.left), top = Number.parseFloat(primitive.style.top)
      const point = (x: number, y: number) => { const transformed = new DOMPoint(x, y).matrixTransform(matrix); return { x: transformed.x + left, y: transformed.y + top } }
      return {
        primitive: {
          left: primitive.style.left, top: primitive.style.top, width: primitive.style.width, height: primitive.style.height,
          transform: primitive.style.getPropertyValue('transform'), transformPriority: primitive.style.getPropertyPriority('transform'),
          backgroundImage: primitive.style.backgroundImage, backgroundPosition: primitive.style.backgroundPosition,
          quad: [point(0, 0), point(35, 0), point(35, 50), point(0, 50)],
          aabb: (() => { const rect = primitive.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })(),
        },
        component: { left: component.style.left, top: component.style.top, width: component.style.width, height: component.style.height, backgroundImage: component.style.backgroundImage, backgroundPosition: component.style.backgroundPosition },
      }
    }), value => value.primitive.width === '35px' && value.component.width === '80px')
    expect(applied.primitive).toMatchObject({
      left: '30px', top: '10px', width: '35px', height: '50px', transform: 'matrix(0, 2, -2, 0, 0, 0)', transformPriority: 'important', backgroundPosition: '4px 5px',
      quad: [{ x: 30, y: 10 }, { x: 30, y: 80 }, { x: -70, y: 80 }, { x: -70, y: 10 }],
      aabb: { x: -70, y: 10, width: 100, height: 70 },
    })
    expect(applied.component).toMatchObject({ left: '-8px', top: '14px', width: '80px', height: '30px', backgroundPosition: '6px 7px' })
    expect(applied.primitive.backgroundImage).toContain('data:image/png;base64,AAAA')
    expect(applied.component.backgroundImage).toContain('data:image/png;base64,AAAA')

    await frame.evaluate(() => { (window as unknown as { presentationMutations: number }).presentationMutations = 0 })
    await frame.evaluate(() => {
      const component = document.querySelector<HTMLElement>('[data-preview-instance="button-1"]')!
      component.style.setProperty('width', '44px', 'important')
      component.style.setProperty('background-position', '21px 22px', 'important')
    })
    expect(await waitFor(() => frame.$eval('[data-preview-instance="button-1"]', element => ({ width: (element as HTMLElement).style.width, position: (element as HTMLElement).style.backgroundPosition })), value => value.width === '80px' && value.position === '6px 7px')).toStrictEqual({ width: '80px', position: '6px 7px' })
    await send({ type: 'set-transient-presentations', presentations: [{ ...presentation(0), sampleSequence: 0 }] })
    const restored = await waitFor(() => frame.evaluate(() => {
      const primitive = document.querySelector<HTMLElement>('[data-preview-canvas="selected"]')!
      const component = document.querySelector<HTMLElement>('[data-preview-instance="button-1"]')!
      return {
        primitive: { left: primitive.style.getPropertyValue('left'), leftPriority: primitive.style.getPropertyPriority('left'), top: primitive.style.getPropertyValue('top'), topPriority: primitive.style.getPropertyPriority('top'), width: primitive.style.getPropertyValue('width'), backgroundPosition: primitive.style.getPropertyValue('background-position') },
        component: { left: component.style.getPropertyValue('left'), leftPriority: component.style.getPropertyPriority('left'), width: component.style.getPropertyValue('width'), backgroundPosition: component.style.getPropertyValue('background-position') },
      }
    }), value => value.primitive.left === '11px' && value.component.left === '13px' && value.component.width === '44px')
    expect(restored).toStrictEqual({
      primitive: { left: '11px', leftPriority: 'important', top: '12px', topPriority: '', width: '20px', backgroundPosition: 'center center' },
      component: { left: '13px', leftPriority: 'important', width: '44px', backgroundPosition: 'center center' },
    })

    fence = { ...fence, measurementRevision: await currentMeasurementRevision() }
    await frame.evaluate(() => { (window as unknown as { presentationMutations: number }).presentationMutations = 0 })
    await send({ type: 'set-transient-presentations', presentations: [presentation(1)] })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width), value => value === '35px')).toBe('35px')
    await send({ type: 'set-transient-presentations', presentations: [] })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width), value => value === '20px')).toBe('20px')
    await send({ type: 'set-transient-presentations', presentations: [presentation(1)] })
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    expect((await frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width))).toBe('20px')

    fence = { ...fence, measurementRevision: await currentMeasurementRevision() }
    await send({ type: 'set-transient-presentations', presentations: [presentation(2)] })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width), value => value === '35px')).toBe('35px')
    await send({ type: 'set-layout', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', items: [], layoutGeneration: 1 })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.left), value => value === '11px')).toBe('11px')

    await frame.evaluate(() => { (window as unknown as { presentationMutations: number }).presentationMutations = 0 })
    await send({ type: 'set-transient-presentations', presentations: [{ ...presentation(3), fence: { ...fence, documentRevision: 11, layoutGeneration: 1 } }] })
    await send({ type: 'set-transient-presentations', presentations: [{ ...presentation(3), fence: { ...fence, layoutGeneration: 0 } }] })
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    expect(await frame.evaluate(() => (window as unknown as { presentationMutations: number }).presentationMutations)).toBe(0)

    fence = { documentRevision: 12, layoutGeneration: 1, measurementRevision: await currentMeasurementRevision() }
    await send({ type: 'set-transient-presentations', presentations: [presentation(4)] })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width), value => value === '35px')).toBe('35px')
    await send({ type: 'set-transient-presentations', presentations: [{ ...presentation(5), fence: { ...fence, measurementRevision: fence.measurementRevision + 1 } }] })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width), value => value === '20px')).toBe('20px')

    fence = { ...fence, measurementRevision: await currentMeasurementRevision() }
    await send({ type: 'set-transient-presentations', presentations: [presentation(6)] })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width), value => value === '35px')).toBe('35px')
    await sendForGeneration(generation - 1, { type: 'set-transient-presentations', presentations: [presentation(7)] })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width), value => value === '20px')).toBe('20px')

    fence = { ...fence, measurementRevision: await currentMeasurementRevision() }
    await send({ type: 'set-transient-presentations', presentations: [presentation(8)] })
    await frame.evaluate(() => {
      const oldRoot = document.querySelector<HTMLElement>('[data-preview-canvas="selected"]')!
      const replacement = document.createElement('div')
      replacement.dataset.previewCanvas = 'selected'
      replacement.dataset.previewKind = 'rectangle'
      replacement.style.setProperty('left', '31px', 'revert-layer')
      ;(window as unknown as { activeOldRoot?: HTMLElement; activeReplacementRoot?: HTMLElement }).activeOldRoot = oldRoot
      ;(window as unknown as { activeReplacementRoot?: HTMLElement }).activeReplacementRoot = replacement
      oldRoot.replaceWith(replacement)
    })
    const remounted = await waitFor(() => frame.evaluate(() => {
      const oldRoot = (window as unknown as { activeOldRoot?: HTMLElement }).activeOldRoot!
      const replacement = (window as unknown as { activeReplacementRoot?: HTMLElement }).activeReplacementRoot!
      return { oldConnected: oldRoot.isConnected, oldLeft: oldRoot.style.left, oldWidth: oldRoot.style.width, replacementLeft: replacement.style.left, replacementWidth: replacement.style.width }
    }), value => value.replacementWidth === '35px')
    expect(remounted).toStrictEqual({ oldConnected: false, oldLeft: '11px', oldWidth: '20px', replacementLeft: '30px', replacementWidth: '35px' })
    await frame.evaluate(() => {
      const oldRoot = (window as unknown as { activeOldRoot?: HTMLElement }).activeOldRoot!
      const replacement = (window as unknown as { activeReplacementRoot?: HTMLElement }).activeReplacementRoot!
      replacement.replaceWith(oldRoot)
    })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width), value => value === '35px')).toBe('35px')
    await frame.evaluate(() => {
      const oldRoot = document.querySelector<HTMLElement>('[data-preview-instance="button-1"]')!
      const replacement = document.createElement('button')
      replacement.dataset.previewInstance = 'button-1'
      replacement.dataset.previewComponent = 'atom-button'
      replacement.style.setProperty('left', '21px', 'revert-layer')
      replacement.style.setProperty('width', '33px', 'important')
      replacement.style.setProperty('background-position', '31px 32px', 'important')
      ;(window as unknown as { activeOldComponent?: HTMLElement; activeReplacementComponent?: HTMLElement }).activeOldComponent = oldRoot
      ;(window as unknown as { activeReplacementComponent?: HTMLElement }).activeReplacementComponent = replacement
      oldRoot.replaceWith(replacement)
    })
    const componentRemounted = await waitFor(() => frame.evaluate(() => {
      const oldRoot = (window as unknown as { activeOldComponent?: HTMLElement }).activeOldComponent!
      const replacement = (window as unknown as { activeReplacementComponent?: HTMLElement }).activeReplacementComponent!
      return { oldConnected: oldRoot.isConnected, oldLeft: oldRoot.style.left, oldWidth: oldRoot.style.width, replacementLeft: replacement.style.left, replacementWidth: replacement.style.width, replacementPosition: replacement.style.backgroundPosition }
    }), value => value.replacementWidth === '80px' && value.replacementPosition === '6px 7px')
    expect(componentRemounted).toStrictEqual({ oldConnected: false, oldLeft: '13px', oldWidth: '44px', replacementLeft: '-8px', replacementWidth: '80px', replacementPosition: '6px 7px' })
    await frame.evaluate(() => {
      const oldRoot = (window as unknown as { activeOldComponent?: HTMLElement }).activeOldComponent!
      const replacement = (window as unknown as { activeReplacementComponent?: HTMLElement }).activeReplacementComponent!
      replacement.replaceWith(oldRoot)
    })
    expect(await waitFor(() => frame.$eval('[data-preview-instance="button-1"]', element => ({ width: (element as HTMLElement).style.width, position: (element as HTMLElement).style.backgroundPosition })), value => value.width === '80px' && value.position === '6px 7px')).toStrictEqual({ width: '80px', position: '6px 7px' })

    await page.evaluate(([origin, activeGeneration, activeFence]) => {
      const target = document.querySelector('iframe')!.contentWindow!
      for (let index = 0; index < 501; index += 1) target.postMessage({
        channel: 'design-editor-preview', version: 8, generation: activeGeneration, type: 'set-transient-presentations',
        presentations: [{ kind: 'move-world', coordinateSpace: 'world', interactionId: `bounded-${index}`, sampleSequence: 0, fence: activeFence, items: [{ nodeId: 'selected', dx: index, dy: 0 }] }],
      }, origin as string)
    }, [previewOrigin, generation, fence] as const)
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => ({ translate: (element as HTMLElement).style.translate, width: (element as HTMLElement).style.width })), value => value.translate === '' && value.width === '20px')).toStrictEqual({ translate: '', width: '20px' })

    fence = { ...fence, measurementRevision: await currentMeasurementRevision() }
    await send({ type: 'set-transient-presentations', presentations: [presentation(9)] })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width), value => value === '35px')).toBe('35px')
    await send({ type: 'set-transient-presentations', presentations: [{ ...presentation(10), untrustedExtra: true }] })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width), value => value === '20px')).toBe('20px')
    fence = { ...fence, measurementRevision: await currentMeasurementRevision() }
    await send({ type: 'set-transient-presentations', presentations: [presentation(11)] })
    expect(await waitFor(() => frame.$eval('[data-preview-canvas="selected"]', element => (element as HTMLElement).style.width), value => value === '35px')).toBe('35px')
    await frame.evaluate(() => { (window as unknown as { oldPresentationRoot?: HTMLElement }).oldPresentationRoot = document.querySelector<HTMLElement>('[data-preview-canvas="selected"]')! })
    await send({ type: 'set-document', flowDragTerminalPolicy: 'preserve-matching-committed-handoff', document: previewDocument(13, false), theme: { attribute: null, colorScheme: 'light' } })
    const retired = await waitFor(() => frame.evaluate(() => {
      const old = (window as unknown as { oldPresentationRoot?: HTMLElement }).oldPresentationRoot!
      return { connected: old.isConnected, left: old.style.getPropertyValue('left'), leftPriority: old.style.getPropertyPriority('left'), width: old.style.getPropertyValue('width'), backgroundPosition: old.style.getPropertyValue('background-position') }
    }), value => !value.connected)
    expect(retired).toStrictEqual({ connected: false, left: '11px', leftPriority: 'important', width: '20px', backgroundPosition: 'center center' })

    await frame.evaluate(() => {
      const component = document.querySelector<HTMLElement>('[data-preview-instance="button-1"]')!
      component.style.setProperty('left', '17px', 'important')
      ;(window as unknown as { disposePresentationRoot?: HTMLElement }).disposePresentationRoot = component
    })
    const disposeFence = { documentRevision: 13, layoutGeneration: 1, measurementRevision: await currentMeasurementRevision() }
    await send({
      type: 'set-transient-presentations',
      presentations: [{
        kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'dispose-resize', sampleSequence: 1,
        fence: disposeFence,
        items: [{ nodeId: 'button-1', parentNodeId: null, startRect: { x: 0, y: 0, width: 40, height: 20 }, rect: { x: 3, y: 4, width: 70, height: 30 }, appearance: { fills: [{ type: 'image', assetId: 'photo', fit: 'cover', geometry: { x: 2, y: 3, width: 80, height: 40 } }] } }],
      }],
    })
    expect(await waitFor(() => frame.$eval('[data-preview-instance="button-1"]', element => (element as HTMLElement).style.width), value => value === '70px')).toBe('70px')
    await send({ type: 'dispose' })
    const disposed = await frame.evaluate(() => {
      const old = (window as unknown as { disposePresentationRoot?: HTMLElement }).disposePresentationRoot!
      return { connected: old.isConnected, left: old.style.getPropertyValue('left'), leftPriority: old.style.getPropertyPriority('left'), width: old.style.getPropertyValue('width'), backgroundImage: old.style.getPropertyValue('background-image'), backgroundPosition: old.style.getPropertyValue('background-position') }
    })
    expect(disposed).toStrictEqual({ connected: false, left: '17px', leftPriority: 'important', width: '44px', backgroundImage: '', backgroundPosition: '21px 22px' })

    await frame.evaluate(() => { (window as unknown as { presentationObserver: MutationObserver }).presentationObserver.disconnect() })
  }, 90_000)
})
