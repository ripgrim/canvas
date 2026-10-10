import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const editorUrl = 'http://127.0.0.1:4317/'
const evidenceRoot = join(import.meta.dirname, '../../../outputs/context-menu')

await mkdir(evidenceRoot, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 } })
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /New file/i }).first().click()
  const stage = page.locator('.canvas-stage')
  await stage.waitFor({ timeout: 20_000 })
  const box = await stage.boundingBox()
  await page.keyboard.press('r')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const tree = page.getByRole('tree', { name: 'Layers' })
  const layer = tree.getByRole('treeitem', { name: 'Rectangle' })
  await layer.waitFor({ timeout: 10_000 })

  await layer.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Layer actions' })
  await menu.waitFor()
  assert.equal(await menu.getByRole('menuitem', { name: 'Group selection Ctrl+G' }).isEnabled(), false, 'unsupported Group stays visibly disabled')
  assert.equal(await menu.getByRole('menuitem', { name: 'Copy Ctrl+C' }).isEnabled(), true)
  await page.screenshot({ path: join(evidenceRoot, 'layer-context-menu.png') })

  // AT-CAN-005 / AT-UX-002: the first Escape belongs to the menu and preserves selection; the next reaches the editor.
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  assert.equal(await tree.locator('[role="treeitem"][aria-selected="true"]').count(), 1, 'closing the menu keeps the node selected')
  await page.keyboard.press('Escape')
  assert.equal(await tree.locator('[role="treeitem"][aria-selected="true"]').count(), 0, 'a second Escape clears editor selection')
  await layer.click({ button: 'right' })
  await menu.waitFor()

  await menu.getByRole('menuitem', { name: 'Copy Ctrl+C' }).click()
  await layer.click({ button: 'right' })
  assert.equal(await menu.getByRole('menuitem', { name: 'Paste on top Ctrl+Shift+V' }).isEnabled(), true)
  await menu.getByRole('menuitem', { name: 'Paste on top Ctrl+Shift+V' }).click()
  await tree.getByRole('treeitem', { name: 'Rectangle' }).nth(1).waitFor()
  assert.equal(await tree.getByRole('treeitem', { name: 'Rectangle' }).count(), 2, 'paste on top duplicates the layer')

  const selected = tree.locator('[role="treeitem"][aria-selected="true"]')
  const nodeId = await selected.getAttribute('data-instance-id')
  const previewNode = page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-canvas="${nodeId}"]`)
  const nodeBox = await previewNode.boundingBox()
  await page.mouse.click(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2, { button: 'right' })
  await menu.waitFor()
  assert.equal(await menu.getByRole('menuitem', { name: 'Copy link' }).isEnabled(), true, 'canvas invocation selects the hit node')
  process.stdout.write(`${JSON.stringify({ status: 'passed', nodeId, screenshot: join(evidenceRoot, 'layer-context-menu.png') })}\n`)
} finally {
  await browser.close()
}
