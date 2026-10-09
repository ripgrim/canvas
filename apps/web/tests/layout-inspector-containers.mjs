// Layout inspector (L6) container controls in the real editor: Display to Flex on a Card, direction, wrap, the 3 by 3
// anchor, distribution, gap (scalar and split), a Flex child's grow, and Grid tracks (add, edit, invalid text, move,
// remove) plus manual/auto placement. Every check runs on its own so a failure names its cause; a check whose action
// produced no revision at all is marked `blockedByStub` (the Flex/Grid command factory wrote nothing).
// Requires the dev servers on 4317/4318.
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
const shot = async (target, name) => { await target.screenshot({ path: join(evidenceRoot, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }
const preview = page => page.frameLocator('iframe[title="Canvas"]')
const rail = page => page.locator('.right-rail')
const section = (page, id) => rail(page).locator(`[data-section="${id}"]`)
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), contentKey(fileId))
const nodeOf = async (page, id) => (await stored(page)).file.nodes[id]
const revisionOf = async page => (await stored(page)).file.revision
const field = (page, label) => rail(page).getByRole('textbox', { name: label, exact: true })
const combo = (page, label) => rail(page).getByRole('combobox', { name: label, exact: true })
const radio = (page, label) => rail(page).getByRole('radio', { name: label, exact: true })
const button = (page, label) => rail(page).getByRole('button', { name: label, exact: true })
async function selectLayer(page, id) { await page.getByRole('tree', { name: 'Layers' }).locator(`[data-instance-id="${id}"]`).click(); await page.waitForTimeout(300) }
async function commit(page, label, value) { const input = field(page, label); await input.click(); await input.fill(String(value)); await input.press('Enter'); await page.waitForTimeout(150) }
const computed = (page, id) => preview(page).locator(`[data-preview-instance="${id}"]`).evaluate(element => {
  const style = getComputedStyle(element)
  return { display: style.display, flexDirection: style.flexDirection, flexWrap: style.flexWrap, justifyContent: style.justifyContent, alignItems: style.alignItems, columnGap: style.columnGap, rowGap: style.rowGap, flexGrow: style.flexGrow, gridTemplateColumns: style.gridTemplateColumns, gridColumnStart: style.gridColumnStart, gridRowStart: style.gridRowStart }
})
async function waitComputed(page, id, predicate, label) {
  let last = null
  for (let attempt = 0; attempt < 60; attempt++) { last = await computed(page, id).catch(() => null); if (last && predicate(last)) return last; await page.waitForTimeout(100) }
  assert.fail(`${label}: ${JSON.stringify(last)}`)
}

let lastWrote = true
/** Runs one action; records whether it produced a revision so a failing check can say whether the command wrote at all. */
async function act(page, action) {
  const before = await revisionOf(page)
  await action()
  lastWrote = await page.waitForFunction(([key, before]) => (JSON.parse(localStorage.getItem(key) ?? 'null')?.file.revision ?? -1) > before, [contentKey(fileId), before], { timeout: 4000 }).then(() => true, () => false)
  await page.waitForTimeout(300)
  return lastWrote
}
async function check(name, body) {
  lastWrote = true
  try {
    const detail = await body()
    evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) })
    console.log('ok', name, detail ?? '')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    evidence.checks.push({ name, status: 'failed', blockedByStub: !lastWrote, error: message })
    console.log('FAIL', name, lastWrote ? '' : '(no revision: command wrote nothing)', message.split('\n')[0])
  }
}

