// Layout inspector (L6) in the real editor against a seeded v5 file: semantic sizing with measured values, undo and
// reload, absolute insets, flow round trip, one undo step per scrub, Escape cancelling a scrub, and a multi-node
// Fixed transition in one revision. Expected numbers are derived by hand from the fixture CSS and cross-checked
// against rectangles read inside the preview frame. Requires the dev servers on 4317/4318.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const evidenceRoot = join(projectRoot, 'outputs', 'layout-inspector')
const editorUrl = 'http://127.0.0.1:4317/'
const indexKey = 'design-editor.browser-files-index.v3'
const contentKey = fileId => `design-editor.browser-file.${fileId}.v3`
const evidence = { status: 'failed', checks: [], screenshots: [], error: null }
let browser = null
let activePage = null
const record = (name, detail = '') => { evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log('ok', name, detail) }
const shot = async (target, name) => { await target.screenshot({ path: join(evidenceRoot, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }
const preview = page => page.frameLocator('iframe[title="Canvas"]')
const rail = page => page.locator('.right-rail')
const section = (page, id) => rail(page).locator(`[data-section="${id}"]`)
const stored = (page, fileId) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), contentKey(fileId))
const nodeOf = async (page, id) => (await stored(page, fileId)).file.nodes[id]
const revisionOf = async page => (await stored(page, fileId)).file.revision
const waitRevision = (page, atLeast) => page.waitForFunction(([key, atLeast]) => (JSON.parse(localStorage.getItem(key) ?? 'null')?.file.revision ?? -1) >= atLeast, [contentKey(fileId), atLeast], { timeout: 10_000 })
const field = (page, label) => rail(page).getByRole('textbox', { name: label, exact: true })
const combo = (page, label) => rail(page).getByRole('combobox', { name: label, exact: true })
const scrubHandle = (page, id) => rail(page).locator(`label[for="${id}"] [data-scrub-handle]`)
const blur = page => page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
const undoDisabled = page => page.locator('.canvas-floating-actions button[aria-label="Undo document edit"]').isDisabled()
const redoDisabled = page => page.locator('.canvas-floating-actions button[aria-label="Redo document edit"]').isDisabled()
async function historyDepth(page) {
  // Undo until the button disables, then redo until it disables; the nodes must end exactly where they started.
  await blur(page)
  const start = JSON.stringify((await stored(page, fileId)).file.nodes)
  let steps = 0
  while (!(await undoDisabled(page)) && steps < 60) { await page.keyboard.press('Control+z'); await page.waitForTimeout(120); steps += 1 }
  for (let index = 0; index < steps + 5 && !(await redoDisabled(page)); index++) { await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(120) }
  await page.waitForFunction(([key, start]) => JSON.stringify(JSON.parse(localStorage.getItem(key) ?? 'null')?.file.nodes) === start, [contentKey(fileId), start], { timeout: 10_000 })
  await page.waitForTimeout(300)
  return steps
}
/** Runs one editing action and waits until its save lands. */
async function act(page, action) { const before = await revisionOf(page); await action(); await waitRevision(page, before + 1); await page.waitForTimeout(250) }
async function commit(page, label, value) { const input = field(page, label); await input.click(); await input.fill(String(value)); await input.press('Enter'); await page.waitForTimeout(150) }
async function choose(page, label, option) { await combo(page, label).click(); await page.getByRole('option', { name: option, exact: true }).click(); await page.waitForTimeout(150) }
async function selectLayer(page, id, modifiers = []) { await page.getByRole('tree', { name: 'Layers' }).locator(`[data-instance-id="${id}"]`).click({ modifiers }); await page.waitForTimeout(250) }
const styleOf = (page, id) => preview(page).locator(`[data-preview-instance="${id}"]`).evaluate(element => {
  const style = getComputedStyle(element)
  return { width: style.width, height: style.height, position: style.position, right: style.right, left: style.left, zIndex: style.zIndex, inline: element.getAttribute('style') ?? '' }
})
async function waitStyle(page, id, predicate, label) {
  let last = null
  for (let attempt = 0; attempt < 80; attempt++) { last = await styleOf(page, id).catch(() => null); if (last && predicate(last)) return last; await page.waitForTimeout(100) }
  assert.fail(`${label}: ${JSON.stringify(last)}`)
}
/** Rectangles in preview CSS pixels: client rects divided by the canvas zoom (offsetWidth is unscaled). */
const measure = page => preview(page).locator('[data-preview-instance="card"]').evaluate(card => {
  const zoom = card.getBoundingClientRect().width / card.offsetWidth
  const box = element => { const rect = element.getBoundingClientRect(); return { x: rect.x / zoom, y: rect.y / zoom, width: rect.width / zoom, height: rect.height / zoom } }
  const style = getComputedStyle(card)
  const sides = ['Left', 'Right', 'Top', 'Bottom'].map(side => [side, Number.parseFloat(style[`border${side}Width`]), Number.parseFloat(style[`padding${side}`])])
  return { zoom, card: box(card), a: box(card.querySelector('[data-preview-instance="label-a"]')), b: box(card.querySelector('[data-preview-instance="label-b"]')), sides: Object.fromEntries(sides.map(([side, border, padding]) => [side, { border, padding }])) }
})

const fileId = 'layout-inspector-file'
const px = value => ({ kind: 'px', value })
/** A Card (28 px padding and 1 px border from its stylesheet) in the 352 px host flow, holding two Labels. */
const file = {
  schemaVersion: 5, fileId, revision: 3,
  pages: [{ id: 'page-1', name: 'Inspector', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    card: { id: 'card', type: 'component', name: 'Login card', componentId: 'sample-card', exportName: 'Card', props: {} },
    'label-a': { id: 'label-a', type: 'component', name: 'Email label', componentId: 'sample-label', exportName: 'Label', props: { children: 'Email' }, layout: { item: { position: { mode: 'flow' }, width: { value: px(120) } } } },
    'label-b': { id: 'label-b', type: 'component', name: 'Password label', componentId: 'sample-label', exportName: 'Label', props: { children: 'Password' } },
  },
  relationships: {
    card: { parentId: 'root-1', orderKey: 'V' },
    'label-a': { parentId: 'card', orderKey: 'V', slot: 'children' },
    'label-b': { parentId: 'card', orderKey: 'W', slot: 'children' },
  },
  theme: { tokens: {} },
}

async function open(page) {
  await page.goto(`${editorUrl}file/${fileId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.canvas-stage').waitFor({ timeout: 20_000 })
  await page.locator('iframe[title="Canvas"]').waitFor()
  await preview(page).locator('[data-preview-instance="label-a"]').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(800)
}

async function run() {
  await mkdir(evidenceRoot, { recursive: true })
  assert.ok(await fetch(editorUrl).then(response => response.ok).catch(() => false), 'editor dev server must be running on 4317')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1480, height: 1100 }, deviceScaleFactor: 1, colorScheme: 'light' })
  const page = await context.newPage()
  activePage = page
  page.on('pageerror', error => { evidence.error = `Page error: ${error.message}` })
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(([indexKey, contentKey, content, id]) => {
    localStorage.clear()
    localStorage.setItem(indexKey, JSON.stringify({ schemaVersion: 1, files: { [id]: { id, name: 'Layout inspector', createdAt: 1, updatedAt: 1 } } }))
    localStorage.setItem(contentKey, content)
  }, [indexKey, contentKey(fileId), JSON.stringify({ schemaVersion: 1, file }), fileId])
  await open(page)

  // 1. LAY-SIZE-001 (Relative): a nested Label inside the Card.
  await selectLayer(page, 'label-a')
  await section(page, 'sizing').waitFor()
  const before = await measure(page)
  // Hand derivation: host content 352, card border 1 + padding 28 per side, so the card content box is 352 - 58 = 294 wide.
  // The label is 120 wide: 120 / 294 = 0.408, rounded to 41 percent.
  const content = before.card.width - before.sides.Left.border - before.sides.Left.padding - before.sides.Right.border - before.sides.Right.padding
  assert.ok(Math.abs(content - 294) < 0.01, `card content width is 294: ${content}`)
  assert.ok(Math.abs(before.a.width - 120) < 0.01, `label width is 120: ${before.a.width}`)
  assert.equal(Math.round((before.a.width / content) * 100), 41, 'the measured rectangles give 41 percent')
  assert.equal((await styleOf(page, 'label-a')).width, '120px')
  await act(page, () => choose(page, 'Width sizing', 'Relative'))
  assert.deepEqual((await nodeOf(page, 'label-a')).layout.item.width, { value: { kind: 'percent', value: 41 } }, 'stored percent equals the measured ratio')
  // 41% of 294 is 120.54 px: the preview now resolves the percent, not the old 120 px.
  const relative = await waitStyle(page, 'label-a', style => style.width !== '120px', 'preview width follows the percent')
  assert.ok(Math.abs(Number.parseFloat(relative.width) - 120.54) < 0.02, `computed width ${relative.width}`)
  assert.ok(/width:\s*41%/.test(relative.inline), `inline width is the percent: ${relative.inline}`)
  record('LAY-SIZE-001: Width to Relative stores the measured ratio and the preview resolves it', `41% -> ${relative.width}`)
  await shot(section(page, 'sizing'), 'sizing-relative')

  // 2. LAY-SIZE-001 (undo and reload): Height to Fixed, then a typed value; one Ctrl+Z restores the prior record.
  await act(page, () => choose(page, 'Height sizing', 'Fixed'))
  const fixedLayout = (await nodeOf(page, 'label-a')).layout
  assert.equal(fixedLayout.item.height.value.kind, 'px')
  assert.equal(fixedLayout.item.height.value.value, Math.round(before.a.height), 'Fixed bakes the measured height')
  await act(page, () => commit(page, 'Height', 40))
  assert.deepEqual((await nodeOf(page, 'label-a')).layout.item.height, { value: px(40) })
  await waitStyle(page, 'label-a', style => style.height === '40px', 'height renders 40px')
  await blur(page)
  await act(page, () => page.keyboard.press('Control+z'))
  assert.deepEqual((await nodeOf(page, 'label-a')).layout, fixedLayout, 'one undo step returns the stored record to the prior revision content')
  await act(page, () => page.keyboard.press('Control+Shift+z'))
  assert.deepEqual((await nodeOf(page, 'label-a')).layout.item.height, { value: px(40) })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await open(page)
  assert.deepEqual((await nodeOf(page, 'label-a')).layout.item.height, { value: px(40) }, 'the Fixed height survives reload')
  await waitStyle(page, 'label-a', style => style.height === '40px', 'reloaded preview renders 40px')
  await selectLayer(page, 'label-a')
  assert.equal(await field(page, 'Height').inputValue(), '40')
  assert.equal((await combo(page, 'Height sizing').innerText()).trim(), 'Fixed')
  record('LAY-SIZE-001: Fixed height round-trips through undo (one step) and reload')

  // 3. Absolute with insets: leaving the flow stores the measured local point from the card padding edge (28, 28).
  await act(page, () => rail(page).getByRole('radio', { name: 'Absolute', exact: true }).click())
  let layout = (await nodeOf(page, 'label-a')).layout
  assert.deepEqual(layout.item.position, { mode: 'absolute', left: px(28), top: px(28) })
  assert.deepEqual(layout.item.width, { value: { kind: 'percent', value: 41 } }, 'sizing survives leaving the flow')
  const moved = await measure(page)
  assert.ok(Math.abs(moved.a.x - before.a.x) < 0.6 && Math.abs(moved.a.y - before.a.y) < 0.6, `the label stays in place: ${JSON.stringify({ before: before.a, after: moved.a })}`)
  await act(page, () => commit(page, 'X position', ''))
  await act(page, () => commit(page, 'Right inset', 10))
  await act(page, () => commit(page, 'Z index', 2))
  layout = (await nodeOf(page, 'label-a')).layout
  assert.deepEqual(layout.item.position, { mode: 'absolute', top: px(28), right: px(10), zIndex: 2 }, 'emptying X clears left; right and z-index are stored')
  const placed = await waitStyle(page, 'label-a', style => style.position === 'absolute' && style.right === '10px' && style.zIndex === '2', 'preview right inset')
  const anchored = await measure(page)
  // Absolute insets count from the padding edge: card right edge minus its 1 px border minus 10.
  assert.ok(Math.abs((anchored.card.x + anchored.card.width - 1 - 10) - (anchored.a.x + anchored.a.width)) < 0.6, 'the label right edge sits 10 px inside the card padding box')
  record('Absolute: measured local point, X cleared, right 10 and z-index 2 stored and rendered', JSON.stringify({ right: placed.right, zIndex: placed.zIndex }))
  await shot(section(page, 'position'), 'position-absolute')

  // 4. LAY-GEST-004: back to In flow drops insets and z-index while sizing survives.
  await act(page, () => rail(page).getByRole('radio', { name: 'In flow', exact: true }).click())
  layout = (await nodeOf(page, 'label-a')).layout
  assert.deepEqual(layout.item, { position: { mode: 'flow' }, width: { value: { kind: 'percent', value: 41 } }, height: { value: px(40) } })
  await waitStyle(page, 'label-a', style => style.position !== 'absolute' && style.zIndex === 'auto', 'flow restored in the preview')
  assert.equal(await rail(page).getByText('Locked to layout', { exact: true }).count(), 1, 'a flow child shows the locked note')
  assert.equal(await field(page, 'Right inset').count(), 0, 'flow nodes have no inset fields')
  record('LAY-GEST-004: flow -> absolute -> flow clears insets and z-index and keeps width and height')
  await shot(section(page, 'position'), 'position-flow')

  // 5. LAY-GEST-002: a pointer scrub on the Height prefix is one revision and one undo step.
  const depth = await historyDepth(page)
  const revision = await revisionOf(page)
  await waitStyle(page, 'label-a', style => style.height === '40px' && style.position !== 'absolute', 'history replay settled')
  const handle = await scrubHandle(page, 'sizing-height').boundingBox()
  assert.ok(handle, 'the Height prefix is a scrub handle')
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + handle.height / 2, { steps: 20 })
  const during = await waitStyle(page, 'label-a', style => style.height === '60px', 'the scrub previews live')
  assert.equal(await revisionOf(page), revision, 'previewing writes nothing')
  await page.mouse.up()
  await waitRevision(page, revision + 1)
  await page.waitForTimeout(500)
  assert.equal(await revisionOf(page), revision + 1, 'a scrub is exactly one revision')
  assert.deepEqual((await nodeOf(page, 'label-a')).layout.item.height, { value: px(60) }, 'Paper sensitivity adds 20 after 80 px of travel')
  assert.equal(await historyDepth(page), depth + 1, 'and one undo step')
  record('LAY-GEST-002: scrubbing Height by pointer commits one revision and one undo step', during.height)

  // 6. LAY-GEST-001: Escape mid-scrub cancels the preview and changes nothing.
  const quietDepth = await historyDepth(page)
  const quietRevision = await revisionOf(page)
  await waitStyle(page, 'label-a', style => style.height === '60px', 'history replay settled')
  const handle2 = await scrubHandle(page, 'sizing-height').boundingBox()
  await page.mouse.move(handle2.x + handle2.width / 2, handle2.y + handle2.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle2.x + handle2.width / 2 + 60, handle2.y + handle2.height / 2, { steps: 15 })
  await waitStyle(page, 'label-a', style => style.height === '75px', 'the cancelled scrub previewed first')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.waitForTimeout(600)
  assert.equal(await revisionOf(page), quietRevision, 'Escape writes no revision')
  assert.deepEqual((await nodeOf(page, 'label-a')).layout.item.height, { value: px(60) })
  await waitStyle(page, 'label-a', style => style.height === '60px', 'the preview returns to the stored height')
  assert.equal(await historyDepth(page), quietDepth, 'and records no history')
  assert.equal(await rail(page).locator('[data-section="sizing"]').count(), 1, 'Escape during a scrub keeps the selection')
  record('LAY-GEST-001: Escape during a scrub restores the preview with no revision or history change')

  // 7. LAY-SIZE-003: two Labels to Fixed in one revision, each with its own measured width.
  await selectLayer(page, 'label-a')
  await selectLayer(page, 'label-b', ['Control'])
  assert.equal((await combo(page, 'Width sizing').innerText()).trim(), 'Mixed', 'Relative and Auto widths show Mixed')
  const pair = await measure(page)
  // Hand derivation: label-a is 41% of 294 = 120.54 -> 121; label-b stretches across the card content box -> 294.
  assert.ok(Math.abs(pair.a.width - 120.54) < 0.02 && Math.abs(pair.b.width - 294) < 0.01, JSON.stringify(pair))
  const multiDepth = await historyDepth(page)
  const multiRevision = await revisionOf(page)
  await act(page, () => choose(page, 'Width sizing', 'Fixed'))
  await page.waitForTimeout(400)
  assert.equal(await revisionOf(page), multiRevision + 1, 'one revision for both nodes')
  assert.deepEqual((await nodeOf(page, 'label-a')).layout.item.width, { value: px(121) })
  assert.deepEqual((await nodeOf(page, 'label-b')).layout.item.width, { value: px(294) })
  assert.equal(await historyDepth(page), multiDepth + 1, 'one undo step for both nodes')
  record('LAY-SIZE-003: multi-select Fixed stores per-node measured widths (121 and 294) in one revision and one undo step')
  await shot(rail(page), 'multi-select-rail')

  // Section screenshots for a single selection, including Layout and Spacing.
  await selectLayer(page, 'card')
  await shot(section(page, 'layout'), 'layout-card')
  await shot(section(page, 'spacing'), 'spacing-card')
  await shot(page, 'editor-card-selected')
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
  await writeFile(join(evidenceRoot, 'layout-inspector.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, screenshots: evidence.screenshots }))
}
