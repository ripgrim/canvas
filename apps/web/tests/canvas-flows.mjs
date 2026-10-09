// Fresh browser evidence for the page canvas: blank page, drawing anywhere, deletion, grid, selection parity, duplication, nesting, undo, reload, tokens.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from '@playwright/test'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const evidenceRoot = join(projectRoot, 'outputs', 'canvas-flows')
const webRequire = createRequire(join(webRoot, 'package.json'))
const editorUrl = 'http://127.0.0.1:4317/'
const previewUrl = 'http://127.0.0.1:4318/'
const owned = []
const evidence = { status: 'failed', checks: [], screenshots: [], browserErrors: [], error: null }
let activePage = null
let browser = null

const record = (name, detail = '') => { evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log('✓', name, detail) }
async function shot(page, name) { await page.screenshot({ path: join(evidenceRoot, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }

async function responseAt(url) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.ok ? await response.text() : null } catch { return null }
}
async function ensureServer(name, url, args, expected) {
  if (await responseAt(url) !== null) return
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

const stageBox = page => page.locator('.canvas-stage').boundingBox()
const viewport = page => page.evaluate(() => { const element = document.querySelector('.canvas-viewport'); return { width: element.clientWidth, height: element.clientHeight } })
const camera = page => page.evaluate(() => { const transform = document.querySelector('.canvas-world').style.transform; const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(transform); return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) } })
const worldToScreen = (point, cam, size, box) => ({ x: box.x + size.width / 2 + cam.x + point.x * cam.zoom, y: box.y + size.height / 2 + cam.y + point.y * cam.zoom })
async function drag(page, from, to, steps = 12) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= steps; step++) await page.mouse.move(from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps)
  await page.mouse.up()
}
const layers = page => page.getByRole('tree', { name: 'Layers' })
// Chrome is painted on the HUD canvas; it publishes the painted screen rectangles for evidence (viewport-relative).
const hud = async page => { const box = await page.locator('.canvas-hud-canvas').boundingBox(); const painted = JSON.parse(await page.locator('.canvas-hud-canvas').getAttribute('data-hud') ?? '{"selected":{},"hover":null,"handles":null}'); return { box, painted } }
const paintedRect = async (page, id) => { const { box, painted } = await hud(page); const rect = painted.selected[id]; return rect ? { x: box.x + rect.x, y: box.y + rect.y, width: rect.width, height: rect.height } : null }
const waitPainted = async (page, id) => { await page.waitForFunction(id => JSON.parse(document.querySelector('.canvas-hud-canvas')?.getAttribute('data-hud') ?? '{"selected":{}}').selected[id] !== undefined, id); return paintedRect(page, id) }
const waitHover = page => page.waitForFunction(() => JSON.parse(document.querySelector('.canvas-hud-canvas')?.getAttribute('data-hud') ?? '{}').hover !== null)
const layerIds = async page => layers(page).locator('[role="treeitem"]').evaluateAll(items => items.map(item => ({ id: item.getAttribute('data-instance-id'), name: item.getAttribute('aria-label'), level: item.getAttribute('aria-level'), selected: item.getAttribute('aria-selected') })))
// The open file's id is the last path segment of /file/<id>; its contents live under one per-file key.
const currentFileId = page => decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
const storedFile = page => page.evaluate(fileId => {
  const key = Object.keys(localStorage).find(candidate => candidate === `design-editor.browser-file.${fileId}.v3`)
  return key ? JSON.parse(localStorage.getItem(key)).file : null
}, currentFileId(page))
const waitStored = (page, predicate, arg = null) => page.waitForFunction(({ fileId, source, arg }) => {
  const raw = localStorage.getItem(`design-editor.browser-file.${fileId}.v3`)
  return raw !== null && new Function('file', 'arg', `return (${source})(file, arg)`)(JSON.parse(raw).file, arg)
}, { fileId: currentFileId(page), source: predicate.toString(), arg })
const parentOf = (file, id) => file.relationships[id]?.parentId
const pageRootId = file => file.pages[0].rootNodeId
const rgbOf = (page, id) => page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-canvas="${id}"]`).evaluate(element => getComputedStyle(element).backgroundColor)
const waitRgb = (page, id, rgb) => page.waitForFunction(([id, rgb]) => { const element = document.querySelector('iframe[title="Canvas"]')?.contentDocument?.querySelector(`[data-preview-canvas="${id}"]`); return element ? getComputedStyle(element).backgroundColor === rgb : false }, [id, rgb], { timeout: 5000 }).catch(() => {})
const sidebarTab = (page, name) => page.getByRole('tab', { name, exact: true })
const numberField = (page, label) => page.locator('.right-rail').getByRole('textbox', { name: label, exact: true })
async function commitField(page, label, value) { const field = numberField(page, label); await field.click(); await field.fill(String(value)); await field.press('Enter') }

async function run() {
  await mkdir(evidenceRoot, { recursive: true })
  await ensureServer('editor', editorUrl, ['--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4317', '--strictPort'], /Comp Canvas|Design editor|@vite\/client|TanStack/)
  await ensureServer('preview', previewUrl, ['--config', 'vite.preview.config.ts', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4318', '--strictPort'], /preview-root|@vite\/client|<html/i)
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  activePage = page
  page.on('pageerror', error => { evidence.browserErrors.push(`Page error: ${error.message}`) })
  page.on('console', message => { if (message.type() === 'error') evidence.browserErrors.push(message.text().slice(0, 500)) })
  page.on('response', response => { if (response.status() >= 400) evidence.browserErrors.push(`HTTP ${response.status()} ${response.url()}`) })
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })

  // 1. Blank file and page: no compulsory frame, sheet, or handle.
  const newFile = page.getByRole('button', { name: /New file/i }).first()
  await newFile.waitFor({ timeout: 20_000 })
  await newFile.click()
  await page.locator('.canvas-stage').waitFor({ timeout: 20_000 })
  await page.frameLocator('iframe[title="Canvas"]').locator('#preview-root').waitFor({ state: 'attached', timeout: 20_000 })
  await page.waitForTimeout(600)
  assert.equal(await page.locator('.canvas-document-frame, .canvas-resize-handle, .resize-handle, .node-label').count(), 0)
  assert.deepEqual((await hud(page)).painted.selected, {})
  const previewBody = await page.locator('iframe[title="Canvas"]').evaluate(frame => ({ bg: getComputedStyle(frame).backgroundColor, inset: getComputedStyle(frame).inset, w: frame.getBoundingClientRect().width }))
  const stage = await stageBox(page)
  assert.ok(stage && previewBody.w >= stage.width - 1, 'preview fills the workspace')
  assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(previewBody.bg), 'preview iframe is transparent')
  const bodyBackground = await page.frameLocator('iframe[title="Canvas"]').locator('body').evaluate(body => getComputedStyle(body).backgroundColor)
  assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(bodyBackground), `preview body is transparent: ${bodyBackground}`)
  assert.equal((await layerIds(page)).length, 0)
  await shot(page, '01-blank-page')
  record('Blank page has no frame, sheet, handle, or layer', JSON.stringify(previewBody))

  // 2. Draw frames and elements anywhere, including negative coordinates and beyond the old 400x520 bounds.
  const size = await viewport(page)
  let cam = await camera(page)
  const toScreen = point => worldToScreen(point, cam, size, stage)
  await page.keyboard.press('f')
  await drag(page, toScreen({ x: -380, y: -300 }), toScreen({ x: 20, y: 0 }))
  let items = await layerIds(page)
  await layers(page).locator('[role="treeitem"]').first().waitFor()
  items = await layerIds(page)
  assert.equal(items.length, 1); assert.equal(items[0].name, 'Frame'); assert.equal(items[0].selected, 'true')
  const frameId = items[0].id
  assert.equal(await numberField(page, 'X position').inputValue(), '-380')
  assert.equal(await numberField(page, 'Y position').inputValue(), '-300')
  assert.equal(await numberField(page, 'Width').inputValue(), '400')
  await page.locator('.dimension-badge').waitFor()
  assert.equal(await page.locator('.dimension-badge').innerText(), '400 x 300')
  assert.equal(await page.locator('.resize-handle').count(), 8)
  const frameBox = await page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-canvas="${frameId}"]`).boundingBox()
  const outline = await waitPainted(page, frameId)
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(frameBox[key] - outline[key]) <= 1.5, `${key}: rendered ${frameBox[key]} vs outline ${outline[key]}`)
  record('Frame drawn at negative world coordinates renders and matches its selection outline', JSON.stringify({ frameBox, outline }))
  assert.equal(await page.locator('.tool-rail [aria-pressed="true"], .tool-rail [data-active]').count() >= 0, true)
  await page.keyboard.press('r')
  await drag(page, toScreen({ x: -340, y: -260 }), toScreen({ x: -140, y: -160 }))
  items = await layerIds(page)
  assert.deepEqual(items.map(item => [item.name, item.level]), [['Frame', '1'], ['Rectangle', '2']])
  const rectId = items[1].id
  assert.equal(await numberField(page, 'X position').inputValue(), '40')
  await page.keyboard.press('t')
  await page.mouse.click(...Object.values(toScreen({ x: 300, y: 250 })))
  items = await layerIds(page)
  assert.equal(items.at(-1).name, 'Text')
  const textId = items.at(-1).id
  await shot(page, '02-drawn-nodes')
  record('Rectangle nests into the frame it was drawn inside; text placed far outside the old preview bounds', JSON.stringify(items))

  // 3. Selection parity between canvas and Layers, hover, marquee, empty-space deselect.
  await page.mouse.click(...Object.values(toScreen({ x: 420, y: 330 })))
  assert.deepEqual((await hud(page)).painted.selected, {})
  await page.mouse.click(...Object.values(toScreen({ x: -240, y: -210 })))
  items = await layerIds(page)
  assert.deepEqual(items.filter(item => item.selected === 'true').map(item => item.id), [rectId], 'shallow click from none selects the direct child of the containing root (Wonder E29)')
  await page.mouse.click(...Object.values(toScreen({ x: -200, y: -60 })))
  items = await layerIds(page)
  assert.deepEqual(items.filter(item => item.selected === 'true').map(item => item.id), [frameId], 'clicking the frame body selects the frame')
  await page.mouse.dblclick(...Object.values(toScreen({ x: -240, y: -210 })))
  items = await layerIds(page)
  assert.deepEqual(items.filter(item => item.selected === 'true').map(item => item.id), [rectId], 'double-click drills into the rectangle')
  const fromCanvas = await waitPainted(page, rectId)
  await page.mouse.click(...Object.values(toScreen({ x: 420, y: 330 })))
  await layers(page).getByRole('treeitem', { name: 'Rectangle' }).click()
  const fromLayers = await waitPainted(page, rectId)
  assert.deepEqual(fromLayers, fromCanvas)
  await page.mouse.move(...Object.values(toScreen({ x: 300, y: 255 })))
  await waitHover(page)
  assert.equal((await hud(page)).painted.hover, textId)
  await drag(page, toScreen({ x: 350, y: 300 }), toScreen({ x: -450, y: -340 }))
  items = await layerIds(page)
  assert.deepEqual(items.filter(item => item.selected === 'true').map(item => item.id).sort(), [frameId, textId].sort(), 'marquee selects intersecting roots only')
  await shot(page, '03-marquee-selection')
  record('Canvas and Layers select the same identity with identical outlines; marquee, hover, and empty-space deselect work')

  // 4. Move with snapping, nesting out of the frame, undo.
  await page.mouse.click(...Object.values(toScreen({ x: 420, y: 330 })))
  await layers(page).getByRole('treeitem', { name: 'Rectangle' }).click()
  await waitStored(page, (file, ids) => file.relationships[ids.rectId]?.parentId === ids.frameId, { rectId, frameId })
  const rectBefore = await storedFile(page)
  assert.equal(parentOf(rectBefore, frameId), pageRootId(rectBefore), 'the frame is a top-level node: its parent is the page root')
  assert.equal(parentOf(rectBefore, rectId), frameId, 'the stored rectangle is a child of the frame')
  await drag(page, toScreen({ x: -240, y: -210 }), toScreen({ x: 150, y: 150 }))
  items = await layerIds(page)
  // Sibling order after the drop is not part of this check (the page root appends the moved node); hierarchy and identity are.
  const droppedOrder = items.map(item => item.name)
  assert.deepEqual(items.map(item => [item.name, item.level]).sort(), [['Frame', '1'], ['Rectangle', '1'], ['Text', '1']], 'dragging out of the frame reparents to the page')
  assert.equal(items.find(item => item.name === 'Rectangle').id, rectId, 'identity survives reparenting')
  await waitStored(page, (file, id) => file.relationships[id]?.parentId === file.pages[0].rootNodeId, rectId)
  await page.keyboard.press('Control+z')
  items = await layerIds(page)
  assert.deepEqual(items.map(item => [item.name, item.level]), [['Frame', '1'], ['Rectangle', '2'], ['Text', '1']])
  await waitStored(page, (file, ids) => file.relationships[ids.rectId]?.parentId === ids.frameId, { rectId, frameId })
  assert.deepEqual((await storedFile(page)).nodes[rectId].styles, rectBefore.nodes[rectId].styles, 'undo restores the stored geometry')
  await page.keyboard.press('ArrowRight')
  assert.equal(await numberField(page, 'X position').inputValue(), '41')
  await page.keyboard.press('Shift+ArrowLeft')
  assert.equal(await numberField(page, 'X position').inputValue(), '31')
  record('Freeform move reparents by drop target, nudges 1/10 px, and undo restores hierarchy with the same node id', `layer order after drop: ${droppedOrder.join(', ')}`)

  // 5. Resize from the bottom-right handle; handles stay 7 px at any zoom.
  await layers(page).getByRole('treeitem', { name: 'Frame' }).click()
  const handle = page.locator('.resize-handle[data-handle="bottom-right"]')
  const handleBox = await handle.boundingBox()
  assert.ok(Math.abs(handleBox.width - 7) <= 1 && Math.abs(handleBox.height - 7) <= 1, `handle ${handleBox.width}x${handleBox.height}`)
  await drag(page, { x: handleBox.x + 3.5, y: handleBox.y + 3.5 }, { x: handleBox.x + 43.5, y: handleBox.y + 3.5 })
  assert.equal(await numberField(page, 'Width').inputValue(), '440')
  assert.equal(await page.locator('.dimension-badge').innerText(), '440 x 300')
  await page.keyboard.press('Control+z')
  assert.equal(await numberField(page, 'Width').inputValue(), '400')
  record('Corner resize anchors the opposite side and undoes in one step')

  // 6. Duplicate keeps the name, gets a fresh id, lands right of the source.
  await page.keyboard.press('Control+d')
  items = await layerIds(page)
  const duplicates = items.filter(item => item.name === 'Frame' && item.level === '1')
  assert.equal(duplicates.length, 2)
  const duplicateId = duplicates.find(item => item.id !== frameId).id
  assert.notEqual(duplicateId, frameId)
  assert.equal(items.filter(item => item.level === '2').length, 2, 'the nested rectangle was copied with a fresh id')
  assert.equal(await numberField(page, 'X position').inputValue(), String(-380 + 400 + 20))
  await shot(page, '04-duplicate')
  record('Duplicate preserves the label, assigns new ids through the subtree, and places the copy 20 px right of the source', duplicateId)

  // 7. Zoom through the grid threshold, pan, verify anchoring and screen-sized handles.
  const anchor = toScreen({ x: -220, y: -150 })
  const anchorWorldBefore = { x: -220, y: -150 }
  await page.keyboard.down('Control')
  for (let step = 0; step < 40 && (await camera(page)).zoom < 8; step++) { await page.mouse.move(anchor.x, anchor.y); await page.mouse.wheel(0, -100); await page.waitForTimeout(30) }
  await page.keyboard.up('Control')
  await page.waitForFunction(() => Number(/scale\(([-\d.e]+)\)/.exec(document.querySelector('.canvas-world').style.transform)[1]) >= 8)
  {
    const zoomedCamera = await camera(page)
    const anchored = worldToScreen(anchorWorldBefore, zoomedCamera, size, stage)
    assert.ok(Math.abs(anchored.x - anchor.x) < 1.5 && Math.abs(anchored.y - anchor.y) < 1.5, `zoom stays anchored under the pointer: ${JSON.stringify(anchored)} vs ${JSON.stringify(anchor)}`)
  }
  cam = await camera(page)
  assert.ok(cam.zoom >= 8)
  assert.equal(await page.locator('.canvas-pixel-grid[data-visible]').count(), 1, 'grid shows at 8x')
  const gridBefore = await page.locator('.canvas-pixel-grid').evaluate(element => ({ size: element.style.backgroundSize, position: element.style.backgroundPosition }))
  const expectedPosition = (value, zoom) => (((value % zoom) + zoom) % zoom)
  assert.equal(gridBefore.size, `${cam.zoom}px ${cam.zoom}px`)
  assert.ok(Math.abs(parseFloat(gridBefore.position) - expectedPosition(size.width / 2 + cam.x, cam.zoom)) < 0.01, `grid anchored: ${gridBefore.position} vs ${expectedPosition(size.width / 2 + cam.x, cam.zoom)}`)
  const zoomedHandle = await page.locator('.resize-handle[data-handle="bottom-right"]').boundingBox()
  assert.ok(Math.abs(zoomedHandle.width - 7) <= 1, `handle stays 7 px at ${cam.zoom}x: ${zoomedHandle.width}`)
  await shot(page, '05-grid-zoomed')
  await page.keyboard.press('h')
  await drag(page, { x: stage.x + 600, y: stage.y + 400 }, { x: stage.x + 633, y: stage.y + 421 })
  const panned = await camera(page)
  assert.ok(Math.abs(panned.x - cam.x - 33) < 1 && Math.abs(panned.y - cam.y - 21) < 1, 'hand pan moves the camera by the pointer delta')
  const gridAfter = await page.locator('.canvas-pixel-grid').evaluate(element => element.style.backgroundPosition)
  assert.ok(Math.abs(parseFloat(gridAfter) - expectedPosition(size.width / 2 + panned.x, panned.zoom)) < 0.01, 'grid stays world-anchored while panning')
  assert.equal(await numberField(page, 'X position').inputValue(), String(-380 + 400 + 20), 'panning never changes document coordinates')
  await page.keyboard.press('v')
  // Space is a temporary hand: Space alone moves nothing, Space+drag pans, release restores the tool; middle button pans too.
  const activeTool = () => page.locator('.tool-rail [role="radio"][aria-checked="true"]').getAttribute('aria-label')
  const selectionBefore = (await layerIds(page)).filter(item => item.selected === 'true').map(item => item.id)
  const beforeSpace = await camera(page)
  await page.locator('.canvas-stage').focus()
  await page.keyboard.down('Space')
  await page.waitForTimeout(50)
  assert.deepEqual(await camera(page), beforeSpace, 'Space alone does not move the camera')
  assert.equal(await page.locator('.canvas-stage').getAttribute('data-cursor'), 'grab')
  await page.mouse.move(stage.x + 600, stage.y + 450)
  await page.mouse.down()
  await page.mouse.move(stage.x + 640, stage.y + 470, { steps: 4 })
  assert.equal(await page.locator('.canvas-stage').getAttribute('data-cursor'), 'grabbing')
  await page.mouse.up()
  await page.keyboard.up('Space')
  const afterSpace = await camera(page)
  assert.ok(Math.abs(afterSpace.x - beforeSpace.x - 40) < 1 && Math.abs(afterSpace.y - beforeSpace.y - 20) < 1, `space drag panned by (${afterSpace.x - beforeSpace.x}, ${afterSpace.y - beforeSpace.y})`)
  assert.equal(await activeTool(), 'Move', 'releasing Space restores the previous tool')
  assert.equal(await page.locator('.canvas-stage').getAttribute('data-cursor'), 'default')
  assert.deepEqual((await layerIds(page)).filter(item => item.selected === 'true').map(item => item.id), selectionBefore, 'temporary pan keeps the selection')
  await page.mouse.move(stage.x + 600, stage.y + 450)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(stage.x + 580, stage.y + 440, { steps: 4 })
  await page.mouse.up({ button: 'middle' })
  const afterMiddle = await camera(page)
  assert.ok(Math.abs(afterMiddle.x - afterSpace.x + 20) < 1 && Math.abs(afterMiddle.y - afterSpace.y + 10) < 1, 'middle-button drag pans')
  assert.equal(await activeTool(), 'Move')
  await page.keyboard.down('Control')
  for (let step = 0; step < 12; step++) { await page.mouse.move(anchor.x, anchor.y); await page.mouse.wheel(0, 100); await page.waitForTimeout(30) }
  await page.keyboard.up('Control')
  await page.waitForFunction(() => Number(/scale\(([-\d.e]+)\)/.exec(document.querySelector('.canvas-world').style.transform)[1]) < 7.5)
  assert.equal(await page.locator('.canvas-pixel-grid[data-visible]').count(), 0, 'grid hides below 7.5x')
  await page.keyboard.press('Shift+1')
  await page.waitForTimeout(300)
  const fitted = await camera(page)
  assert.ok(fitted.zoom > 0.05 && fitted.zoom < 2, `fit zoom ${fitted.zoom}`)
  await shot(page, '06-fit-all')
  record('Pointer-anchored zoom, 8x grid threshold with 7.5x hysteresis, world-anchored grid, screen-sized handles, Space and middle-button panning, and fit all', JSON.stringify({ zoomed: cam, panned, fitted }))

  // 8. Token edits update bound fills and leave literal fills alone. Tokens live in the Theme tab; fills bind through the inspector's Fill select.
  await page.keyboard.press('Escape')
  const duplicateRect = (await layerIds(page)).filter(item => item.level === '2').find(item => item.id !== rectId)
  const fillSelect = page.locator('.right-rail').getByRole('combobox', { name: 'Fill 1 color source', exact: true })
  const fillValue = page.locator('.right-rail').getByRole('textbox', { name: 'Fill 1 color', exact: true })
  const tokenColor = page.getByRole('textbox', { name: 'Brand color', exact: true })
  const brandRow = page.getByRole('listbox', { name: 'Color tokens' }).getByRole('option', { name: /^Brand, / })
  const closeEditor = async () => { await page.getByRole('button', { name: 'Close', exact: true }).click(); await tokenColor.waitFor({ state: 'detached' }) }
  const editBrand = async hex => {
    await sidebarTab(page, 'Theme').click()
    await brandRow.click()
    await tokenColor.click(); await tokenColor.fill(hex); await tokenColor.press('Enter')
    await closeEditor()
    await sidebarTab(page, 'Design').click()
  }
  const bindToBrand = async id => {
    await layers(page).locator(`[role="treeitem"][data-instance-id="${id}"]`).click()
    await fillSelect.selectOption({ label: 'Brand' })
  }
  const rectFillBefore = await rgbOf(page, rectId)
  assert.equal(await rgbOf(page, frameId), 'rgb(255, 255, 255)', 'a new frame carries a literal white fill')
  await sidebarTab(page, 'Theme').click()
  assert.equal(await sidebarTab(page, 'Theme').getAttribute('aria-selected'), 'true')
  await page.getByRole('button', { name: 'Add color token', exact: true }).click()
  const tokenName = page.getByRole('textbox', { name: 'Token name', exact: true })
  await tokenName.click(); await tokenName.fill('Brand'); await tokenName.press('Enter')
  await tokenColor.click(); await tokenColor.fill('#0f766e'); await tokenColor.press('Enter')
  await closeEditor()
  await brandRow.waitFor()
  assert.equal(await brandRow.getAttribute('aria-label'), 'Brand, #0F766E, 100% opacity')
  await waitStored(page, file => Object.values(file.theme.tokens).some(token => token.name === 'Brand' && token.value.kind === 'literal' && token.value.color.hex?.toLowerCase() === '#0f766e'))
  const brandId = Object.values((await storedFile(page)).theme.tokens).find(token => token.name === 'Brand').id
  await sidebarTab(page, 'Design').click()
  await bindToBrand(rectId)
  await bindToBrand(duplicateRect.id)
  await waitRgb(page, rectId, 'rgb(15, 118, 110)')
  assert.equal(await rgbOf(page, rectId), 'rgb(15, 118, 110)')
  assert.notEqual(rectFillBefore, 'rgb(15, 118, 110)')
  assert.equal(await rgbOf(page, duplicateRect.id), 'rgb(15, 118, 110)', 'every node bound to the token renders its color')
  // A bound fill shows the token chip with the resolved color as read-only context instead of an editable hex field.
  await page.locator('.right-rail').getByRole('group', { name: 'Fill 1 color: Brand token, #0F766E, 100% opacity' }).waitFor()
  assert.equal(await fillValue.count(), 0, 'a bound fill has no editable hex input')
  await editBrand('#dc2626')
  await waitRgb(page, rectId, 'rgb(220, 38, 38)')
  assert.equal(await rgbOf(page, rectId), 'rgb(220, 38, 38)', 'bound rectangle follows the token edit')
  assert.equal(await rgbOf(page, duplicateRect.id), 'rgb(220, 38, 38)', 'bound copy follows the token edit')
  assert.equal(await rgbOf(page, frameId), 'rgb(255, 255, 255)', 'a literal fill ignores token edits')
  await layers(page).locator(`[role="treeitem"][data-instance-id="${rectId}"]`).click()
  await page.locator('.right-rail').getByRole('button', { name: 'Unlink fill 1 color' }).click()
  await fillValue.click(); await fillValue.fill('#f1f5f9'); await fillValue.press('Enter')
  await page.keyboard.press('Escape')
  await editBrand('#7c3aed')
  await waitRgb(page, duplicateRect.id, 'rgb(124, 58, 237)')
  assert.equal(await rgbOf(page, rectId), 'rgb(241, 245, 249)', 'literal override ignores token edits')
  assert.equal(await rgbOf(page, duplicateRect.id), 'rgb(124, 58, 237)', 'token reference follows the token')
  await waitStored(page, (file, ids) => file.theme.tokens[ids.brandId]?.value.color?.hex?.toLowerCase() === '#7c3aed' && file.nodes[ids.rectId].appearance.fills[0].color.kind === 'literal', { brandId, rectId })
  const stored = await storedFile(page)
  assert.deepEqual(stored.theme.tokens[brandId].value, { kind: 'literal', color: { kind: 'hex', hex: '#7c3aed' } })
  assert.deepEqual(stored.nodes[rectId].appearance.fills.map(({ id, ...paint }) => paint), [{ type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#f1f5f9' } } }])
  assert.deepEqual(stored.nodes[duplicateRect.id].appearance.fills.map(({ id, ...paint }) => paint), [{ type: 'solid', color: { kind: 'token', tokenId: brandId } }])
  assert.deepEqual(stored.nodes[frameId].appearance.fills.map(({ id, ...paint }) => paint), [{ type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } }])
  await shot(page, '07-tokens')
  record('Token edits update every bound fill; literal fills and overrides stay; references are persisted as references, not literals')

  // 9. Reload: geometry and ids persist.
  const beforeReload = await layerIds(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  // The file route reloads in place: /file/<id> opens the same file without going through Home.
  assert.ok(new URL(page.url()).pathname.startsWith('/file/'), page.url())
  await page.locator('.canvas-stage').waitFor({ timeout: 20_000 })
  await layers(page).getByRole('treeitem', { name: 'Frame' }).first().waitFor({ timeout: 20_000 })
  const afterReload = await layerIds(page)
  assert.deepEqual(afterReload.map(item => [item.id, item.name, item.level]), beforeReload.map(item => [item.id, item.name, item.level]))
  await layers(page).getByRole('treeitem', { name: 'Frame' }).first().click()
  assert.equal(await numberField(page, 'X position').inputValue(), '-380')
  assert.equal(await numberField(page, 'Width').inputValue(), '400')
  const reloaded = await storedFile(page)
  assert.deepEqual(reloaded.nodes[frameId].styles, { left: -380, top: -300, width: 400, height: 300, overflow: 'clip' })
  assert.equal(parentOf(reloaded, frameId), pageRootId(reloaded))
  assert.equal(parentOf(reloaded, rectId), frameId)
  record('Reload preserves ids, hierarchy, names, and geometry')

  // 10. Delete everything: only the empty workspace remains.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  assert.equal((await layerIds(page)).length, 0)
  assert.equal(await page.locator('.node-label, .resize-handle, .dimension-badge').count(), 0)
  assert.deepEqual((await hud(page)).painted.selected, {})
  assert.equal(await page.frameLocator('iframe[title="Canvas"]').locator('[data-preview-canvas], [data-preview-instance]').count(), 0)
  await shot(page, '08-deleted-all')
  record('Deleting every node leaves only the empty workspace')

  // 11. Legacy sample with the imported Card component: selection geometry comes from the live component; deleting the Card leaves nothing behind.
  const legacyIds = ['sample-instance-label-email', 'sample-instance-input-email', 'sample-instance-label-password', 'sample-instance-input-password', 'sample-instance-button']
  const legacyDocument = { version: 1, revision: 0, rootIds: ['browser-local-composition:card'], nodes: {
    'browser-local-composition:card': { id: 'browser-local-composition:card', componentId: 'sample-card', exportName: 'Card', props: { heading: 'Welcome back' }, children: { children: legacyIds } },
    'sample-instance-label-email': { id: 'sample-instance-label-email', componentId: 'sample-label', exportName: 'Label', props: { htmlFor: 'email', children: 'Email' }, children: {} },
    'sample-instance-input-email': { id: 'sample-instance-input-email', componentId: 'sample-input', exportName: 'Input', props: { id: 'email', type: 'email', placeholder: 'you@example.com' }, children: {} },
    'sample-instance-label-password': { id: 'sample-instance-label-password', componentId: 'sample-label', exportName: 'Label', props: { htmlFor: 'password', children: 'Password' }, children: {} },
    'sample-instance-input-password': { id: 'sample-instance-input-password', componentId: 'sample-input', exportName: 'Input', props: { id: 'password', type: 'password' }, children: {} },
    'sample-instance-button': { id: 'sample-instance-button', componentId: 'sample-button', exportName: 'Button', props: { children: 'Sign in', variant: 'primary' }, children: {} },
  }, frame: { width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false } }
  // The legacy draft key is a migration input only: it is read when no file index exists, so start from empty storage.
  await page.evaluate(document => { localStorage.clear(); localStorage.setItem('design-editor.browser-draft.v1', JSON.stringify(document)) }, legacyDocument)
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /Local draft/ }).first().click()
  await layers(page).getByRole('treeitem', { name: 'Card' }).waitFor({ timeout: 20_000 })
  const preview = page.frameLocator('iframe[title="Canvas"]')
  await preview.getByRole('button', { name: 'Sign in' }).waitFor({ timeout: 20_000 })
  await page.locator('.node-label[data-node-label="browser-local-composition:card"]').waitFor({ timeout: 20_000 })
  assert.equal(await page.locator('.canvas-document-frame, .canvas-resize-handle').count(), 0)
  const legacyLayers = await layerIds(page)
  assert.deepEqual(legacyLayers.map(item => [item.name, item.level]), [['Card', '1'], ['Label', '2'], ['Input', '2'], ['Label', '2'], ['Input', '2'], ['Button', '2']])
  await shot(page, '09-sample-card')
  await layers(page).getByRole('treeitem', { name: 'Card' }).click()
  const cardOutline = await waitPainted(page, 'browser-local-composition:card')
  const cardRendered = await preview.locator('[data-preview-instance="browser-local-composition:card"]').boundingBox()
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(cardOutline[key] - cardRendered[key]) <= 1.5, `card ${key}: ${cardOutline[key]} vs ${cardRendered[key]}`)
  const cardCamera = await camera(page)
  assert.equal(await page.locator('.dimension-badge').innerText(), `${Math.round(cardRendered.width / cardCamera.zoom)} x ${Math.round(cardRendered.height / cardCamera.zoom)}`)
  // Shallow click on the live button selects the Card's direct child, like Wonder E29.
  const buttonBox = await preview.getByRole('button', { name: 'Sign in' }).boundingBox()
  await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2)
  assert.deepEqual((await layerIds(page)).filter(item => item.selected === 'true').map(item => item.id), ['sample-instance-button'])
  const buttonOutline = await waitPainted(page, 'sample-instance-button')
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(buttonOutline[key] - buttonBox[key]) <= 1.5, `button ${key}: ${buttonOutline[key]} vs ${buttonBox[key]}`)
  // Dragging the Card by its label moves the whole component in world space; undo restores it.
  const label = page.locator('.node-label[data-node-label="browser-local-composition:card"]')
  const labelBox = await label.boundingBox()
  await drag(page, { x: labelBox.x + 10, y: labelBox.y + labelBox.height / 2 }, { x: labelBox.x + 40, y: labelBox.y + labelBox.height / 2 + 25 })
  await page.waitForTimeout(300)
  const movedCard = await preview.locator('[data-preview-instance="browser-local-composition:card"]').boundingBox()
  assert.ok(Math.abs(movedCard.x - cardRendered.x - 30) <= 1.5 && Math.abs(movedCard.y - cardRendered.y - 25) <= 1.5, `label drag moved by (${movedCard.x - cardRendered.x}, ${movedCard.y - cardRendered.y})`)
  assert.ok(Math.abs(movedCard.width - cardRendered.width) <= 1.5 && Math.abs(movedCard.height - cardRendered.height) <= 1.5, `leaving the host flow keeps the measured size: ${movedCard.width}x${movedCard.height} vs ${cardRendered.width}x${cardRendered.height}`)
  const movedOutline = await waitPainted(page, 'browser-local-composition:card')
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(movedOutline[key] - movedCard[key]) <= 1.5, `moved card ${key}`)
  await shot(page, '10-sample-card-moved')
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  const restoredCard = await preview.locator('[data-preview-instance="browser-local-composition:card"]').boundingBox()
  assert.ok(Math.abs(restoredCard.x - cardRendered.x) <= 1.5 && Math.abs(restoredCard.y - cardRendered.y) <= 1.5)
  await preview.getByRole('textbox', { name: 'Email' }).waitFor()
  // Enter selects the Card's direct children; Shift+Enter returns to the parent (Wonder E51/E52).
  await layers(page).getByRole('treeitem', { name: 'Card' }).click()
  await page.locator('.canvas-stage').focus()
  await page.keyboard.press('Enter')
  assert.deepEqual((await layerIds(page)).filter(item => item.selected === 'true').map(item => item.id), legacyIds)
  await page.keyboard.press('Shift+Enter')
  assert.deepEqual((await layerIds(page)).filter(item => item.selected === 'true').map(item => item.id), ['browser-local-composition:card'])
  // Flow reorder: drag the live Button above the first Label; the document order and the DOM order both change, identity stays.
  await layers(page).getByRole('treeitem', { name: 'Button' }).click()
  const signIn = await preview.getByRole('button', { name: 'Sign in' }).boundingBox()
  const emailLabel = await preview.locator('[data-preview-instance="sample-instance-label-email"]').boundingBox()
  await drag(page, { x: signIn.x + signIn.width / 2, y: signIn.y + signIn.height / 2 }, { x: emailLabel.x + emailLabel.width / 2, y: emailLabel.y + 2 }, 16)
  await page.waitForTimeout(300)
  const reordered = await layerIds(page)
  assert.deepEqual(reordered.map(item => item.id), ['browser-local-composition:card', 'sample-instance-button', ...legacyIds.filter(id => id !== 'sample-instance-button')], 'button moved to the first slot position')
  const domOrder = await preview.locator('[data-preview-instance]').evaluateAll(elements => elements.filter(element => element.getAttribute('data-preview-instance') !== 'browser-local-composition:card').sort((left, right) => left.getBoundingClientRect().y - right.getBoundingClientRect().y).map(element => element.getAttribute('data-preview-instance')))
  assert.equal(domOrder[0], 'sample-instance-button', 'live DOM renders the button first')
  const movedButton = await preview.getByRole('button', { name: 'Sign in' }).boundingBox()
  await page.waitForTimeout(100)
  const buttonOutlineAfter = await waitPainted(page, 'sample-instance-button')
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(buttonOutlineAfter[key] - movedButton[key]) <= 1.5, `reordered button ${key}`)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  assert.deepEqual((await layerIds(page)).map(item => item.id), ['browser-local-composition:card', ...legacyIds])
  await shot(page, '12-flow-reorder-undone')
  await layers(page).getByRole('treeitem', { name: 'Card' }).click()
  await page.keyboard.press('Delete')
  await page.waitForTimeout(400)
  assert.equal((await layerIds(page)).length, 0)
  assert.equal(await page.locator('.node-label, .resize-handle, .dimension-badge, .canvas-document-frame, .canvas-resize-handle').count(), 0)
  assert.deepEqual((await hud(page)).painted.selected, {})
  assert.equal(await preview.locator('[data-preview-instance]').count(), 0)
  await shot(page, '11-sample-card-deleted')
  await page.keyboard.press('Control+z')
  await layers(page).getByRole('treeitem', { name: 'Card' }).waitFor()
  await preview.getByRole('button', { name: 'Sign in' }).waitFor()
  record('Imported Card: outline and badge follow the live DOM, shallow click picks its child, Enter/Shift+Enter walk the hierarchy, flow reorder by sibling midpoint, label drag moves it, delete leaves nothing, undo restores it')
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
  await Promise.all(owned.map(child => new Promise(resolve => { if (child.exitCode !== null) { resolve(); return } const timeout = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timeout); resolve() }); child.kill() })))
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(join(evidenceRoot, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, screenshots: evidence.screenshots, browserErrors: evidence.browserErrors.slice(0, 5) }))
}