const fileId = 'layout-inspector-containers'
const px = value => ({ kind: 'px', value })
const fr = value => ({ kind: 'fr', value })
const buttonNode = (id, text) => ({ id, type: 'component', name: text, componentId: 'sample-button', exportName: 'Button', props: { children: text } })
/** A plain Card with three Buttons (component layout), and a Grid Card with two auto-placed Buttons. */
const file = {
  schemaVersion: 5, fileId, revision: 2,
  pages: [{ id: 'page-1', name: 'Containers', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'flex-card': { id: 'flex-card', type: 'component', name: 'Flex card', componentId: 'sample-card', exportName: 'Card', props: {} },
    b1: buttonNode('b1', 'One'), b2: buttonNode('b2', 'Two'), b3: buttonNode('b3', 'Three'),
    'grid-card': { id: 'grid-card', type: 'component', name: 'Grid card', componentId: 'sample-card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'flow' } }, container: { display: 'grid', grid: { columns: [fr(1), px(120)], rows: [{ kind: 'auto' }], autoFlow: 'row' } } } },
    g1: buttonNode('g1', 'Alpha'), g2: buttonNode('g2', 'Beta'),
  },
  relationships: {
    'flex-card': { parentId: 'root-1', orderKey: 'V' },
    b1: { parentId: 'flex-card', orderKey: 'V', slot: 'children' }, b2: { parentId: 'flex-card', orderKey: 'W', slot: 'children' }, b3: { parentId: 'flex-card', orderKey: 'X', slot: 'children' },
    'grid-card': { parentId: 'root-1', orderKey: 'W' },
    g1: { parentId: 'grid-card', orderKey: 'V', slot: 'children' }, g2: { parentId: 'grid-card', orderKey: 'W', slot: 'children' },
  },
  theme: { tokens: {} },
}

async function run() {
  await mkdir(evidenceRoot, { recursive: true })
  assert.ok(await fetch(editorUrl).then(response => response.ok).catch(() => false), 'editor dev server must be running on 4317')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1480, height: 1400 }, deviceScaleFactor: 1, colorScheme: 'light' })
  const page = await context.newPage()
  activePage = page
  page.on('pageerror', error => { evidence.error = `Page error: ${error.message}` })
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(([indexKey, contentKey, content, id]) => {
    localStorage.clear()
    localStorage.setItem(indexKey, JSON.stringify({ schemaVersion: 1, files: { [id]: { id, name: 'Layout containers', createdAt: 1, updatedAt: 1 } } }))
    localStorage.setItem(contentKey, content)
  }, [indexKey, contentKey(fileId), JSON.stringify({ schemaVersion: 1, file }), fileId])
  await page.goto(`${editorUrl}file/${fileId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.canvas-stage').waitFor({ timeout: 20_000 })
  await preview(page).locator('[data-preview-instance="g2"]').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(900)

  // Flex ------------------------------------------------------------------------------------------------------------
  await selectLayer(page, 'flex-card')
  await check('UI: a Card without a container shows the component layout note and no Flex controls', async () => {
    assert.equal(await radio(page, 'Flex').getAttribute('aria-checked'), 'false')
    assert.equal(await rail(page).getByText('Uses the component layout', { exact: true }).count(), 1)
    assert.equal(await combo(page, 'Direction').count(), 0)
  })
  await check('LAY-FLEX-001: Display to Flex stores a Flex container and the preview root becomes flex', async () => {
    await act(page, () => radio(page, 'Flex').click())
    const container = (await nodeOf(page, 'flex-card')).layout?.container
    assert.equal(container?.display, 'flex', JSON.stringify(container))
    assert.ok(container.flex, 'a flex record exists')
    const style = await waitComputed(page, 'flex-card', value => value.display === 'flex' && value.flexDirection === container.flex.direction, 'preview flex')
    return JSON.stringify(container.flex)
  })
  await check('LAY-FLEX-001: direction row is stored and rendered', async () => {
    await act(page, () => combo(page, 'Direction').selectOption('row'))
    assert.equal((await nodeOf(page, 'flex-card')).layout.container.flex.direction, 'row')
    await waitComputed(page, 'flex-card', value => value.flexDirection === 'row', 'row direction')
  })
  await check('LAY-FLEX-001: wrap is stored and rendered', async () => {
    await act(page, () => radio(page, 'Wrap').click())
    assert.equal((await nodeOf(page, 'flex-card')).layout.container.flex.wrap, 'wrap')
    await waitComputed(page, 'flex-card', value => value.flexWrap === 'wrap', 'wrap')
    assert.equal(await combo(page, 'Align content').count(), 1, 'align content appears once the container wraps')
  })
  await check('LAY-FLEX-002: the 3 by 3 anchor sets main and cross alignment and shows the pressed cell', async () => {
    await act(page, () => button(page, 'Align bottom right').click())
    const flex = (await nodeOf(page, 'flex-card')).layout.container.flex
    // Row direction: columns are the main axis (right = end), rows the cross axis (bottom = end).
    assert.deepEqual({ justify: flex.justify, align: flex.align }, { justify: 'end', align: 'end' })
    assert.equal(await button(page, 'Align bottom right').getAttribute('aria-pressed'), 'true')
    assert.equal(await button(page, 'Align top left').getAttribute('aria-pressed'), 'false')
    await waitComputed(page, 'flex-card', value => value.justifyContent === 'flex-end' && value.alignItems === 'flex-end', 'anchored end/end')
  })
  await check('LAY-FLEX-002: a space distribution stays on the main axis and lights the whole cross line', async () => {
    await act(page, () => combo(page, 'Distribution').selectOption('space-between'))
    const flex = (await nodeOf(page, 'flex-card')).layout.container.flex
    assert.deepEqual({ justify: flex.justify, align: flex.align }, { justify: 'space-between', align: 'end' })
    const pressed = await rail(page).locator('[aria-pressed="true"]').evaluateAll(cells => cells.map(cell => cell.getAttribute('aria-label')))
    assert.deepEqual(pressed, ['Align bottom left', 'Align bottom center', 'Align bottom right'])
    await waitComputed(page, 'flex-card', value => value.justifyContent === 'space-between', 'space-between')
  })
  await check('LAY-FLEX-003: scalar gap, then split column and row gaps', async () => {
    await act(page, () => commit(page, 'Gap', 8))
    assert.equal((await nodeOf(page, 'flex-card')).layout.container.gap, 8)
    await waitComputed(page, 'flex-card', value => value.columnGap === '8px' && value.rowGap === '8px', 'gap 8')
    await act(page, () => rail(page).getByText('Separate column and row gaps', { exact: true }).click())
    assert.deepEqual((await nodeOf(page, 'flex-card')).layout.container.gap, { x: 8, y: 8 })
    await act(page, () => commit(page, 'Row gap', 4))
    assert.deepEqual((await nodeOf(page, 'flex-card')).layout.container.gap, { x: 8, y: 4 })
    await waitComputed(page, 'flex-card', value => value.columnGap === '8px' && value.rowGap === '4px', 'split gap')
  })
  await shot(section(page, 'layout'), 'containers-flex-section')
  await check('Flex item: grow on a child is stored and rendered', async () => {
    await selectLayer(page, 'b1')
    assert.equal(await section(page, 'layout-item').count(), 1, 'a Flex child shows the Flex item section')
    await act(page, () => commit(page, 'Grow', 1))
    assert.equal((await nodeOf(page, 'b1')).layout.item.flex.grow, 1)
    await waitComputed(page, 'b1', value => value.flexGrow === '1', 'grow 1')
    await shot(section(page, 'layout-item'), 'containers-flex-item')
  })

  // Grid ------------------------------------------------------------------------------------------------------------
  await selectLayer(page, 'grid-card')
  const columns = async () => (await nodeOf(page, 'grid-card')).layout.container.grid.columns
  await check('UI: Grid tracks list one field per track with the stored values', async () => {
    assert.equal(await field(page, 'Column 1').inputValue(), '1fr')
    assert.equal(await field(page, 'Column 2').inputValue(), '120px')
    assert.equal(await field(page, 'Row 1').inputValue(), 'auto')
    assert.equal(await button(page, 'Remove row 1').isDisabled(), true, 'the last row cannot be removed')
  })
  await check('LAY-GRID-001: add a column appends 1fr', async () => {
    await act(page, () => button(page, 'Add column').click())
    assert.deepEqual(await columns(), [fr(1), px(120), fr(1)])
  })
  await check('LAY-GRID-001: editing a track parses the text and renders it', async () => {
    await act(page, () => commit(page, 'Column 3', '200px'))
    assert.deepEqual(await columns(), [fr(1), px(120), px(200)])
    await waitComputed(page, 'grid-card', value => value.gridTemplateColumns.endsWith(' 120px 200px'), 'three columns render')
  })
  await check('LAY-GRID-008: invalid track text shows the parser error and writes nothing', async () => {
    const before = await revisionOf(page)
    await commit(page, 'Column 1', 'subgrid')
    await rail(page).getByRole('alert').waitFor({ timeout: 3000 })
    assert.equal(await rail(page).getByRole('alert').innerText(), 'subgrid is not supported')
    await page.waitForTimeout(500)
    assert.equal(await revisionOf(page), before, 'no revision')
    assert.deepEqual(await columns(), [fr(1), px(120), px(200)])
    assert.equal(await field(page, 'Column 1').inputValue(), '1fr', 'the field returns to the stored value')
    await shot(section(page, 'layout'), 'containers-grid-error')
  })
  await check('LAY-GRID-004: moving a column earlier reorders the tracks', async () => {
    await act(page, () => button(page, 'Move column 3 earlier').click())
    assert.deepEqual(await columns(), [fr(1), px(200), px(120)])
  })
  await check('LAY-GRID-003: removing a column drops it', async () => {
    await act(page, () => button(page, 'Remove column 2').click())
    assert.deepEqual(await columns(), [fr(1), px(120)])
  })
  await check('LAY-GRID-005: Manual writes each child its measured cell; Auto clears the starts again', async () => {
    assert.equal(await radio(page, 'Auto').getAttribute('aria-checked'), 'true', 'no explicit starts: auto')
    await act(page, () => radio(page, 'Manual').click())
    // Two auto-placed children in a two-column row flow occupy (1, 1) and (2, 1).
    const g1 = (await nodeOf(page, 'g1')).layout?.item.grid, g2 = (await nodeOf(page, 'g2')).layout?.item.grid
    assert.deepEqual({ g1: [g1?.columnStart, g1?.rowStart], g2: [g2?.columnStart, g2?.rowStart] }, { g1: [1, 1], g2: [2, 1] })
    assert.equal(await radio(page, 'Manual').getAttribute('aria-checked'), 'true')
    await waitComputed(page, 'g2', value => value.gridColumnStart === '2' && value.gridRowStart === '1', 'explicit placement renders')
    await act(page, () => radio(page, 'Auto').click())
    const after = [(await nodeOf(page, 'g1')).layout?.item.grid?.columnStart, (await nodeOf(page, 'g2')).layout?.item.grid?.columnStart]
    assert.deepEqual(after, [undefined, undefined])
    await waitComputed(page, 'g2', value => value.gridColumnStart === 'auto', 'auto placement renders')
  })
  await shot(section(page, 'layout'), 'containers-grid-section')
  await check('Grid item: a child shows placement fields and column span is stored', async () => {
    await selectLayer(page, 'g1')
    assert.equal(await section(page, 'layout-item').count(), 1)
    await act(page, () => commit(page, 'Column span', 2))
    assert.equal((await nodeOf(page, 'g1')).layout.item.grid.columnSpan, 2)
    await shot(section(page, 'layout-item'), 'containers-grid-item')
  })
  const failed = evidence.checks.filter(entry => entry.status === 'failed')
  evidence.status = failed.length ? 'failed' : 'passed'
  if (failed.length) process.exitCode = 1
}

try { await run() }
catch (error) {
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error)
  if (activePage && !activePage.isClosed()) { try { await activePage.screenshot({ path: join(evidenceRoot, 'containers-failure.png') }); evidence.screenshots.push('containers-failure.png') } catch {} }
  console.error(evidence.error)
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(join(evidenceRoot, 'layout-inspector-containers.json'), JSON.stringify(evidence, null, 2))
  const summary = { status: evidence.status, passed: evidence.checks.filter(entry => entry.status === 'passed').length, failed: evidence.checks.filter(entry => entry.status === 'failed').map(entry => ({ name: entry.name, blockedByStub: entry.blockedByStub })) }
  console.log(JSON.stringify(summary))
}
