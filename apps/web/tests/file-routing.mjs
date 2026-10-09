// Permanent file URLs: /file/$fileId with a validated pageId search parameter. Fresh browser evidence against the running dev servers.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const evidenceRoot = join(projectRoot, 'outputs', 'file-routing')
const editorUrl = 'http://127.0.0.1:4317/'
const evidence = { status: 'failed', checks: [], screenshots: [], error: null }
let browser = null
let activePage = null
const record = (name, detail = '') => { evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log('✓', name, detail) }
const shot = async (page, name) => { await page.screenshot({ path: join(evidenceRoot, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }
// Storage layout: a file index (names only), one content record per file, and per-file view state (active page, preview theme, cameras).
const indexKey = 'design-editor.browser-files-index.v3'
const contentKey = fileId => `design-editor.browser-file.${fileId}.v3`
const viewKey = 'design-editor.view-state.v1'
const files = page => page.evaluate(key => Object.values(JSON.parse(localStorage.getItem(key) ?? '{"files":{}}').files), indexKey)
const content = (page, fileId) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.file ?? null, contentKey(fileId))
const viewOf = (page, fileId) => page.evaluate(([key, fileId]) => JSON.parse(localStorage.getItem(key) ?? '{"files":{}}').files[fileId] ?? null, [viewKey, fileId])
const waitActivePage = (page, fileId, pageId) => page.waitForFunction(([key, fileId, pageId]) => JSON.parse(localStorage.getItem(key) ?? '{"files":{}}').files[fileId]?.activePageId === pageId, [viewKey, fileId, pageId])
const layers = async page => page.getByRole('tree', { name: 'Layers' }).locator('[role="treeitem"]').evaluateAll(items => items.map(item => ({ id: item.getAttribute('data-instance-id'), name: item.getAttribute('aria-label') })))
const pathOf = page => { const url = new URL(page.url()); return url.pathname + url.search }
const hudSelected = async page => Object.keys(JSON.parse(await page.locator('.canvas-hud-canvas').getAttribute('data-hud') ?? '{"selected":{}}').selected)
const nodeParam = page => new URL(page.url()).searchParams.get('nodeId')
const selectedPage = page => page.locator('.left-rail [data-page-id][aria-current="page"], .left-rail [data-page-id][data-selected], .left-rail [data-page-id][aria-selected="true"]').first()
async function drawFrame(page) {
  const stage = await page.locator('.canvas-stage').boundingBox()
  await page.keyboard.press('f')
  await page.mouse.move(stage.x + 450, stage.y + 200); await page.mouse.down(); await page.mouse.move(stage.x + 650, stage.y + 350, { steps: 8 }); await page.mouse.up()
  await page.getByRole('tree', { name: 'Layers' }).locator('[role="treeitem"]').first().waitFor()
}
async function waitEditor(page) { await page.locator('.canvas-stage').waitFor({ timeout: 20_000 }); await page.waitForTimeout(300) }

async function run() {
  await mkdir(evidenceRoot, { recursive: true })
  assert.ok(await fetch(editorUrl).then(response => response.ok).catch(() => false), 'editor dev server must be running on 4317')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1500, height: 940 } })
  const page = await context.newPage()
  activePage = page
  page.on('pageerror', error => { evidence.error = `Page error: ${error.message}` })
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { localStorage.clear() })
  await page.reload({ waitUntil: 'domcontentloaded' })

  // 1. Create navigates to /file/<existing persistent id>.
  await page.getByRole('button', { name: /New file/i }).first().click()
  await waitEditor(page)
  const stored = await files(page)
  assert.equal(stored.length, 1)
  const fileA = stored[0].id
  await page.waitForFunction(() => new URL(location.href).searchParams.has('pageId'))
  const pageA = new URL(page.url()).searchParams.get('pageId')
  const storedA = await content(page, fileA)
  assert.equal(storedA.fileId, fileA, 'the content record belongs to the indexed file')
  assert.deepEqual(storedA.pages.map(p => p.id), [pageA], 'URL names the stored page')
  await waitActivePage(page, fileA, pageA)
  assert.equal((await viewOf(page, fileA)).activePageId, pageA, 'view state remembers the open page')
  assert.equal(pathOf(page), `/file/${fileA}?pageId=${pageA}`)
  assert.match(await page.title(), /Untitled 1 · Comp Canvas/)
  await drawFrame(page)
  const frameLayer = (await layers(page))[0]
  await shot(page, '01-file-route')
  record('Create navigates to the file URL using the stored id', pathOf(page))

  // 2. Refresh keeps the route (including the selected node) and loads the same file, contents, and selection.
  await page.waitForFunction(([key, id]) => { const file = JSON.parse(localStorage.getItem(key) ?? 'null')?.file; return Boolean(file?.nodes[id] && file.relationships[id]?.parentId === file.pages[0].rootNodeId) }, [contentKey(fileA), frameLayer.id])
  assert.deepEqual(Object.values((await content(page, fileA)).nodes).filter(node => node.type !== 'root').map(node => [node.id, node.type]), [[frameLayer.id, 'frame']], 'the drawn frame is the only stored node')
  await page.waitForFunction(id => new URL(location.href).searchParams.get('nodeId') === id, frameLayer.id)
  assert.equal(pathOf(page), `/file/${fileA}?pageId=${pageA}&nodeId=${frameLayer.id}`, 'drawing selects the frame and the URL names it')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  assert.equal(pathOf(page), `/file/${fileA}?pageId=${pageA}&nodeId=${frameLayer.id}`)
  assert.deepEqual(await layers(page), [frameLayer])
  await page.waitForFunction(id => JSON.parse(document.querySelector('.canvas-hud-canvas')?.getAttribute('data-hud') ?? '{"selected":{}}').selected[id] !== undefined, frameLayer.id)
  assert.equal((await files(page))[0].id, fileA, 'no new id on refresh')
  record('Refresh reopens the same file by id with its contents and restores the selected node from the URL')

  // 3. Pages: adding one puts a validated pageId in the search; Back/Forward move between pages.
  const entriesBeforeAdd = await page.evaluate(() => history.length)
  await page.getByRole('button', { name: 'Add page' }).click()
  await page.waitForFunction(id => new URL(location.href).searchParams.get('pageId') !== id, pageA)
  const pageB = new URL(page.url()).searchParams.get('pageId')
  await page.waitForFunction(([key, id]) => JSON.parse(localStorage.getItem(key) ?? 'null')?.file.pages.some(p => p.id === id), [contentKey(fileA), pageB])
  const storedAfterPage = await content(page, fileA)
  assert.deepEqual(storedAfterPage.pages.map(p => p.id), [pageA, pageB])
  assert.deepEqual((await files(page)).map(entry => entry.id), [fileA], 'adding a page creates no file')
  await waitActivePage(page, fileA, pageB)
  await waitEditor(page)
  assert.deepEqual(await layers(page), [], 'new page starts empty')
  assert.equal(await page.evaluate(() => history.length), entriesBeforeAdd + 1, 'Add page pushes one history entry so Back returns to the previous page')
  await page.evaluate(() => history.back())
  await page.waitForFunction(id => new URL(location.href).searchParams.get('pageId') === id, pageA)
  await waitEditor(page)
  assert.deepEqual(await layers(page), [frameLayer], 'Back returns to the first page with its content')
  await page.evaluate(() => history.forward())
  await page.waitForFunction(id => new URL(location.href).searchParams.get('pageId') === id, pageB)
  await waitEditor(page)
  assert.deepEqual(await layers(page), [])
  await shot(page, '02-page-route')
  record('Page selection lives in ?pageId and Back/Forward switch pages', pageB)

  // 4. Direct entry in another tab loads the file and page from the URL.
  const tab = await context.newPage()
  await tab.goto(`${editorUrl}file/${fileA}`, { waitUntil: 'domcontentloaded' })
  await waitEditor(tab)
  await tab.waitForFunction(() => new URL(location.href).searchParams.has('pageId'))
  assert.equal(new URL(tab.url()).searchParams.get('pageId'), pageB, 'a bare file URL opens the saved (last opened) page')
  await tab.goto(`${editorUrl}file/${fileA}?pageId=${pageA}`, { waitUntil: 'domcontentloaded' })
  await waitEditor(tab)
  assert.deepEqual(await layers(tab), [frameLayer])
  await tab.goto(`${editorUrl}file/${fileA}?pageId=${pageB}`, { waitUntil: 'domcontentloaded' })
  await waitEditor(tab)
  assert.deepEqual(await layers(tab), [])
  await tab.close()
  record('Direct URL entry opens the right file and page in another tab')

  // 5. A second file: no leakage of layers, selection, or history; Back returns to the first file.
  await page.goto(`${editorUrl}file/${fileA}?pageId=${pageA}`, { waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  await page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem').first().click()
  await page.getByRole('button', { name: 'Files' }).click()
  await page.waitForFunction(() => location.pathname === '/')
  await page.getByRole('button', { name: /New file/i }).first().click()
  await waitEditor(page)
  const fileB = new URL(page.url()).pathname.split('/').pop()
  assert.notEqual(fileB, fileA)
  assert.deepEqual(await layers(page), [])
  assert.equal(await page.locator('.canvas-floating-actions button[aria-label="Undo document edit"]').isDisabled(), true, 'history does not leak between files')
  assert.deepEqual(JSON.parse(await page.locator('.canvas-hud-canvas').getAttribute('data-hud')).selected, {}, 'selection does not leak between files')
  await page.evaluate(() => history.back())
  await page.waitForFunction(() => location.pathname === '/')
  await page.evaluate(() => history.back())
  await page.waitForFunction(path => location.pathname === path, `/file/${fileA}`)
  await waitEditor(page)
  assert.deepEqual(await layers(page), [frameLayer])
  record('Switching files isolates document, selection, and history; Back/Forward restore files')

  // 6. Rapid navigation: the last requested file wins.
  await page.goto(`${editorUrl}file/${fileA}?pageId=${pageA}`, { waitUntil: 'commit' })
  await page.goto(`${editorUrl}file/${fileB}`, { waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  assert.ok(pathOf(page).startsWith(`/file/${fileB}?pageId=`), pathOf(page))
  assert.deepEqual(await layers(page), [])
  record('Rapid navigation never shows a stale file')

  // 7. Missing and invalid ids recover without creating files.
  const countBefore = (await files(page)).length
  await page.goto(`${editorUrl}file/01M38YBDDRJSMJ5M4VRYVV8E4Z`, { waitUntil: 'domcontentloaded' })
  await page.getByText('This file is not in this browser').waitFor({ timeout: 20_000 })
  assert.equal((await files(page)).length, countBefore, 'missing id does not create a file')
  await shot(page, '03-missing-file')
  await page.getByRole('button', { name: 'Back to files' }).click()
  await page.waitForFunction(() => location.pathname === '/')
  await page.getByRole('button', { name: /New file/i }).first().waitFor()
  await page.goto(`${editorUrl}file/${fileA}?pageId=not-a-page`, { waitUntil: 'domcontentloaded' })
  await page.getByText(/has no page with that id/).waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Open the saved page' }).click()
  await page.waitForFunction(([path, id]) => location.pathname === path && new URL(location.href).searchParams.get('pageId') === id, [`/file/${fileA}`, pageA])
  await waitEditor(page)
  assert.deepEqual(await layers(page), [frameLayer])
  await page.goto(`${editorUrl}file/${encodeURIComponent('bad id!')}`, { waitUntil: 'domcontentloaded' })
  await page.getByText('The file id in this address is not valid.').waitFor({ timeout: 20_000 })
  record('Missing file, missing page, and invalid ids show recovery states and never substitute a file')

  // 8. Selection lives in ?nodeId: selecting replaces the entry (no history growth), a copied link reopens with the node selected,
  //    clearing the selection removes the parameter, and unknown or malformed node ids are dropped without touching the selection.
  await page.goto(`${editorUrl}file/${fileA}?pageId=${pageA}`, { waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('nodeId'))
  const entriesBefore = await page.evaluate(() => history.length)
  await page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem').first().click()
  await page.waitForFunction(id => new URL(location.href).searchParams.get('nodeId') === id, frameLayer.id)
  assert.equal(await page.evaluate(() => history.length), entriesBefore, 'selection updates replace the entry instead of pushing')
  const link = page.url()
  const copied = await context.newPage()
  await copied.goto(link, { waitUntil: 'domcontentloaded' })
  await waitEditor(copied)
  await copied.waitForFunction(id => JSON.parse(document.querySelector('.canvas-hud-canvas')?.getAttribute('data-hud') ?? '{"selected":{}}').selected[id] !== undefined, frameLayer.id)
  assert.deepEqual(await hudSelected(copied), [frameLayer.id], 'a pasted link selects the node')
  assert.equal(await copied.getByRole('tree', { name: 'Layers' }).getByRole('treeitem').first().getAttribute('aria-selected'), 'true')
  await shot(copied, '04-node-link')
  await copied.close()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('nodeId'))
  assert.deepEqual(await hudSelected(page), [])
  await page.goto(`${editorUrl}file/${fileA}?pageId=${pageA}&nodeId=00000000-0000-4000-8000-000000000000`, { waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('nodeId'))
  assert.deepEqual(await hudSelected(page), [], 'an unknown node id is dropped and selects nothing')
  await page.goto(`${editorUrl}file/${fileA}?pageId=${pageA}&nodeId=${encodeURIComponent('bad id!')}`, { waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  assert.equal(nodeParam(page), null, 'a malformed node id is rejected by search validation')
  await page.goto(`${editorUrl}file/${fileA}?nodeId=${frameLayer.id}`, { waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  await page.waitForFunction(([pageId, id]) => new URL(location.href).searchParams.get('pageId') === pageId && new URL(location.href).searchParams.get('nodeId') === id, [pageA, frameLayer.id])
  await page.waitForFunction(id => JSON.parse(document.querySelector('.canvas-hud-canvas')?.getAttribute('data-hud') ?? '{"selected":{}}').selected[id] !== undefined, frameLayer.id)
  record('Selecting a node writes ?nodeId by replace; copied links, bare file links, and bad ids all resolve correctly', link)
  evidence.status = 'passed'
}

try { await run() }
catch (error) {
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error)
  if (activePage && !activePage.isClosed()) { try { await activePage.screenshot({ path: join(evidenceRoot, 'failure.png') }); evidence.screenshots.push('failure.png') } catch {} }
  console.error(evidence.error)
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(join(evidenceRoot, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, screenshots: evidence.screenshots }))
}
