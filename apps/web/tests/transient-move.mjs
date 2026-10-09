import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const editorUrl = 'http://127.0.0.1:4317/'
const evidenceRoot = join(import.meta.dirname, '../../../outputs/transient-move')
const waitFor = async (read, predicate, message) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(message)
}
const fileId = page => decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
const storedFile = page => page.evaluate(id => {
  const raw = localStorage.getItem(`design-editor.browser-file.${id}.v3`)
  return raw ? JSON.parse(raw).file : null
}, fileId(page))
const camera = page => page.evaluate(() => {
  const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(document.querySelector('.canvas-world').style.transform)
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) }
})
const hud = page => page.locator('.canvas-hud-canvas').evaluate(canvas => JSON.parse(canvas.dataset.hud ?? '{"selected":{}}'))

await mkdir(evidenceRoot, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 } })
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /New file/i }).first().click()
  const stage = page.locator('.canvas-stage')
  await stage.waitFor({ timeout: 20_000 })
  await page.frameLocator('iframe[title="Canvas"]').locator('#preview-root').waitFor({ state: 'attached', timeout: 20_000 })
  const stageBox = await stage.boundingBox()
  const size = await page.locator('.canvas-viewport').evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }))
  const cam = await camera(page)
  const screen = point => ({ x: stageBox.x + size.width / 2 + cam.x + point.x * cam.zoom, y: stageBox.y + size.height / 2 + cam.y + point.y * cam.zoom })
  const drawFrom = screen({ x: -120, y: -80 })
  const drawTo = screen({ x: 120, y: 40 })
  await page.keyboard.press('r')
  await page.mouse.move(drawFrom.x, drawFrom.y)
  await page.mouse.down()
  await page.mouse.move(drawTo.x, drawTo.y, { steps: 8 })
  await page.mouse.up()
  const layer = page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Rectangle' })
  await layer.waitFor({ timeout: 10_000 })
  const nodeId = await layer.getAttribute('data-instance-id')
  const previewNode = page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-canvas="${nodeId}"]`)
  const beforeBox = await previewNode.boundingBox()
  const beforeFile = await storedFile(page)
  const beforeViewport = await page.locator('.canvas-viewport').boundingBox()
  const center = { x: beforeBox.x + beforeBox.width / 2, y: beforeBox.y + beforeBox.height / 2 }
  const delta = { x: 84, y: 52 }

  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x + delta.x, center.y + delta.y, { steps: 10 })
  await waitFor(() => previewNode.evaluate(element => element.style.translate), value => value !== '', 'the transient translate did not reach the preview node')
  const heldBox = await previewNode.boundingBox()
  assert.ok(Math.abs(heldBox.x - beforeBox.x - delta.x) <= 1.5, `held x delta was ${heldBox.x - beforeBox.x}`)
  assert.ok(Math.abs(heldBox.y - beforeBox.y - delta.y) <= 1.5, `held y delta was ${heldBox.y - beforeBox.y}`)
  assert.deepEqual((await hud(page)).selected, {}, 'selection chrome must be absent while dragging')
  assert.deepEqual((await storedFile(page)).nodes[nodeId].styles, beforeFile.nodes[nodeId].styles, 'the authoritative node changed before pointer-up')
  assert.deepEqual(await page.locator('.canvas-viewport').boundingBox(), beforeViewport, 'the canvas viewport jumped during the edit')
  await page.screenshot({ path: join(evidenceRoot, 'node-held-without-outline.png') })

  await page.mouse.up()
  await waitFor(() => previewNode.evaluate(element => element.style.translate), value => value === '', 'the transient translate did not clear after pointer-up')
  await waitFor(() => hud(page), value => Object.hasOwn(value.selected, nodeId), 'the selection outline did not return after placement')
  const placedBox = await previewNode.boundingBox()
  assert.ok(Math.abs(placedBox.x - heldBox.x) <= 1.5 && Math.abs(placedBox.y - heldBox.y) <= 1.5, 'the node jumped when the pointer was released')
  const afterFile = await storedFile(page)
  assert.notDeepEqual(afterFile.nodes[nodeId].styles, beforeFile.nodes[nodeId].styles, 'pointer-up did not commit the node geometry')
  assert.deepEqual(await page.locator('.canvas-viewport').boundingBox(), beforeViewport, 'the canvas viewport jumped after placement')
  await page.screenshot({ path: join(evidenceRoot, 'node-placed-with-outline.png') })
  process.stdout.write(`${JSON.stringify({ status: 'passed', nodeId, delta, before: beforeBox, held: heldBox, placed: placedBox })}\n`)
} finally {
  await browser.close()
}
