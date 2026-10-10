import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const editorUrl = 'http://127.0.0.1:4317/'
const evidenceRoot = join(import.meta.dirname, '../../../outputs/selected-container-drag')
const fileId = page => decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
const storedFile = page => page.evaluate(id => {
  const raw = localStorage.getItem(`design-editor.browser-file.${id}.v3`)
  return raw ? JSON.parse(raw).file : null
}, fileId(page))
const hud = page => page.locator('.canvas-hud-canvas').evaluate(canvas => JSON.parse(canvas.dataset.hud ?? '{"selected":{}}'))
const waitFor = async (read, predicate, message) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(message)
}
const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
const moveBy = async (page, point, delta, release = true) => {
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + delta.x, point.y + delta.y, { steps: 8 })
  if (release) await page.mouse.up()
}

await mkdir(evidenceRoot, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1506, height: 922 } })
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /New file/i }).first().click()
  const stage = page.locator('.canvas-stage')
  await stage.waitFor({ timeout: 20_000 })
  await page.frameLocator('iframe[title="Canvas"]').locator('#preview-root').waitFor({ state: 'attached', timeout: 20_000 })
  const stageBox = await stage.boundingBox()
  const frameStart = { x: stageBox.x + 420, y: stageBox.y + 260 }
  const frameEnd = { x: frameStart.x + 420, y: frameStart.y + 300 }

  await page.keyboard.press('f')
  await moveBy(page, frameStart, { x: frameEnd.x - frameStart.x, y: frameEnd.y - frameStart.y })
  const layers = page.getByRole('tree', { name: 'Layers' })
  const frameLayer = layers.getByRole('treeitem', { name: 'Frame' })
  await frameLayer.waitFor({ timeout: 10_000 })
  const frameId = await frameLayer.getAttribute('data-instance-id')

  await page.keyboard.press('r')
  await moveBy(page, { x: frameStart.x + 60, y: frameStart.y + 65 }, { x: 280, y: 170 })
  const childLayer = layers.getByRole('treeitem', { name: 'Rectangle' })
  await childLayer.waitFor({ timeout: 10_000 })
  const childId = await childLayer.getAttribute('data-instance-id')
  assert.ok(frameId && childId)
  assert.equal((await storedFile(page)).relationships[childId].parentId, frameId)

  await frameLayer.click()
  const fill = page.getByRole('textbox', { name: 'Fill 1 color', exact: true })
  await fill.click()
  await fill.fill('#685fff')
  await fill.press('Enter')
  await page.waitForTimeout(100)
  await page.screenshot({ path: join(evidenceRoot, 'light-selected-frame-label.png') })

  await page.getByRole('button', { name: 'Switch editor appearance to dark' }).click()
  await page.screenshot({ path: join(evidenceRoot, 'dark-selected-frame-label.png') })

  const preview = page.frameLocator('iframe[title="Canvas"]')
  const childNode = preview.locator(`[data-preview-canvas="${childId}"]`)
  const childBox = await childNode.boundingBox()
  const frameBefore = structuredClone((await storedFile(page)).nodes[frameId].styles)
  const childBefore = structuredClone((await storedFile(page)).nodes[childId].styles)
  const dragStart = center(childBox)
  const delta = { x: 70, y: 45 }

  await moveBy(page, dragStart, delta, false)
  assert.equal((await layers.locator(`[data-instance-id="${frameId}"]`).getAttribute('aria-selected')), 'true')
  assert.deepEqual((await hud(page)).selected, {}, 'selected-frame chrome must stay hidden during its transient move')
  assert.notEqual(await preview.locator(`[data-preview-canvas="${frameId}"]`).evaluate(element => element.style.translate), '')
  assert.equal(await childNode.evaluate(element => element.style.translate), '', 'child must not receive a separate transient move')
  await page.screenshot({ path: join(evidenceRoot, 'selected-frame-held-over-child.png') })
  await page.mouse.up()
  await page.waitForFunction(id => JSON.parse(document.querySelector('.canvas-hud-canvas')?.dataset.hud ?? '{"selected":{}}').selected[id] !== undefined, frameId)
  const afterParentDrag = await storedFile(page)
  assert.notDeepEqual(afterParentDrag.nodes[frameId].styles, frameBefore)
  assert.deepEqual(afterParentDrag.nodes[childId].styles, childBefore)
  assert.equal(afterParentDrag.relationships[childId].parentId, frameId)
  await page.screenshot({ path: join(evidenceRoot, 'selected-frame-placed.png') })

  const movedChildBox = await childNode.boundingBox()
  await page.mouse.click(center(movedChildBox).x, center(movedChildBox).y)
  assert.equal(await childLayer.getAttribute('aria-selected'), 'true', 'a child click must drill into the child')
  const beforeChildDrag = await storedFile(page)
  await moveBy(page, center(movedChildBox), { x: 32, y: 0 })
  const afterChildDrag = await waitFor(
    () => storedFile(page),
    file => JSON.stringify(file.nodes[childId].styles) !== JSON.stringify(beforeChildDrag.nodes[childId].styles),
    'the selected child drag did not persist',
  )
  assert.deepEqual(afterChildDrag.nodes[frameId].styles, beforeChildDrag.nodes[frameId].styles, 'an already-selected child drag must not move its parent')
  assert.notDeepEqual(afterChildDrag.nodes[childId].styles, beforeChildDrag.nodes[childId].styles)

  await frameLayer.click()
  const rotation = page.getByRole('textbox', { name: 'Rotation', exact: true })
  await rotation.click()
  await rotation.fill('30')
  await rotation.press('Enter')
  const rotated = await waitFor(() => storedFile(page), file => file.nodes[frameId].styles.rotation === 30 ? file : null, 'frame rotation did not persist')
  assert.equal(rotated.nodes[frameId].styles.rotation, 30)
  const rotatedHud = await waitFor(() => hud(page), value => value.quads?.[frameId]?.length === 4 ? value : null, 'rotated HUD quad was not painted')
  const [topLeft, topRight] = rotatedHud.quads[frameId]
  assert.ok(Math.abs(topRight.y - topLeft.y) > 1, 'selection outline top edge follows the node rotation')
  assert.match(await page.locator(`[data-node-label="${frameId}"]`).getAttribute('style'), /rotate\(0\.523/, 'node label follows the visually top face')
  await page.screenshot({ path: join(evidenceRoot, 'rotated-frame-selection.png') })

  await page.getByRole('button', { name: 'Switch editor appearance to light' }).click()
  process.stdout.write(`${JSON.stringify({ status: 'passed', frameId, childId, screenshots: ['light-selected-frame-label.png', 'dark-selected-frame-label.png', 'selected-frame-held-over-child.png', 'selected-frame-placed.png', 'rotated-frame-selection.png'] })}\n`)
} finally {
  await browser.close()
}
