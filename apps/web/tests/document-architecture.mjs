// Local-first document architecture: blank files, stable ids, hierarchy, world-pose reparenting, file-scoped tokens,
// gradients, component insertion, legacy migration, and stale-tab protection. Fresh browser evidence against the dev servers.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const evidenceRoot = join(projectRoot, 'outputs', 'document-architecture')
const editorUrl = 'http://127.0.0.1:4317/'
const legacyKey = 'design-editor.browser-files.v1'
const indexKey = 'design-editor.browser-files-index.v3'
const contentKey = fileId => `design-editor.browser-file.${fileId}.v3`
const evidence = { status: 'failed', checks: [], screenshots: [], error: null }
let browser = null
let activePage = null
const record = (name, detail = '') => { evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log('✓', name, detail) }
const shot = async (page, name) => { await page.screenshot({ path: join(evidenceRoot, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }
const fileIdOf = page => new URL(page.url()).pathname.split('/').pop()
const pageIdOf = page => new URL(page.url()).searchParams.get('pageId')
const stored = (page, fileId) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), contentKey(fileId))
const layers = page => page.getByRole('tree', { name: 'Layers' }).locator('[role="treeitem"]').evaluateAll(items => items.map(item => ({ id: item.getAttribute('data-instance-id'), name: item.getAttribute('aria-label'), level: Number(item.getAttribute('aria-level')) })))
const hud = async page => JSON.parse(await page.locator('.canvas-hud-canvas').getAttribute('data-hud') ?? '{"selected":{}}')
const preview = page => page.frameLocator('iframe[title="Canvas"]')
const previewElements = page => preview(page).locator('[data-preview-canvas]').evaluateAll(items => items.map(item => ({ id: item.getAttribute('data-preview-canvas'), kind: item.getAttribute('data-preview-kind'), background: getComputedStyle(item).backgroundColor, image: getComputedStyle(item).backgroundImage, parent: item.parentElement?.getAttribute('data-preview-canvas') ?? null })))
const waitEditor = async page => { await page.locator('.canvas-stage').waitFor({ timeout: 20_000 }); await page.locator('iframe[title="Canvas"]').waitFor(); await page.waitForTimeout(400) }
const waitRevision = (page, fileId, atLeast) => page.waitForFunction(([key, atLeast]) => (JSON.parse(localStorage.getItem(key) ?? 'null')?.file.revision ?? -1) >= atLeast, [contentKey(fileId), atLeast])
async function draw(page, tool, from, to) {
  const stage = await page.locator('.canvas-stage').boundingBox()
  await page.keyboard.press(tool)
  await page.mouse.move(stage.x + from.x, stage.y + from.y); await page.mouse.down(); await page.mouse.move(stage.x + to.x, stage.y + to.y, { steps: 8 }); await page.mouse.up()
  await page.waitForTimeout(250)
  const items = await layers(page)
  return items
}
async function dragBy(page, screenFrom, delta) {
  const stage = await page.locator('.canvas-stage').boundingBox()
  await page.keyboard.press('v')
  await page.mouse.move(stage.x + screenFrom.x, stage.y + screenFrom.y); await page.mouse.down()
  await page.mouse.move(stage.x + screenFrom.x + delta.x / 2, stage.y + screenFrom.y + delta.y / 2, { steps: 6 })
  await page.mouse.move(stage.x + screenFrom.x + delta.x, stage.y + screenFrom.y + delta.y, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(300)
}
const paintedRect = async (page, id) => { const box = await page.locator('.canvas-hud-canvas').boundingBox(); const painted = (await hud(page)).selected[id]; return painted ? { x: Math.round(box.x + painted.x), y: Math.round(box.y + painted.y), width: Math.round(painted.width), height: Math.round(painted.height) } : null }
async function openThemeTab(page) { await page.getByRole('tab', { name: 'Theme' }).click(); await page.getByRole('button', { name: 'Add color token' }).or(page.getByRole('button', { name: 'Create color token' })).first().waitFor() }
async function openDesignTab(page) { await page.getByRole('tab', { name: 'Design' }).click(); await page.getByRole('tree', { name: 'Layers' }).waitFor() }
async function createToken(page, name, hex) {
  await openThemeTab(page)
  const add = page.getByRole('button', { name: 'Add color token' })
  if (await add.count()) await add.click(); else await page.getByRole('button', { name: 'Create color token' }).click()
  const nameField = page.getByRole('textbox', { name: 'Token name' })
  await nameField.waitFor()
  await nameField.fill(name); await nameField.press('Enter')
  const color = page.getByRole('textbox', { name: `${name} color`, exact: true })
  await color.waitFor()
  await color.fill(hex); await color.press('Enter')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
}
async function bindFill(page, nodeId, tokenName) {
  await openDesignTab(page)
  await page.getByRole('tree', { name: 'Layers' }).locator(`[data-instance-id="${nodeId}"]`).click()
  const select = page.locator('.right-rail').getByRole('combobox', { name: 'Fill 1 color source', exact: true })
  await select.waitFor()
  await select.selectOption({ label: tokenName })
  await page.waitForTimeout(250)
}
const legacyPage = (id, name, tokens, elements) => ({ id, name, document: { version: 1, revision: 3, rootIds: [], nodes: {}, frame: { name, width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false }, canvas: { elements }, ...(tokens ? { tokens } : {}) } })

async function run() {
  await mkdir(evidenceRoot, { recursive: true })
  assert.ok(await fetch(editorUrl).then(response => response.ok).catch(() => false), 'editor dev server must be running on 4317')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  activePage = page
  page.on('pageerror', error => { evidence.error = `Page error: ${error.message}` })
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })

  // 1. A new file is blank: one page, one structural root, no visible frame, no demo content, no tokens.
  await page.getByRole('button', { name: /New file/i }).first().click()
  await waitEditor(page)
  const fileA = fileIdOf(page)
  const pageA1 = pageIdOf(page)
  const blank = await stored(page, fileA)
  assert.equal(blank.file.schemaVersion, 7)
  assert.deepEqual(blank.file.pages.map(item => item.id), [pageA1])
  assert.deepEqual(Object.values(blank.file.nodes).map(node => node.type), ['root'])
  assert.deepEqual(blank.file.relationships, {})
  assert.deepEqual(blank.file.theme, { tokens: {} })
  assert.deepEqual(await layers(page), [])
  assert.equal(await preview(page).locator('[data-preview-canvas], [data-preview-instance]').count(), 0, 'no demo content and no implicit frame in the preview')
  assert.deepEqual((await hud(page)).selected, {})
  const index = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), indexKey)
  assert.deepEqual(Object.keys(index.files), [fileA])
  assert.deepEqual(Object.keys(index.files[fileA]).sort(), ['createdAt', 'id', 'name', 'updatedAt'], 'the index carries no contents')
  await shot(page, '01-blank-file')
  record('New file is blank: structural root only, no visible frame, no demo content, empty theme; index separate from contents', fileA)

  // 2. Draw a frame and a rectangle outside it; then nest the rectangle by dragging it into the frame (world pose preserved).
  const [frame] = await draw(page, 'f', { x: 420, y: 160 }, { x: 760, y: 440 })
  const afterRect = await draw(page, 'r', { x: 860, y: 200 }, { x: 980, y: 280 })
  const rect = afterRect.find(item => item.name === 'Rectangle')
  assert.equal(afterRect.length, 2)
  assert.equal(rect.level, 1, 'rectangle starts at the page root')
  let file = (await stored(page, fileA)).file
  const frameWorld = { x: file.nodes[frame.id].styles.left, y: file.nodes[frame.id].styles.top }
  const rectWorldBefore = { x: file.nodes[rect.id].styles.left, y: file.nodes[rect.id].styles.top }
  assert.equal(file.relationships[rect.id].parentId, file.pages[0].rootNodeId)
  await page.getByRole('tree', { name: 'Layers' }).locator(`[data-instance-id="${rect.id}"]`).click()
  const before = await paintedRect(page, rect.id)
  // Drag so the rectangle's top-left lands 60,70 inside the frame: delta = frameWorld + (60,70) - rectWorld (zoom is 1 at this point).
  const zoom = Number((await page.locator('.zoom-controls button').nth(1).innerText()).replace('%', '')) / 100
  const delta = { x: (frameWorld.x + 60 - rectWorldBefore.x) * zoom, y: (frameWorld.y + 70 - rectWorldBefore.y) * zoom }
  await dragBy(page, { x: before.x - (await page.locator('.canvas-stage').boundingBox()).x + before.width / 2, y: before.y - (await page.locator('.canvas-stage').boundingBox()).y + before.height / 2 }, delta)
  await waitRevision(page, fileA, file.revision + 1)
  file = (await stored(page, fileA)).file
  assert.equal(file.relationships[rect.id].parentId, frame.id, 'rectangle reparented into the frame')
  assert.deepEqual({ left: file.nodes[rect.id].styles.left, top: file.nodes[rect.id].styles.top }, { left: 60, top: 70 }, 'parent-local = world - parent world')
  const nested = await layers(page)
  assert.deepEqual(nested.map(item => [item.name, item.level]), [['Frame', 1], ['Rectangle', 2]])
  const previewAfter = await previewElements(page)
  assert.equal(previewAfter.find(item => item.id === rect.id).parent, frame.id, 'preview DOM nests the rectangle under the frame')
  const after = await paintedRect(page, rect.id)
  assert.ok(Math.abs(after.x - (before.x + delta.x)) <= 1 && Math.abs(after.y - (before.y + delta.y)) <= 1, `HUD rectangle followed the pointer: ${JSON.stringify({ before, after, delta })}`)
  await shot(page, '02-nested')
  record('Dragging a rectangle into a frame reparents it with parent-local coordinates and the same world pose', `${rect.id} -> ${frame.id} at 60,70`)

  // 3. Ids survive rename, duplicate, undo, and reload; the layer tree agrees with the stored hierarchy.
  const nameField = page.locator('.right-rail').getByRole('textbox', { name: 'Name', exact: true })
  await nameField.fill('Accent'); await nameField.press('Enter')
  await waitRevision(page, fileA, file.revision + 1)
  file = (await stored(page, fileA)).file
  assert.equal(file.nodes[rect.id].name, 'Accent')
  await page.keyboard.press('Control+d')
  await waitRevision(page, fileA, file.revision + 1)
  file = (await stored(page, fileA)).file
  const copyId = Object.keys(file.nodes).find(id => id !== rect.id && file.nodes[id].type === 'rectangle')
  assert.ok(copyId && file.nodes[rect.id], 'duplicate has a new id and the source keeps its id')
  assert.equal(file.relationships[copyId].parentId, frame.id)
  assert.equal(file.nodes[copyId].styles.left, 60 + file.nodes[rect.id].styles.width + 20, 'duplicate sits one gap to the right of its source')
  await page.keyboard.press('Control+z')
  await waitRevision(page, fileA, file.revision + 1)
  file = (await stored(page, fileA)).file
  assert.equal(file.nodes[copyId], undefined, 'undo removed the duplicate')
  assert.equal(file.nodes[rect.id].name, 'Accent')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  assert.equal(fileIdOf(page), fileA); assert.equal(pageIdOf(page), pageA1)
  assert.deepEqual((await layers(page)).map(item => item.id), [frame.id, rect.id])
  await page.getByRole('tree', { name: 'Layers' }).locator(`[data-instance-id="${rect.id}"]`).click()
  await page.keyboard.press('Delete')
  await waitRevision(page, fileA, file.revision + 1)
  assert.deepEqual((await layers(page)).map(item => item.id), [frame.id])
  await page.keyboard.press('Control+z')
  await waitRevision(page, fileA, file.revision + 2)
  file = (await stored(page, fileA)).file
  assert.deepEqual((await layers(page)).map(item => item.id), [frame.id, rect.id], 'undo restores the node with the same id')
  assert.equal(file.relationships[rect.id].parentId, frame.id, 'and the same parent')
  record('File, page, and node ids survive rename, duplicate, undo, delete, restore, and reload')

  // 4. Tokens are file-scoped: created in the Theme tab, bound on two pages, edited once, inlined on delete, restored by undo.
  await createToken(page, 'brand', '#ff0000')
  file = (await stored(page, fileA)).file
  const tokenId = Object.keys(file.theme.tokens)[0]
  assert.equal(file.theme.tokens[tokenId].name, 'brand')
  await bindFill(page, rect.id, 'brand')
  await waitRevision(page, fileA, file.revision + 1)
  file = (await stored(page, fileA)).file
  assert.deepEqual(file.nodes[rect.id].appearance.fills[0].color, { kind: 'token', tokenId })
  assert.equal((await previewElements(page)).find(item => item.id === rect.id).background, 'rgb(255, 0, 0)')
  await page.getByRole('button', { name: 'Add page' }).click()
  await page.waitForFunction(id => new URL(location.href).searchParams.get('pageId') !== id, pageA1)
  const pageA2 = pageIdOf(page)
  await waitEditor(page)
  assert.deepEqual(await layers(page), [], 'the new page is empty')
  await openThemeTab(page)
  assert.match(await page.locator('.left-rail').innerText(), /1 token/, 'the second page sees the same single file token')
  const [rect2] = await (async () => { await openDesignTab(page); return draw(page, 'r', { x: 500, y: 300 }, { x: 640, y: 380 }) })()
  await bindFill(page, rect2.id, 'brand')
  await waitRevision(page, fileA, (await stored(page, fileA)).file.revision)
  await openThemeTab(page)
  await page.getByRole('option', { name: /^brand,/ }).click()
  const brandColor = page.getByRole('textbox', { name: 'brand color', exact: true })
  await brandColor.waitFor(); await brandColor.fill('#00ff00'); await brandColor.press('Enter')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.waitForFunction(([key, id]) => JSON.parse(localStorage.getItem(key)).file.theme.tokens[id].value.color.hex === '#00ff00', [contentKey(fileA), tokenId])
  assert.equal((await previewElements(page)).find(item => item.id === rect2.id).background, 'rgb(0, 255, 0)', 'page 2 follows the token')
  await page.goto(`${editorUrl}file/${fileA}?pageId=${pageA1}`, { waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  await preview(page).locator('[data-preview-canvas="' + rect.id + '"]').waitFor({ timeout: 20_000 })
  assert.equal((await previewElements(page)).find(item => item.id === rect.id).background, 'rgb(0, 255, 0)', 'page 1 follows the same token')
  await shot(page, '03-shared-token')
  await openThemeTab(page)
  await page.getByRole('option', { name: /^brand,/ }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const confirm = page.getByRole('button', { name: /Delete and keep colors on 2 references/ })
  await confirm.waitFor()
  await confirm.click()
  await page.waitForFunction(([key, id]) => !JSON.parse(localStorage.getItem(key)).file.theme.tokens[id], [contentKey(fileA), tokenId])
  file = (await stored(page, fileA)).file
  assert.deepEqual(file.nodes[rect.id].appearance.fills[0].color, { kind: 'literal', color: { kind: 'hex', hex: '#00ff00' } }, 'delete inlined the resolved color on page 1')
  assert.deepEqual(file.nodes[rect2.id].appearance.fills[0].color, { kind: 'literal', color: { kind: 'hex', hex: '#00ff00' } }, 'and on page 2, atomically')
  await openDesignTab(page)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+z')
  await page.waitForFunction(([key, id]) => Boolean(JSON.parse(localStorage.getItem(key)).file.theme.tokens[id]), [contentKey(fileA), tokenId])
  file = (await stored(page, fileA)).file
  assert.deepEqual(file.nodes[rect.id].appearance.fills[0].color, { kind: 'token', tokenId }, 'undo restores the token and both references')
  assert.deepEqual(file.nodes[rect2.id].appearance.fills[0].color, { kind: 'token', tokenId })
  record('Tokens are file-scoped: one token binds nodes on two pages, edits propagate, delete inlines resolved colors everywhere in one step, undo restores token and bindings', tokenId)

  // 5. Gradient stops use the same literal/token model and persist.
  const [shader] = await (async () => { const items = await draw(page, 's', { x: 900, y: 500 }, { x: 1100, y: 620 }); return items.filter(item => item.name === 'Shader') })()
  await page.getByRole('tree', { name: 'Layers' }).locator(`[data-instance-id="${shader.id}"]`).click()
  // The stop editor shows the active stop: activate the second stop handle first.
  await page.locator('.right-rail').getByRole('slider', { name: 'Stop 2', exact: true }).click()
  const stopSelect = page.locator('.right-rail').getByRole('combobox', { name: 'Stop 2 color source', exact: true })
  await stopSelect.waitFor()
  await stopSelect.selectOption({ label: 'brand' })
  await page.waitForFunction(([key, id, tokenId]) => JSON.parse(localStorage.getItem(key)).file.nodes[id].appearance.fills[0].stops[1].color.tokenId === tokenId, [contentKey(fileA), shader.id, tokenId])
  file = (await stored(page, fileA)).file
  const gradient = file.nodes[shader.id].appearance.fills[0]
  assert.equal(gradient.type, 'gradient'); assert.equal(gradient.shape, 'linear'); assert.equal(gradient.angle, 135)
  assert.deepEqual(gradient.stops.map(stop => stop.position), [0, 1])
  const image = (await previewElements(page)).find(item => item.id === shader.id).image
  assert.match(image, /linear-gradient\(135deg, rgb\(104, 95, 255\) 0%, rgb\(0, 255, 0\) 100%\)/, image)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  file = (await stored(page, fileA)).file
  assert.deepEqual(file.nodes[shader.id].appearance.fills[0].stops[1].color, { kind: 'token', tokenId }, 'gradient stop reference persists')
  await shot(page, '04-gradient-stop-token')
  record('Gradient stops carry literal or token references with positions and angle, and persist through reload')

  // 6. Real component insertion renders in the preview and in the layer tree with its own identity.
  await openDesignTab(page)
  const components = page.getByRole('button', { name: /Expand Components/ })
  if (await components.count()) await components.click()
  await page.getByRole('button', { name: 'Add Button', exact: true }).click()
  await preview(page).locator('[data-preview-instance]').first().waitFor({ timeout: 20_000 })
  file = (await stored(page, fileA)).file
  const instance = Object.values(file.nodes).find(node => node.type === 'component')
  assert.equal(instance.exportName, 'Button'); assert.equal(instance.componentId, 'sample-button')
  assert.ok((await layers(page)).some(item => item.id === instance.id && item.name === 'Button'))
  assert.equal(await preview(page).locator(`[data-preview-instance="${instance.id}"]`).innerText(), 'Button')
  record('Inserting a repository component creates an instance node with source identity, rendered by the real component', instance.componentId)

  // 7. Another file has its own empty theme; the first file's tokens do not leak.
  await page.getByRole('button', { name: 'Files' }).click()
  await page.waitForFunction(() => location.pathname === '/')
  await page.getByRole('button', { name: /New file/i }).first().click()
  await waitEditor(page)
  const fileB = fileIdOf(page)
  assert.notEqual(fileB, fileA)
  await openThemeTab(page)
  assert.match(await page.locator('.left-rail').innerText(), /No tokens/)
  assert.deepEqual((await stored(page, fileB)).file.theme, { tokens: {} })
  assert.equal(Object.keys((await stored(page, fileA)).file.theme.tokens).length, 1, 'file A still has its token')
  record('Files keep independent themes')

  // 8. Two local tabs: a stale tab cannot overwrite the newer revision.
  const tabA = await context.newPage()
  const tabB = await context.newPage()
  await tabA.goto(`${editorUrl}file/${fileB}`, { waitUntil: 'domcontentloaded' }); await waitEditor(tabA)
  await tabB.goto(`${editorUrl}file/${fileB}`, { waitUntil: 'domcontentloaded' }); await waitEditor(tabB)
  const revisionBefore = (await stored(tabA, fileB)).file.revision
  const [tabAFrame] = await draw(tabA, 'f', { x: 400, y: 200 }, { x: 600, y: 360 })
  await waitRevision(tabA, fileB, revisionBefore + 1)
  await draw(tabB, 'r', { x: 700, y: 200 }, { x: 800, y: 300 })
  await tabB.locator('.left-rail').getByText(/conflict|changed|Retry/i).first().waitFor({ timeout: 10_000 })
  const storedB = (await stored(tabA, fileB)).file
  assert.equal(Object.keys(storedB.nodes).filter(id => storedB.nodes[id].type !== 'root').length, 1, 'only the first tab\'s change was stored')
  assert.ok(storedB.nodes[tabAFrame.id], 'the stored node is the first tab\'s frame')
  await tabB.reload({ waitUntil: 'domcontentloaded' }); await waitEditor(tabB)
  assert.deepEqual((await layers(tabB)).map(item => item.id), [tabAFrame.id], 'reloading the stale tab shows the stored state')
  await shot(tabB, '05-stale-tab')
  await tabA.close(); await tabB.close()
  record('A stale local tab is refused by the revision check and recovers on reload without overwriting the newer state')

  // 9. Legacy records migrate once into one file per record, lifting page-local tokens into one theme without recoloring.
  const migrationContext = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 })
  const legacy = await migrationContext.newPage()
  await legacy.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  const legacyCollection = { version: 2, files: [{
    id: 'legacy-file', projectId: 'legacy-file', name: 'Landing page', location: 'This browser', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z', activePageId: 'page-two', previewTheme: 'dark',
    pages: [
      legacyPage('page-one', 'Desktop', { accent: '#111111' }, [
        { id: 'hero', kind: 'frame', name: 'Hero', x: -200, y: -100, width: 320, height: 200, rotation: 0, fill: 'surface', clip: true },
        { id: 'hero-accent', kind: 'rectangle', name: 'Accent', x: 24, y: 32, width: 160, height: 80, rotation: 0, fill: 'accent', parentId: 'hero' },
        { id: 'hero-glow', kind: 'shader', name: 'Glow', x: 200, y: -100, width: 120, height: 80, rotation: 0, fill: 'gradient' },
      ]),
      legacyPage('page-two', 'Mobile', { accent: '#222222' }, [
        { id: 'mobile-accent', kind: 'rectangle', name: 'Accent', x: 0, y: 0, width: 100, height: 100, rotation: 0, fill: 'accent' },
        { id: 'mobile-literal', kind: 'rectangle', name: 'Literal', x: 120, y: 0, width: 100, height: 100, rotation: 0, fill: '#abcdef' },
      ]),
    ],
  }] }
  const legacyBytes = JSON.stringify(legacyCollection)
  await legacy.evaluate(([key, bytes]) => { localStorage.clear(); localStorage.setItem(key, bytes) }, [legacyKey, legacyBytes])
  await legacy.reload({ waitUntil: 'domcontentloaded' })
  await legacy.getByRole('button', { name: /Landing page/ }).first().click()
  await waitEditor(legacy)
  assert.equal(fileIdOf(legacy), 'legacy-file', 'the file id is preserved')
  assert.equal(pageIdOf(legacy), 'page-two', 'the saved active page is restored')
  const migrated = (await stored(legacy, 'legacy-file')).file
  assert.deepEqual(migrated.pages.map(item => item.id), ['page-one', 'page-two'])
  assert.deepEqual(Object.keys(migrated.theme.tokens).sort(), ['legacy:accent', 'legacy:accent:page-two', 'legacy:builtin:ink', 'legacy:builtin:surface'])
  assert.equal(migrated.theme.tokens['legacy:accent'].value.color.hex, '#111111')
  assert.equal(migrated.theme.tokens['legacy:accent:page-two'].value.color.hex, '#222222')
  assert.deepEqual(migrated.nodes['hero-accent'].appearance.fills[0].color, { kind: 'token', tokenId: 'legacy:accent' })
  assert.deepEqual(migrated.nodes['mobile-accent'].appearance.fills[0].color, { kind: 'token', tokenId: 'legacy:accent:page-two' })
  assert.deepEqual(migrated.nodes['mobile-literal'].appearance.fills[0].color, { kind: 'literal', color: { kind: 'hex', hex: '#abcdef' } })
  assert.deepEqual(migrated.relationships['hero-accent'], { parentId: 'hero', orderKey: migrated.relationships['hero-accent'].orderKey })
  assert.deepEqual({ left: migrated.nodes['hero-accent'].styles.left, top: migrated.nodes['hero-accent'].styles.top }, { left: 24, top: 32 })
  assert.equal(migrated.nodes['hero-glow'].appearance.fills[0].type, 'gradient')
  const mobile = await previewElements(legacy)
  assert.equal(mobile.find(item => item.id === 'mobile-accent').background, 'rgb(34, 34, 34)', 'page two keeps its own accent value')
  assert.equal(mobile.find(item => item.id === 'mobile-literal').background, 'rgb(171, 205, 239)')
  const view = await legacy.evaluate(() => JSON.parse(localStorage.getItem('design-editor.view-state.v1')).files['legacy-file'])
  assert.equal(view.previewThemeId, 'dark', 'the saved preview theme carried over into view state')
  await legacy.goto(`${editorUrl}file/legacy-file?pageId=page-one`, { waitUntil: 'domcontentloaded' })
  await waitEditor(legacy)
  const desktop = await previewElements(legacy)
  assert.equal(desktop.find(item => item.id === 'hero-accent').background, 'rgb(17, 17, 17)', 'page one keeps its own accent value')
  assert.equal(desktop.find(item => item.id === 'hero').background, 'rgb(36, 36, 39)', 'surface follows the dark design theme through the source token')
  assert.equal(await legacy.evaluate(key => localStorage.getItem(key), legacyKey), legacyBytes, 'the legacy key is left untouched for recovery')
  const contentBefore = await legacy.evaluate(key => localStorage.getItem(key), contentKey('legacy-file'))
  await legacy.reload({ waitUntil: 'domcontentloaded' })
  await waitEditor(legacy)
  assert.equal(await legacy.evaluate(key => localStorage.getItem(key), contentKey('legacy-file')), contentBefore, 'reopening does not migrate again')
  await shot(legacy, '06-migrated-legacy')
  await migrationContext.close()
  record('Legacy per-page records migrate once into one file: ids, geometry, hierarchy, literal intent, and per-page token values preserved; old keys kept')
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
