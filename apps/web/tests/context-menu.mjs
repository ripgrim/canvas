import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const editorUrl = 'http://127.0.0.1:4317/'
const previewUrl = 'http://127.0.0.1:4318/'
const evidenceRoot = join(import.meta.dirname, '../../../outputs/context-menu')
const webRequire = createRequire(join(webRoot, 'package.json'))
const owned = []

const responseAt = async url => { try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.ok ? await response.text() : null } catch { return null } }
async function ensureServer(name, url, args, expected) {
  const existing = await responseAt(url)
  if (existing !== null) { assert.match(existing, expected); return }
  const vite = join(dirname(webRequire.resolve('vite/package.json')), 'bin', 'vite.js')
  const child = spawn(process.execPath, [vite, ...args], { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  owned.push(child)
  let log = ''
  child.stdout.on('data', chunk => { log = (log + String(chunk)).slice(-4000) })
  child.stderr.on('data', chunk => { log = (log + String(chunk)).slice(-4000) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited: ${log}`)
    const body = await responseAt(url)
    if (body !== null) { assert.match(body, expected); return }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`${name} did not become ready: ${log}`)
}

await mkdir(evidenceRoot, { recursive: true })
await ensureServer('editor', editorUrl, ['--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4317', '--strictPort'], /Comp Canvas|Design editor|@vite\/client|TanStack/)
await ensureServer('preview', previewUrl, ['--config', 'vite.preview.config.ts', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4318', '--strictPort'], /preview-root|@vite\/client|<html/i)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 } })
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /New file/i }).first().click()
  const stage = page.locator('.canvas-stage')
  await stage.waitFor({ timeout: 20_000 })
  await page.frameLocator('iframe[title="Canvas"]').locator('#preview-root').waitFor({ state: 'attached', timeout: 20_000 })
  const expandComponents = page.getByRole('button', { name: /Expand Components/ })
  if (await expandComponents.count()) await expandComponents.click()
  await page.getByRole('button', { name: 'Add Button', exact: true }).click()
  const tree = page.getByRole('tree', { name: 'Layers' })
  const layer = tree.getByRole('treeitem', { name: 'Button' })
  await layer.waitFor({ timeout: 10_000 })

  await layer.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Layer actions' })
  await menu.waitFor()
  assert.equal(await menu.getByRole('menuitem', { name: 'Group selection Ctrl+G' }).isEnabled(), false, 'unsupported Group stays visibly disabled')
  assert.equal(await menu.getByRole('menuitem', { name: 'Copy Ctrl+C' }).isEnabled(), true)
  await page.screenshot({ path: join(evidenceRoot, 'layer-context-menu.png') })

  // AT-CTX-001: the Copy as submenu is a sibling portal, so opening it cannot change the parent surface overflow.
  const surface = page.locator('.context-menu-surface')
  const copyAs = menu.getByRole('menuitem', { name: 'Copy as…' })
  const beforeSubmenu = await surface.evaluate(element => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }))
  await copyAs.hover()
  const submenu = page.getByRole('menu', { name: 'Copy as…' })
  await submenu.waitFor()
  assert.equal(await submenu.evaluate(element => element.parentElement?.classList.contains('context-menu-submenu-layer')), true, 'submenu is inside its fixed portal layer')
  assert.equal(await submenu.evaluate(element => element.closest('.context-menu-surface') === null), true, 'submenu is outside the parent scrolling surface')
  assert.deepEqual(await surface.evaluate(element => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  })), beforeSubmenu, 'opening the submenu does not add parent overflow')
  const triggerBox = await copyAs.boundingBox()
  const submenuBox = await submenu.boundingBox()
  const side = await submenu.locator('..').getAttribute('data-side')
  assert.ok(side === 'right' ? submenuBox.x >= triggerBox.x + triggerBox.width : submenuBox.x + submenuBox.width <= triggerBox.x, 'submenu is placed on its declared side')
  await page.screenshot({ path: join(evidenceRoot, 'copy-as-submenu.png') })

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
  await tree.getByRole('treeitem', { name: 'Button' }).nth(1).waitFor()
  assert.equal(await tree.getByRole('treeitem', { name: 'Button' }).count(), 2, 'paste on top duplicates the layer')

  const selected = tree.locator('[role="treeitem"][aria-selected="true"]')
  const nodeId = await selected.getAttribute('data-instance-id')
  const previewNode = page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-instance="${nodeId}"]`)
  const nodeBox = await previewNode.boundingBox()
  await page.mouse.click(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2, { button: 'right' })
  await menu.waitFor()
  assert.equal(await menu.getByRole('menuitem', { name: 'Copy link' }).isEnabled(), true, 'canvas invocation selects the hit node')
  process.stdout.write(`${JSON.stringify({ status: 'passed', nodeId, screenshot: join(evidenceRoot, 'layer-context-menu.png') })}\n`)
} finally {
  await browser.close()
  for (const child of owned) child.kill()
}
