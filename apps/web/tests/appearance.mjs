// Appearance: creation defaults, layered fills, blending, outline, borders, eligibility, mixed selections, one-step edits,
// gesture cancel, component root overrides, save/reopen, and the four editor/preview theme combinations.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const evidenceRoot = join(projectRoot, 'outputs', 'appearance')
const editorUrl = 'http://127.0.0.1:4317/'
const contentKey = fileId => `design-editor.browser-file.${fileId}.v3`
const evidence = { status: 'failed', checks: [], screenshots: [], error: null }
let browser = null
let activePage = null
const record = (name, detail = '') => { evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log('✓', name, detail) }
const shot = async (page, name) => { await page.screenshot({ path: join(evidenceRoot, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }
const fileIdOf = page => new URL(page.url()).pathname.split('/').pop()
const stored = (page, fileId) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), contentKey(fileId))
const node = async (page, fileId, id) => (await stored(page, fileId)).file.nodes[id]
const layers = page => page.getByRole('tree', { name: 'Layers' }).locator('[role="treeitem"]').evaluateAll(items => items.map(item => ({ id: item.getAttribute('data-instance-id'), name: item.getAttribute('aria-label') })))
const preview = page => page.frameLocator('iframe[title="Canvas"]')
const rail = page => page.locator('.right-rail')
const styleOf = (page, selector) => preview(page).locator(selector).evaluate(element => { const style = getComputedStyle(element); return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, color: style.color, opacity: style.opacity, mixBlendMode: style.mixBlendMode, visibility: style.visibility, outline: style.outline, outlineOffset: style.outlineOffset, borderTop: style.borderTop, borderRight: style.borderRight, borderBottom: style.borderBottom, borderLeft: style.borderLeft, backgroundClip: style.backgroundClip, inline: element.getAttribute('style') ?? '' } })
const elementStyle = (page, id) => styleOf(page, `[data-preview-canvas="${id}"]`)
const waitEditor = async page => { await page.locator('.canvas-stage').waitFor({ timeout: 20_000 }); await page.locator('iframe[title="Canvas"]').waitFor(); await page.waitForTimeout(400) }
const waitRevision = (page, fileId, atLeast) => page.waitForFunction(([key, atLeast]) => (JSON.parse(localStorage.getItem(key) ?? 'null')?.file.revision ?? -1) >= atLeast, [contentKey(fileId), atLeast])
const revisionOf = async (page, fileId) => (await stored(page, fileId)).file.revision
/** Runs one editing action and waits for its save, so stored reads see the result. */
async function act(page, fileId, action) { const before = await revisionOf(page, fileId); await action(); await waitRevision(page, fileId, before + 1) }
async function waitStyle(page, id, predicate, label) {
  for (let attempt = 0; attempt < 60; attempt++) { const style = await elementStyle(page, id).catch(() => null); if (style && predicate(style)) return style; await page.waitForTimeout(100) }
  const last = await elementStyle(page, id)
  assert.fail(`${label}: ${JSON.stringify(last)}`)
}
async function draw(page, tool, from, to) {
  const stage = await page.locator('.canvas-stage').boundingBox()
  await page.keyboard.press(tool)
  await page.mouse.move(stage.x + from.x, stage.y + from.y); await page.mouse.down()
  if (to) await page.mouse.move(stage.x + to.x, stage.y + to.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  return (await layers(page))
}
async function selectLayer(page, id) { await page.getByRole('tree', { name: 'Layers' }).locator(`[data-instance-id="${id}"]`).click(); await page.waitForTimeout(150) }
async function commitField(page, label, value) { const field = rail(page).getByRole('textbox', { name: label, exact: true }); await field.click(); await field.fill(String(value)); await field.press('Enter'); await page.waitForTimeout(150) }
const undoDisabled = page => page.locator('.canvas-floating-actions button[aria-label="Undo document edit"]').isDisabled()
async function historyDepth(page, fileId) {
  // Count undo steps by undoing until the button disables, then redoing back; the stored revision stays the same count ahead.
  let steps = 0
  while (!(await undoDisabled(page)) && steps < 50) { await page.keyboard.press('Control+z'); await page.waitForTimeout(120); steps += 1 }
  for (let index = 0; index < steps; index++) { await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(120) }
  await waitRevision(page, fileId, 0)
  return steps
}

async function run() {
  await mkdir(evidenceRoot, { recursive: true })
  assert.ok(await fetch(editorUrl).then(response => response.ok).catch(() => false), 'editor dev server must be running on 4317')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1, colorScheme: 'light' })
  const page = await context.newPage()
  activePage = page
  page.on('pageerror', error => { evidence.error = `Page error: ${error.message}` })
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /New file/i }).first().click()
  await waitEditor(page)
  const fileId = fileIdOf(page)

  // 1. Rectangle creation defaults: click = 500 x 500 white; drag = dragged size, white. Frame keeps its own default.
  const [clicked] = await draw(page, 'r', { x: 300, y: 150 })
  let rect = await node(page, fileId, clicked.id)
  assert.deepEqual({ width: rect.styles.width, height: rect.styles.height }, { width: 500, height: 500 })
  assert.deepEqual(rect.appearance.fills.map(({ id, ...paint }) => paint), [{ type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } }])
  await waitStyle(page, clicked.id, style => style.backgroundColor === 'rgb(255, 255, 255)', 'click rectangle renders white')
  const dragged = (await draw(page, 'r', { x: 900, y: 150 }, { x: 1100, y: 290 })).find(item => item.id !== clicked.id)
  const draggedNode = await node(page, fileId, dragged.id)
  assert.deepEqual({ width: draggedNode.styles.width, height: draggedNode.styles.height }, { width: 200, height: 140 })
  assert.equal(draggedNode.appearance.fills[0].color.color.hex, '#ffffff')
  const frame = (await draw(page, 'f', { x: 300, y: 700 })).find(item => item.name === 'Frame')
  const frameNode = await node(page, fileId, frame.id)
  assert.deepEqual({ width: frameNode.styles.width, height: frameNode.styles.height }, { width: 320, height: 240 }, 'frame default unchanged')
  const shape = (await draw(page, 'o', { x: 700, y: 700 })).find(item => item.name === 'Shape')
  assert.equal((await node(page, fileId, shape.id)).appearance.fills[0].color.color.hex, '#d9d9d9', 'shape default unchanged')
  record('Rectangle click creates 500 x 500 white, drag keeps its size with white; frame and shape defaults unchanged')

  // 2. Blending: opacity, blend mode, and visibility render and omit defaults in storage.
  await selectLayer(page, clicked.id)
  await commitField(page, 'Opacity', 50)
  await rail(page).getByRole('combobox', { name: 'Blend mode', exact: true }).selectOption('multiply')
  await waitStyle(page, clicked.id, style => style.opacity === '0.5' && style.mixBlendMode === 'multiply', 'opacity and blend render')
  rect = await node(page, fileId, clicked.id)
  assert.deepEqual({ opacity: rect.appearance.opacity, blendMode: rect.appearance.blendMode }, { opacity: 0.5, blendMode: 'multiply' })
  await rail(page).getByRole('button', { name: 'Hide layer', exact: true }).click()
  await waitStyle(page, clicked.id, style => style.visibility === 'hidden', 'hidden layer')
  assert.equal((await node(page, fileId, clicked.id)).appearance.visible, false)
  await rail(page).getByRole('button', { name: 'Show layer', exact: true }).click()
  await waitStyle(page, clicked.id, style => style.visibility === 'visible', 'shown again')
  await commitField(page, 'Opacity', 100)
  await rail(page).getByRole('combobox', { name: 'Blend mode', exact: true }).selectOption('normal')
  await waitStyle(page, clicked.id, style => style.opacity === '1' && style.mixBlendMode === 'normal', 'defaults restored')
  rect = await node(page, fileId, clicked.id)
  assert.equal(rect.appearance.opacity, undefined, 'default opacity omitted'); assert.equal(rect.appearance.blendMode, undefined, 'default blend omitted'); assert.equal(rect.appearance.visible, undefined)
  record('Blending: opacity, mix blend mode, and visibility render; defaults are omitted from storage')

  // 3. Fills: + appends topmost, order renders bottom-to-top, hide reveals the fill below, remove deletes.
  await act(page, fileId, () => rail(page).getByRole('button', { name: 'Add fill', exact: true }).click())
  rect = await node(page, fileId, clicked.id)
  assert.equal(rect.appearance.fills.length, 2)
  assert.equal(rect.appearance.fills[1].color.color.hex, '#dddddd', 'the new topmost fill seeds #dddddd on a rectangle')
  await act(page, fileId, () => commitField(page, 'Fill 1 color', '#ff0000'))
  await waitStyle(page, clicked.id, style => style.backgroundImage.includes('rgb(255, 0, 0)') && style.backgroundColor === 'rgb(255, 255, 255)', 'top fill red as a layer over the white base')
  await act(page, fileId, () => rail(page).getByRole('button', { name: 'Hide fill 1', exact: true }).click())
  await waitStyle(page, clicked.id, style => !style.backgroundImage.includes('rgb(255, 0, 0)') && style.backgroundColor === 'rgb(255, 255, 255)', 'hidden top fill reveals white')
  rect = await node(page, fileId, clicked.id)
  assert.equal(rect.appearance.fills[1].visible, false, 'hidden fill keeps its data')
  await act(page, fileId, () => rail(page).getByRole('button', { name: 'Show fill 1', exact: true }).click())
  await rail(page).getByRole('button', { name: 'Reorder fill 1', exact: true }).focus()
  await act(page, fileId, () => page.keyboard.press('Alt+ArrowDown'))
  await waitStyle(page, clicked.id, style => style.backgroundColor === 'rgb(255, 0, 0)', 'red moved to the bottom becomes the base color')
  rect = await node(page, fileId, clicked.id)
  assert.deepEqual(rect.appearance.fills.map(fill => fill.color.color.hex), ['#ff0000', '#ffffff'])
  await shot(page, '01-two-fills')
  await act(page, fileId, () => rail(page).getByRole('button', { name: 'Remove fill 1', exact: true }).click())
  rect = await node(page, fileId, clicked.id)
  assert.deepEqual(rect.appearance.fills.map(fill => fill.color.color.hex), ['#ff0000'])
  record('Fills: add appends topmost, order renders bottom-to-top, hide keeps data, reorder and remove persist')

  // 4. Gradient type switch keeps cached state; stop drag commits once; Escape cancels with zero history.
  await act(page, fileId, () => rail(page).getByRole('radio', { name: 'Gradient', exact: true }).first().click())
  await waitStyle(page, clicked.id, style => style.backgroundImage.includes('gradient'), 'gradient renders')
  rect = await node(page, fileId, clicked.id)
  const gradient = rect.appearance.fills[0]
  assert.equal(gradient.type, 'gradient'); assert.equal(gradient.shape, 'linear'); assert.equal(gradient.interpolation, 'oklab'); assert.equal(gradient.stops.length, 2)
  assert.deepEqual(gradient.cache?.solid?.color.color.hex, '#ff0000', 'the solid is cached for switching back')
  await act(page, fileId, () => rail(page).getByRole('combobox', { name: 'Fill 1 gradient shape', exact: true }).selectOption('radial'))
  await waitStyle(page, clicked.id, style => style.backgroundImage.startsWith('radial-gradient'), 'radial renders')
  // Measuring history depth replays undo and redo, which saves; read revisions only after each measurement.
  const depthBefore = await historyDepth(page, fileId)
  const before = await revisionOf(page, fileId)
  const stop = rail(page).getByRole('slider', { name: 'Stop 1', exact: true })
  const box = await stop.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 5 })
  await page.keyboard.press('Escape'); await page.mouse.up()
  await page.waitForTimeout(300)
  assert.equal(await revisionOf(page, fileId), before, 'Escape during a stop drag changes nothing')
  assert.equal(await historyDepth(page, fileId), depthBefore, 'and records no history')
  const beforeDrag = await revisionOf(page, fileId)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 5 }); await page.mouse.up()
  await waitRevision(page, fileId, beforeDrag + 1)
  await page.waitForTimeout(400)
  assert.equal(await revisionOf(page, fileId), beforeDrag + 1, 'a committed drag is exactly one revision')
  assert.equal(await historyDepth(page, fileId), depthBefore + 1, 'and one undo step')
  rect = await node(page, fileId, clicked.id)
  assert.ok(rect.appearance.fills[0].stops[0].position > 0, 'the stop moved')
  await act(page, fileId, () => rail(page).getByRole('radio', { name: 'Solid', exact: true }).first().click())
  await waitStyle(page, clicked.id, style => style.backgroundColor === 'rgb(255, 0, 0)', 'switching back restores the cached solid')
  rect = await node(page, fileId, clicked.id)
  assert.equal(rect.appearance.fills[0].cache?.gradient?.shape, 'radial', 'the radial gradient is cached for switching back')
  record('Gradient: type conversion caches state both ways, shape switch renders, stop drag is one undo step and Escape is none')

  // 5. Outline and borders on a rectangle; text has neither section.
  await act(page, fileId, () => rail(page).getByRole('button', { name: 'Add outline', exact: true }).click())
  await waitStyle(page, clicked.id, style => style.outline.includes('solid') && style.outline.includes('1px') && style.outline.includes('rgb(0, 0, 0)'), 'outline renders black 1px solid')
  await commitField(page, 'Outline width', 3); await commitField(page, 'Outline offset', 4)
  await act(page, fileId, () => rail(page).getByRole('combobox', { name: 'Outline style', exact: true }).selectOption('dashed'))
  await waitStyle(page, clicked.id, style => style.outline.includes('dashed') && style.outline.includes('3px') && style.outlineOffset === '4px', 'outline edits render')
  rect = await node(page, fileId, clicked.id)
  assert.deepEqual({ width: rect.appearance.outline.width, offset: rect.appearance.outline.offset, style: rect.appearance.outline.style }, { width: 3, offset: 4, style: 'dashed' })
  const add = rail(page).getByRole('button', { name: 'Add border', exact: true })
  const bordersAfter = async () => { const current = await node(page, fileId, clicked.id); return current.appearance.borders ? Object.keys(current.appearance.borders).sort() : null }
  await act(page, fileId, () => add.click()); assert.deepEqual(await bordersAfter(), ['top'])
  await act(page, fileId, () => add.click()); assert.deepEqual(await bordersAfter(), ['bottom', 'top'])
  await act(page, fileId, () => add.click()); assert.deepEqual(await bordersAfter(), ['bottom', 'left', 'top'])
  await act(page, fileId, () => add.click()); assert.deepEqual(await bordersAfter(), ['bottom', 'left', 'right', 'top'])
  await act(page, fileId, () => add.click()); assert.deepEqual(await bordersAfter(), ['all'])
  await act(page, fileId, () => add.click()); assert.deepEqual(await bordersAfter(), ['bottom', 'left', 'right', 'top'])
  await act(page, fileId, () => rail(page).getByRole('button', { name: 'Remove left border', exact: true }).click())
  await waitStyle(page, clicked.id, style => style.borderLeft.startsWith('0px') && style.borderTop.includes('1px solid'), 'three sides render, left removed')
  assert.deepEqual(await bordersAfter(), ['bottom', 'right', 'top'])
  await shot(page, '02-outline-borders')
  const text = (await draw(page, 't', { x: 500, y: 450 })).find(item => item.name === 'Text')
  await selectLayer(page, text.id)
  assert.equal(await rail(page).getByText('Outline', { exact: true }).count(), 0, 'text has no Outline section')
  assert.equal(await rail(page).getByText('Border', { exact: true }).count(), 0, 'text has no Border section')
  await waitStyle(page, text.id, style => style.color === 'rgb(32, 33, 36)', 'one solid text fill maps to color')
  await act(page, fileId, () => rail(page).getByRole('radio', { name: 'Gradient', exact: true }).first().click())
  await waitStyle(page, text.id, style => style.color === 'rgba(0, 0, 0, 0)' && style.backgroundClip === 'text', 'gradient text clips a background with transparent color')
  record('Outline and the exact border + sequence render and persist; text exposes neither section and clips gradient fills')

  // 6. Mixed selection: one batch edit over several nodes is one undo step; structure-mixed fills offer replace.
  await selectLayer(page, clicked.id)
  await page.keyboard.down('Shift'); await selectLayer(page, dragged.id); await page.keyboard.up('Shift')
  assert.equal(await rail(page).getByText('Click to replace mixed fills').count(), 0, 'both rectangles have one solid fill: field-mixed, not structure-mixed')
  const depth = await historyDepth(page, fileId)
  await act(page, fileId, () => commitField(page, 'Opacity', 70))
  assert.equal((await node(page, fileId, clicked.id)).appearance.opacity, 0.7)
  assert.equal((await node(page, fileId, dragged.id)).appearance.opacity, 0.7)
  assert.equal(await historyDepth(page, fileId), depth + 1, 'a two-node edit is one undo step')
  await page.keyboard.down('Shift'); await selectLayer(page, text.id); await page.keyboard.up('Shift')
  await rail(page).getByText('Click to replace mixed fills').waitFor()
  assert.equal(await rail(page).getByText('Outline', { exact: true }).count(), 0, 'a selection containing text hides Outline')
  await shot(page, '03-mixed-selection')
  record('Mixed selections edit the common eligible subset in one batch and expose structure-mixed fills explicitly')

  // 7. Component roots: appearance overrides apply to the real element without wrappers and restore when removed.
  await page.keyboard.press('Escape')
  const expand = page.getByRole('button', { name: /Expand Components/ }); if (await expand.count()) await expand.click()
  await page.getByRole('button', { name: 'Add Button', exact: true }).click()
  await preview(page).locator('[data-preview-instance]').first().waitFor({ timeout: 20_000 })
  const instanceId = await preview(page).locator('[data-preview-instance]').first().getAttribute('data-preview-instance')
  const before7 = await styleOf(page, `[data-preview-instance="${instanceId}"]`)
  const tag = await preview(page).locator(`[data-preview-instance="${instanceId}"]`).evaluate(element => element.tagName + '|' + element.className + '|' + (element.parentElement?.getAttribute('data-preview-host') !== null ? 'host' : 'other'))
  await selectLayer(page, instanceId)
  await act(page, fileId, () => rail(page).getByRole('button', { name: 'Add fill', exact: true }).click())
  await act(page, fileId, () => commitField(page, 'Fill 1 color', '#00ff00'))
  await page.waitForTimeout(300)
  const during = await styleOf(page, `[data-preview-instance="${instanceId}"]`)
  assert.equal(during.backgroundColor, 'rgb(0, 255, 0)', 'the override paints the real component root')
  const tagAfter = await preview(page).locator(`[data-preview-instance="${instanceId}"]`).evaluate(element => element.tagName + '|' + element.className + '|' + (element.parentElement?.getAttribute('data-preview-host') !== null ? 'host' : 'other'))
  assert.equal(tagAfter, tag, 'same element, class, and parent: no wrapper')
  assert.equal(await preview(page).locator(`[data-preview-instance="${instanceId}"]`).innerText(), 'Button', 'component content intact')
  await act(page, fileId, () => rail(page).getByRole('button', { name: 'Remove fill 1', exact: true }).click())
  await page.waitForTimeout(400)
  const after7 = await styleOf(page, `[data-preview-instance="${instanceId}"]`)
  assert.equal(after7.backgroundColor, before7.backgroundColor, 'component-owned background restored')
  assert.equal(after7.inline, before7.inline, 'inline style restored byte for byte')
  await shot(page, '04-component-override-removed')
  record('Component appearance applies to the existing root without wrappers and restores component-owned styles on removal')

  // 8. Save and reopen retain everything; the editor appearance and preview theme stay independent of authored values.
  const saved = (await stored(page, fileId)).file
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  assert.deepEqual((await stored(page, fileId)).file.nodes[clicked.id].appearance, saved.nodes[clicked.id].appearance, 'rectangle appearance survives reopen')
  assert.deepEqual((await stored(page, fileId)).file.nodes[text.id].appearance, saved.nodes[text.id].appearance)
  await waitStyle(page, clicked.id, style => style.outline.includes('dashed') && style.outline.includes('3px') && style.borderRight.includes('1px solid') && style.backgroundColor === 'rgb(255, 0, 0)', 'reopened rectangle renders the same')
  const authored = await elementStyle(page, clicked.id)
  const combos = []
  for (const previewTheme of ['dark', 'default']) {
    await page.getByRole('combobox', { name: 'Canvas default theme' }).selectOption(previewTheme)
    for (const editorDark of [true, false]) {
      const isDark = await page.evaluate(() => document.querySelector('.editor-root')?.classList.contains('theme-dark'))
      if (isDark !== editorDark) await rail(page).getByRole('button', { name: /Switch editor appearance to/ }).click()
      await page.waitForTimeout(300)
      const style = await elementStyle(page, clicked.id)
      combos.push([previewTheme, editorDark, style.backgroundColor === authored.backgroundColor && style.outline === authored.outline && style.borderRight === authored.borderRight])
      await shot(page, `05-${previewTheme}-preview-${editorDark ? 'dark' : 'light'}-editor`)
    }
  }
  assert.ok(combos.every(([, , same]) => same), `authored appearance identical in every combination: ${JSON.stringify(combos)}`)
  record('Save and reopen retain blending, fills, outline, and borders; authored values are identical across all four editor and preview theme combinations')

  // 9. Protocol boundary: a hostile fill never reaches the renderer (negative control through the real iframe).
  const hostile = await page.evaluate(([key, id]) => {
    const record = JSON.parse(localStorage.getItem(key))
    record.file.nodes[id].appearance.fills[0].color = { kind: 'literal', color: { kind: 'hex', hex: 'url(https://evil.example/x)' } }
    localStorage.setItem(key, JSON.stringify(record))
    return record.file.nodes[id].appearance.fills[0].color.color.hex
  }, [contentKey(fileId), clicked.id])
  assert.equal(hostile, 'url(https://evil.example/x)')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText(/invalid|unchanged|could not/i).first().waitFor({ timeout: 20_000 }).catch(() => undefined)
  const bodyText = await page.locator('body').innerText()
  assert.ok(!bodyText.includes('rgb(255, 0, 0)') && /invalid|unchanged|could not|not valid/i.test(bodyText), 'a malformed stored file is refused instead of rendered')
  record('Malformed stored appearance is rejected by validation before it can reach the preview')
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
