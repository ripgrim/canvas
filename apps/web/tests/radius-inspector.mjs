import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const editorUrl = 'http://127.0.0.1:4317/'
const evidenceRoot = join(import.meta.dirname, '../../../outputs/radius-inspector')
const fileId = page => decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
const storedFile = page => page.evaluate(id => {
  const raw = localStorage.getItem(`design-editor.browser-file.${id}.v3`)
  return raw ? JSON.parse(raw).file : null
}, fileId(page))
const waitFor = async (read, predicate, message) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(message)
}
const commit = async (field, value) => { await field.click(); await field.fill(String(value)); await field.press('Enter') }
const draw = async (page, start, end) => {
  await page.keyboard.press('r')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 6 })
  await page.mouse.up()
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
  assert.ok(stageBox)
  await draw(page, { x: stageBox.x + 410, y: stageBox.y + 250 }, { x: stageBox.x + 730, y: stageBox.y + 450 })

  const rectangle = page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Rectangle' })
  await rectangle.waitFor({ timeout: 10_000 })
  const nodeId = await rectangle.getAttribute('data-instance-id')
  assert.ok(nodeId)

  const radius = page.getByRole('textbox', { name: 'Corner radius', exact: true })
  const slider = page.getByRole('slider', { name: 'Corner radius', exact: true })
  await radius.waitFor()
  assert.ok(await slider.isVisible(), 'unified radius slider is visible by default')
  await commit(radius, 24)
  await waitFor(() => storedFile(page), file => file?.nodes[nodeId]?.appearance?.cornerRadii?.all === 24, 'unified radius did not persist')
  const previewNode = page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-canvas="${nodeId}"]`)
  await waitFor(() => previewNode.evaluate(element => getComputedStyle(element).borderRadius), value => value === '24px', 'unified radius did not render')

  await page.getByRole('button', { name: 'Show individual corners', exact: true }).click()
  const topLeft = page.getByRole('textbox', { name: 'Top-left radius', exact: true })
  await topLeft.waitFor()
  await commit(topLeft, 40)
  const individual = await waitFor(() => storedFile(page), file => file?.nodes[nodeId]?.appearance?.cornerRadii?.topLeft === 40 ? file : null, 'individual radius did not persist')
  assert.deepEqual(individual.nodes[nodeId].appearance.cornerRadii, { topLeft: 40, topRight: 24, bottomLeft: 24, bottomRight: 24 })
  await waitFor(() => previewNode.evaluate(element => getComputedStyle(element).borderRadius), value => value === '40px 24px 24px', 'individual radii did not render')
  await page.screenshot({ path: join(evidenceRoot, 'radius-individual-light.png') })

  await page.getByRole('button', { name: 'Switch editor appearance to dark' }).click()
  await page.waitForTimeout(300)
  const darkStyle = await previewNode.evaluate(element => {
    const style = getComputedStyle(element)
    return { width: style.width, height: style.height, borderRadius: style.borderRadius, backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, backgroundSize: style.backgroundSize, backgroundRepeat: style.backgroundRepeat }
  })
  assert.deepEqual({ width: darkStyle.width, height: darkStyle.height, borderRadius: darkStyle.borderRadius }, { width: '320px', height: '200px', borderRadius: '40px 24px 24px' })
  await page.screenshot({ path: join(evidenceRoot, 'radius-individual-dark.png') })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.canvas-stage').waitFor({ timeout: 20_000 })
  await page.getByRole('tree', { name: 'Layers' }).locator(`[data-instance-id="${nodeId}"]`).click()
  assert.equal(await page.getByRole('textbox', { name: 'Top-left radius', exact: true }).inputValue(), '40')
  assert.equal(await page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-canvas="${nodeId}"]`).evaluate(element => getComputedStyle(element).borderRadius), '40px 24px 24px')

  process.stdout.write(`${JSON.stringify({ status: 'passed', nodeId, darkStyle, screenshots: ['radius-individual-light.png', 'radius-individual-dark.png'] })}\n`)
} finally {
  await browser.close()
}
