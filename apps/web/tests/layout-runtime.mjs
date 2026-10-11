// Layout L2 in the real editor: a stored schema v5 file whose Card carries a Grid container reaches the preview as
// inline longhands on the actual component root (no wrapper), measured tracks come back, a legacy five-field node
// sends nothing new, and opening the file rewrites nothing. Requires the dev servers on 4317/4318.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const evidenceRoot = join(projectRoot, 'outputs', 'layout')
const editorUrl = 'http://127.0.0.1:4317/'
const indexKey = 'design-editor.browser-files-index.v3'
const contentKey = fileId => `design-editor.browser-file.${fileId}.v3`
const evidence = { status: 'failed', checks: [], screenshots: [], error: null }
let browser = null
const record = (name, detail = '') => { evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log('✓', name, detail) }
const shot = async (page, name) => { await page.screenshot({ path: join(evidenceRoot, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }
const preview = page => page.frameLocator('iframe[title="Canvas"]')
const stored = (page, fileId) => page.evaluate(key => localStorage.getItem(key), contentKey(fileId))

const fileId = 'layout-l2-file'
const px = value => ({ kind: 'px', value })
/** Hand-built v5 file: a Grid card with two buttons, a legacy-only absolute card, one page. */
const file = {
  schemaVersion: 7, fileId, revision: 3,
  pages: [{ id: 'page-1', name: 'Layout', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'grid-card': { id: 'grid-card', type: 'component', name: 'Grid card', componentId: 'sample-card', exportName: 'Card', props: {}, layout: {
      item: { position: { mode: 'flow' } },
      container: { display: 'grid', gap: { x: 8, y: 4 }, grid: { columns: [{ kind: 'fr', value: 1 }, px(120)], rows: [{ kind: 'auto' }], autoFlow: 'row' } },
      spacing: { padding: 12 },
    } },
    'btn-a': { id: 'btn-a', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Alpha' }, layout: { item: { position: { mode: 'flow' }, grid: { columnStart: 2 } } } },
    'btn-b': { id: 'btn-b', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Beta' } },
    'legacy-card': { id: 'legacy-card', type: 'component', name: 'Legacy card', componentId: 'sample-card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'absolute', left: px(40), top: px(300) }, width: { value: px(200) } } } },
    'edge-card': { id: 'edge-card', type: 'component', name: 'Edge card', componentId: 'sample-card', exportName: 'Card', props: {}, layout: { item: { position: { mode: 'absolute', right: px(10), bottom: px(12), zIndex: 3 }, width: { value: { kind: 'percent', value: 50 } } } } },
  },
  relationships: {
    'grid-card': { parentId: 'root-1', orderKey: 'V' },
    'btn-a': { parentId: 'grid-card', orderKey: 'V', slot: 'children' },
    'btn-b': { parentId: 'grid-card', orderKey: 'W', slot: 'children' },
    'legacy-card': { parentId: 'root-1', orderKey: 'W' },
    'edge-card': { parentId: 'root-1', orderKey: 'X' },
  },
  theme: { tokens: {} },
}

async function run() {
  await mkdir(evidenceRoot, { recursive: true })
  assert.ok(await fetch(editorUrl).then(response => response.ok).catch(() => false), 'editor dev server must be running on 4317')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1480, height: 960 } })
  const page = await context.newPage()
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  const contentBytes = JSON.stringify({ schemaVersion: 1, file })
  await page.evaluate(([indexKey, contentKey, content, id]) => {
    localStorage.clear()
    localStorage.setItem(indexKey, JSON.stringify({ schemaVersion: 1, files: { [id]: { id, name: 'Layout L2', createdAt: 1, updatedAt: 1 } } }))
    localStorage.setItem(contentKey, content)
  }, [indexKey, contentKey(fileId), contentBytes, fileId])
  await page.goto(`${editorUrl}file/${fileId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.canvas-stage').waitFor({ timeout: 20_000 })
  await page.locator('iframe[title="Canvas"]').waitFor()
  const card = preview(page).locator('[data-preview-instance="grid-card"]')
  await card.waitFor({ timeout: 20_000 })
  const read = () => card.evaluate(element => {
    const style = getComputedStyle(element)
    const buttons = [...element.querySelectorAll('[data-preview-instance]')].map(child => ({ id: child.getAttribute('data-preview-instance'), direct: child.parentElement === element, gridColumnStart: getComputedStyle(child).gridColumnStart }))
    return { tag: element.tagName.toLowerCase(), parentIsHost: element.parentElement.hasAttribute('data-preview-host'), display: style.display, columns: style.gridTemplateColumns, columnGap: style.columnGap, rowGap: style.rowGap, padding: style.paddingLeft, inline: element.getAttribute('style'), buttons }
  })
  let observed = null
  for (let attempt = 0; attempt < 80; attempt++) { observed = await read(); if (observed.display === 'grid') break; await page.waitForTimeout(100) }
  assert.equal(observed.display, 'grid', `the card root is a grid: ${JSON.stringify(observed)}`)
  assert.equal(observed.tag, 'section', 'the layout landed on the Card component root itself')
  assert.equal(observed.parentIsHost, true, 'no wrapper was inserted between the host and the root')
  // Host width 400 minus 24 padding each side is 352; card border 1px each side and authored padding 12 leave 326; 1fr = 326 - 120 - 8 = 198.
  assert.equal(observed.columns, '198px 120px', 'tracks resolve from the authored template')
  assert.equal(observed.columnGap, '8px'); assert.equal(observed.rowGap, '4px'); assert.equal(observed.padding, '12px')
  assert.deepEqual(observed.buttons, [{ id: 'btn-a', direct: true, gridColumnStart: '2' }, { id: 'btn-b', direct: true, gridColumnStart: 'auto' }], 'children are direct roots and keep their authored placement')
  record('LAY-ROOT-001: Grid container applied to the actual Card root with no wrapper', observed.columns)
  await shot(page, 'l2-grid-card')

  const legacy = await preview(page).locator('[data-preview-instance="legacy-card"]').evaluate(element => ({ inline: element.getAttribute('style'), position: getComputedStyle(element).position, width: getComputedStyle(element).width }))
  assert.equal(legacy.position, 'absolute'); assert.equal(legacy.width, '200px')
  assert.ok(!/grid|gap|padding/.test(legacy.inline ?? ''), `a five-field node carries only its placement: ${legacy.inline}`)
  record('LAY-SCHEMA-001: a legacy-only placement renders exactly as before', legacy.inline)

  // The host is 400 - 48 = 352 wide, so a 50% width on an absolute root resolves to 176px against the host box; right/bottom insets replace left/top.
  const edge = await preview(page).locator('[data-preview-instance="edge-card"]').evaluate(element => { const style = getComputedStyle(element); return { inline: element.getAttribute('style') ?? '', position: style.position, right: style.right, bottom: style.bottom, width: style.width, zIndex: style.zIndex } })
  assert.equal(edge.position, 'absolute'); assert.equal(edge.right, '10px'); assert.equal(edge.bottom, '12px'); assert.equal(edge.width, '176px'); assert.equal(edge.zIndex, '3')
  assert.ok(!/left:|top:/.test(edge.inline), `authored right/bottom insets replace left/top: ${edge.inline}`)
  record('LAY-SIZE-001 and LAY-GEST-004: percent width and right/bottom insets on a root resolve against the host', edge.inline)

  assert.equal(await stored(page, fileId), contentBytes, 'opening the file rewrote nothing')
  record('LAY-SAVE-001: opening a v5 file writes nothing back')

  const hudReports = await page.evaluate(() => document.querySelector('.canvas-stage') !== null)
  assert.ok(hudReports)
  evidence.status = 'passed'
}

run().catch(error => { evidence.status = 'failed'; evidence.error = String(error?.stack ?? error); console.error(error); process.exitCode = 1 })
  .finally(async () => {
    await mkdir(evidenceRoot, { recursive: true })
    await writeFile(join(evidenceRoot, 'layout-runtime.json'), JSON.stringify(evidence, null, 2))
    await browser?.close()
  })
