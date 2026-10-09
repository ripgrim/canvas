// Token-bound color fields in the real editor: bound presentation, persistence, rename, theme changes, Edit token,
// Rebind, Unlink per effective theme, mixed selections, and unresolvable bindings. Requires the dev servers on 4317/4318.
//
// CC-TB-001 bound fields show the token, not an editable color.  CC-TB-002 the binding survives picker close, reselect
// and reopen.  CC-TB-003 rename updates the name, never the id.  CC-TB-004 the swatch follows each node's effective
// theme and the preview theme.  CC-TB-005 Unlink writes each node's own literal, alpha included, in one undo step.
// CC-TB-007 a missing token is shown as an error with no swatch and Unlink unavailable.  CC-TB-008 Rebind writes the
// token id on every selected node in one undo step.  CC-TB-011 mixed tokens and mixed sources.  CC-TB-012 Edit token
// opens the Theme tab on that token and writes nothing.  CC-TB-013 no-ops write nothing; unrelated undo keeps bindings.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const evidenceRoot = join(projectRoot, 'outputs', 'token-binding')
const editorUrl = 'http://127.0.0.1:4317/'
const indexKey = 'design-editor.browser-files-index.v3'
const contentKey = fileId => `design-editor.browser-file.${fileId}.v3`
const evidence = { status: 'failed', checks: [], screenshots: [], error: null }
let browser = null
let activePage = null
const record = (name, detail = '') => { evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log('✓', name, detail) }
const shot = async (page, name) => { await page.screenshot({ path: join(evidenceRoot, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }
const railShot = async (page, name) => { await page.locator('.right-rail').screenshot({ path: join(evidenceRoot, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }

const fileId = 'token-binding-file'
const hex = value => ({ kind: 'hex', hex: value })
const literal = value => ({ kind: 'literal', color: hex(value) })
const token = tokenId => ({ kind: 'token', tokenId })
const alias = tokenId => ({ kind: 'alias', tokenId })
const box = (id, name, left, top, appearance, extra = {}) => ({ id, type: 'rectangle', name, styles: { left, top, width: 80, height: 60 }, appearance, ...extra })
// A 66-link alias chain exceeds the engine's resolution depth, so `chain-1` cannot resolve even though every link exists.
const chainTokens = Object.fromEntries(Array.from({ length: 66 }, (_, index) => {
  const id = `chain-${index + 1}`
  return [id, { id, type: 'color', name: `Chain ${index + 1}`, orderKey: `y${index + 1}k`, value: index === 65 ? literal('#123456') : alias(`chain-${index + 2}`) }]
}))
const file = {
  schemaVersion: 5, fileId, revision: 1,
  pages: [{ id: 'page-1', name: 'Tokens', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'card-light': { id: 'card-light', type: 'component', name: 'Light card', componentId: 'sample-card', exportName: 'Card', props: {}, themeMode: 'light', appearance: { fills: [{ id: 'card-light-fill', type: 'solid', color: token('surface') }] } },
    'card-dark': { id: 'card-dark', type: 'component', name: 'Dark card', componentId: 'sample-card', exportName: 'Card', props: {}, themeMode: 'dark', appearance: { fills: [{ id: 'card-dark-fill', type: 'solid', color: token('surface') }] } },
    'rect-accent': box('rect-accent', 'Accent box', 520, 40, {
      fills: [{ id: 'accent-fill', type: 'solid', color: token('accent') }],
      outline: { color: token('brand'), width: 2, style: 'solid', offset: 0 },
      borders: { top: { color: token('accent'), width: 1, style: 'solid' }, left: { color: literal('#000000'), width: 1, style: 'solid' } },
    }),
    'rect-ink': box('rect-ink', 'Ink box', 620, 40, { fills: [{ id: 'ink-fill', type: 'solid', color: token('ink') }] }),
    'rect-literal': box('rect-literal', 'Literal box', 720, 40, { fills: [{ id: 'literal-fill', type: 'solid', color: literal('#ff0000') }] }),
    'rect-gradient': box('rect-gradient', 'Gradient box', 520, 140, { fills: [{ id: 'gradient-fill', type: 'gradient', shape: 'linear', angle: 90, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', stops: [{ id: 'stop-a', position: 0, color: token('accent') }, { id: 'stop-b', position: 1, color: literal('#ffffff') }] }] }),
    'rect-scrim': box('rect-scrim', 'Scrim box', 620, 140, { fills: [{ id: 'scrim-fill', type: 'solid', color: token('scrim') }] }),
    'rect-deep': box('rect-deep', 'Deep box', 720, 140, { fills: [{ id: 'deep-fill', type: 'solid', color: token('chain-1') }] }),
    'text-accent': { id: 'text-accent', type: 'text', name: 'Accent text', text: 'Bound text', styles: { left: 520, top: 240, width: 160, height: 24 }, appearance: { fills: [{ id: 'text-fill', type: 'solid', color: token('accent') }] } },
  },
  relationships: {
    'card-light': { parentId: 'root-1', orderKey: 'V' },
    'card-dark': { parentId: 'root-1', orderKey: 'W' },
    'rect-accent': { parentId: 'root-1', orderKey: 'X' },
    'rect-ink': { parentId: 'root-1', orderKey: 'Y' },
    'rect-literal': { parentId: 'root-1', orderKey: 'Z' },
    'rect-gradient': { parentId: 'root-1', orderKey: 'a' },
    'rect-scrim': { parentId: 'root-1', orderKey: 'b' },
    'rect-deep': { parentId: 'root-1', orderKey: 'c' },
    'text-accent': { parentId: 'root-1', orderKey: 'd' },
  },
  theme: { tokens: {
    accent: { id: 'accent', type: 'color', name: 'Accent', orderKey: 'V', value: literal('#7c3aed') },
    brand: { id: 'brand', type: 'color', name: 'Brand', orderKey: 'W', value: alias('accent') },
    surface: { id: 'surface', type: 'color', name: 'Surface', orderKey: 'X', value: { kind: 'source', property: '--surface', fallback: hex('#ffffff') } },
    ink: { id: 'ink', type: 'color', name: 'Ink', orderKey: 'Y', value: { kind: 'source', property: '--ink', fallback: hex('#202124') } },
    ...chainTokens,
    // Last in theme order, so Edit token has to scroll the list to reach it.
    scrim: { id: 'scrim', type: 'color', name: 'Scrim', orderKey: 'zz', value: literal('#11223380') },
  } },
}

const rail = page => page.locator('.right-rail')
const storedFile = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.file, contentKey(fileId))
const revisionOf = async page => (await storedFile(page)).revision
const waitRevision = (page, atLeast) => page.waitForFunction(([key, atLeast]) => (JSON.parse(localStorage.getItem(key) ?? 'null')?.file.revision ?? -1) >= atLeast, [contentKey(fileId), atLeast])
async function act(page, action) { const before = await revisionOf(page); await action(); await waitRevision(page, before + 1); return before + 1 }
const fillOf = async (page, id) => (await storedFile(page)).nodes[id].appearance.fills[0]
const waitEditor = async page => { await page.locator('.canvas-stage').waitFor({ timeout: 20_000 }); await page.locator('iframe[title="Canvas"]').waitFor(); await page.waitForTimeout(500) }
const sidebarTab = (page, name) => page.getByRole('tab', { name, exact: true })
async function selectLayer(page, id, additive = false) {
  if (additive) await page.keyboard.down('Shift')
  await page.getByRole('tree', { name: 'Layers' }).locator(`[data-instance-id="${id}"]`).click()
  if (additive) await page.keyboard.up('Shift')
  await page.waitForTimeout(200)
}
const field = (page, name) => rail(page).getByRole('group', { name, exact: true })
const chipOf = (page, name) => field(page, name).locator('.token-chip')
const contextOf = (page, name) => field(page, name).locator('.token-field-context')
const undoDisabled = page => page.locator('.canvas-floating-actions button[aria-label="Undo document edit"]').isDisabled()
async function historyDepth(page) {
  let steps = 0
  while (!(await undoDisabled(page)) && steps < 50) { await page.keyboard.press('Control+z'); await page.waitForTimeout(120); steps += 1 }
  for (let index = 0; index < steps; index++) { await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(120) }
  await page.waitForTimeout(300)
  return steps
}
/** Holds the page long enough for any save to land, then proves nothing was written. */
async function assertNoWrite(page, before, label) { await page.waitForTimeout(600); assert.equal(await revisionOf(page), before, label) }

async function run() {
  await mkdir(evidenceRoot, { recursive: true })
  assert.ok(await fetch(editorUrl).then(response => response.ok).catch(() => false), 'editor dev server must be running on 4317')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1, colorScheme: 'light' })
  const page = await context.newPage()
  activePage = page
  page.on('pageerror', error => { evidence.error = `Page error: ${error.message}` })
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(([indexKey, contentKey, content, id]) => {
    localStorage.clear()
    localStorage.setItem(indexKey, JSON.stringify({ schemaVersion: 1, files: { [id]: { id, name: 'Token binding', createdAt: 1, updatedAt: 1 } } }))
    localStorage.setItem(contentKey, content)
  }, [indexKey, contentKey(fileId), JSON.stringify({ schemaVersion: 1, file }), fileId])
  await page.goto(`${editorUrl}file/${fileId}`, { waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  await page.getByRole('tree', { name: 'Layers' }).locator('[data-instance-id="rect-accent"]').waitFor({ timeout: 20_000 })

  // CC-TB-001: the bound fill shows the token chip and read-only context; nothing editable can detach it.
  await selectLayer(page, 'rect-accent')
  await field(page, 'Fill 1 color: Accent token, #7C3AED, 100% opacity').waitFor()
  assert.equal(await chipOf(page, 'Fill 1 color: Accent token, #7C3AED, 100% opacity').innerText(), 'Accent')
  assert.equal(await contextOf(page, 'Fill 1 color: Accent token, #7C3AED, 100% opacity').innerText(), '#7C3AED · 100%')
  assert.equal(await rail(page).getByRole('textbox', { name: 'Fill 1 color', exact: true }).count(), 0, 'no editable hex while bound')
  assert.equal(await rail(page).getByRole('textbox', { name: 'Fill 1 opacity', exact: true }).count(), 0, 'no separate alpha control while bound')
  assert.equal(await rail(page).getByRole('button', { name: 'Edit Fill 1 color', exact: true }).count(), 0, 'no color picker while bound')
  for (const name of ['Unlink fill 1 color', 'Edit token Accent from fill 1 color']) await rail(page).getByRole('button', { name, exact: true }).waitFor()
  await rail(page).getByRole('combobox', { name: 'Rebind fill 1 color', exact: true }).waitFor()
  // Alias outline: the alias token's own name, with its target as context.
  assert.equal(await chipOf(page, 'Outline color: Brand token, Alias to Accent, #7C3AED, 100% opacity').innerText(), 'Brand')
  assert.equal(await contextOf(page, 'Outline color: Brand token, Alias to Accent, #7C3AED, 100% opacity').innerText(), 'Alias to Accent')
  // Border rows: the bound side shows the chip, the literal side keeps its editable field.
  await field(page, 'Top border color: Accent token, #7C3AED, 100% opacity').waitFor()
  await rail(page).getByRole('textbox', { name: 'Left border color', exact: true }).waitFor()
  await railShot(page, '01-bound-fill-outline-border')
  await selectLayer(page, 'rect-gradient')
  assert.equal(await chipOf(page, 'Stop 1 color: Accent token, #7C3AED, 100% opacity').innerText(), 'Accent')
  await rail(page).getByRole('button', { name: 'Unlink stop 1 color', exact: true }).waitFor()
  await selectLayer(page, 'text-accent')
  await field(page, 'Fill 1 color: Accent token, #7C3AED, 100% opacity').waitFor()
  await selectLayer(page, 'rect-scrim')
  assert.equal(await contextOf(page, 'Fill 1 color: Scrim token, #112233, 50% opacity').innerText(), '#112233 · 50%', 'alpha is read-only context')
  record('CC-TB-001: bound fills, stops, text fills, outline (alias) and border sides show the token chip and read-only context; no editable color, alpha or picker')

  // CC-TB-004: the same Surface token resolves in each Card's own effective theme.
  await selectLayer(page, 'card-light')
  await field(page, 'Fill 1 color: Surface token, #FFFFFF, 100% opacity').scrollIntoViewIfNeeded()
  await shot(page, '02-bound-light-context')
  await railShot(page, '02-bound-light-context-rail')
  await selectLayer(page, 'card-dark')
  await field(page, 'Fill 1 color: Surface token, #242427, 100% opacity').scrollIntoViewIfNeeded()
  await shot(page, '03-bound-dark-context')
  // The same field in the dark editor appearance, to check the atoms against both editor themes.
  await page.getByRole('button', { name: 'Switch editor appearance to dark', exact: true }).click()
  await page.waitForTimeout(300)
  await railShot(page, '03-bound-dark-context-dark-editor')
  await page.getByRole('button', { name: 'Switch editor appearance to light', exact: true }).click()
  await page.waitForTimeout(300)
  await railShot(page, '03-bound-dark-context-rail')
  // A node that inherits follows the preview theme; the stored id never changes.
  await selectLayer(page, 'rect-ink')
  await field(page, 'Fill 1 color: Ink token, #202124, 100% opacity').waitFor()
  const beforeTheme = await storedFile(page)
  await page.getByRole('combobox', { name: 'Canvas default theme' }).selectOption('dark')
  await field(page, 'Fill 1 color: Ink token, #EEEEEF, 100% opacity').waitFor()
  assert.deepEqual((await storedFile(page)).nodes['rect-ink'].appearance, beforeTheme.nodes['rect-ink'].appearance, 'theme change keeps the binding')
  await page.getByRole('combobox', { name: 'Canvas default theme' }).selectOption('default')
  await field(page, 'Fill 1 color: Ink token, #202124, 100% opacity').waitFor()
  record('CC-TB-004: Surface shows #FFFFFF on the light Card and #242427 on the dark Card; Ink follows the preview theme with its id unchanged')

  // CC-TB-012: Edit token selects and reveals the token in the Theme tab and writes nothing.
  await selectLayer(page, 'rect-scrim')
  const beforeEdit = await revisionOf(page)
  await rail(page).getByRole('button', { name: 'Edit token Scrim from fill 1 color', exact: true }).click()
  await page.waitForTimeout(300)
  const tabSwitched = (await sidebarTab(page, 'Theme').getAttribute('aria-selected')) === 'true'
  if (!tabSwitched) await sidebarTab(page, 'Theme').click()
  const scrimRow = page.getByRole('listbox', { name: 'Color tokens' }).getByRole('option', { name: /^Scrim, / })
  await scrimRow.waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Scrim, ') === true)
  assert.equal(await scrimRow.getAttribute('aria-selected'), 'true', 'the requested token is selected')
  const inView = await scrimRow.evaluate(row => { const list = row.closest('[role="listbox"]')?.parentElement ?? document.body; let scroller = row.parentElement; while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement; const area = (scroller ?? list).getBoundingClientRect(); const box = row.getBoundingClientRect(); return box.top >= area.top - 1 && box.bottom <= area.bottom + 1 && (scroller?.scrollTop ?? 0) > 0 })
  assert.ok(inView, 'the requested row was scrolled into view')
  await assertNoWrite(page, beforeEdit, 'Edit token writes nothing')
  await shot(page, '04-edit-token-theme-tab')
  record('CC-TB-012: Edit token selects, focuses and scrolls to Scrim in the Theme tab without writing', tabSwitched ? 'tab switched by the request' : 'tab switch pending the Editor.tsx change; opened by hand')

  // CC-TB-003: rename updates the visible name; the stored binding keeps the id.
  const accentRow = page.getByRole('listbox', { name: 'Color tokens' }).getByRole('option', { name: /^Accent, / })
  await accentRow.scrollIntoViewIfNeeded()
  await accentRow.click()
  const tokenName = page.getByRole('textbox', { name: 'Token name', exact: true })
  await act(page, async () => { await tokenName.click(); await tokenName.fill('Violet'); await tokenName.press('Enter') })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await sidebarTab(page, 'Design').click()
  await selectLayer(page, 'rect-accent')
  assert.equal(await chipOf(page, 'Fill 1 color: Violet token, #7C3AED, 100% opacity').innerText(), 'Violet')
  assert.equal(await contextOf(page, 'Outline color: Brand token, Alias to Violet, #7C3AED, 100% opacity').innerText(), 'Alias to Violet')
  const renamed = await storedFile(page)
  assert.deepEqual(renamed.nodes['rect-accent'].appearance.fills[0].color, { kind: 'token', tokenId: 'accent' })
  assert.equal(renamed.theme.tokens.accent.name, 'Violet')
  record('CC-TB-003: renaming Accent to Violet updates the chip and alias context; the fill still stores tokenId accent')

  // CC-TB-002: the binding survives a picker opened and closed on a sibling stop, reselection, and reopening.
  await selectLayer(page, 'rect-gradient')
  await rail(page).getByRole('slider', { name: 'Stop 2', exact: true }).click()
  await rail(page).getByRole('button', { name: 'Edit Stop 2 color', exact: true }).click()
  await page.locator('.color-picker-popup').waitFor()
  await page.locator('.color-picker-close').click()
  await page.locator('.color-picker-popup').waitFor({ state: 'detached' })
  await rail(page).getByRole('slider', { name: 'Stop 1', exact: true }).click()
  assert.equal(await chipOf(page, 'Stop 1 color: Violet token, #7C3AED, 100% opacity').innerText(), 'Violet')
  assert.equal(await page.locator('.color-picker-popup').count(), 0, 'opening a bound stop does not open a picker')
  await selectLayer(page, 'rect-literal')
  await selectLayer(page, 'rect-accent')
  await field(page, 'Fill 1 color: Violet token, #7C3AED, 100% opacity').waitFor()
  const beforeReload = await storedFile(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  await selectLayer(page, 'rect-accent')
  await field(page, 'Fill 1 color: Violet token, #7C3AED, 100% opacity').waitFor()
  assert.deepEqual((await storedFile(page)).nodes, beforeReload.nodes, 'reopening rewrites nothing')
  record('CC-TB-002: the binding stays visible after a picker closes on another stop, after reselecting, and after reopening the file')

  // CC-TB-013: an unrelated edit and its undo keep the binding; rebinding to the same token writes nothing.
  await act(page, async () => { const opacity = rail(page).getByRole('textbox', { name: 'Opacity', exact: true }); await opacity.click(); await opacity.fill('50'); await opacity.press('Enter') })
  await act(page, () => page.keyboard.press('Control+z'))
  await field(page, 'Fill 1 color: Violet token, #7C3AED, 100% opacity').waitFor()
  assert.deepEqual((await fillOf(page, 'rect-accent')).color, { kind: 'token', tokenId: 'accent' })
  const beforeNoop = await revisionOf(page)
  await rail(page).getByRole('combobox', { name: 'Rebind fill 1 color', exact: true }).selectOption({ label: 'Violet' })
  await assertNoWrite(page, beforeNoop, 'rebinding to the bound token writes nothing')
  record('CC-TB-013: unrelated undo keeps the binding; a no-op Rebind writes nothing')

  // CC-TB-011 and CC-TB-008: different tokens read as Mixed tokens; Rebind all writes the id on both nodes as one step.
  await selectLayer(page, 'rect-ink', true)
  await field(page, 'Fill 1 color: Mixed tokens').waitFor()
  await rail(page).getByRole('button', { name: 'Unlink fill 1 color on every layer', exact: true }).waitFor()
  assert.equal(await rail(page).getByRole('button', { name: /^Edit token .* from fill 1 color$/ }).count(), 0, 'no single fill token to edit')
  await railShot(page, '05-mixed-tokens')
  const depthBefore = await historyDepth(page)
  const outlineBefore = (await storedFile(page)).nodes['rect-accent'].appearance.outline
  await act(page, () => rail(page).getByRole('combobox', { name: 'Rebind fill 1 color on every layer', exact: true }).selectOption({ label: 'Scrim' }))
  let stored = await storedFile(page)
  assert.deepEqual(stored.nodes['rect-accent'].appearance.fills[0], { id: 'accent-fill', type: 'solid', color: { kind: 'token', tokenId: 'scrim' } })
  assert.deepEqual(stored.nodes['rect-ink'].appearance.fills[0], { id: 'ink-fill', type: 'solid', color: { kind: 'token', tokenId: 'scrim' } })
  assert.deepEqual(stored.nodes['rect-accent'].appearance.outline, outlineBefore, 'other slots untouched')
  await field(page, 'Fill 1 color: Scrim token, #112233, 50% opacity').waitFor()
  assert.equal(await historyDepth(page), depthBefore + 1, 'Rebind all is one undo step')
  await act(page, () => page.keyboard.press('Control+z'))
  await field(page, 'Fill 1 color: Mixed tokens').waitFor()
  record('CC-TB-011 and CC-TB-008: two tokens show Mixed tokens; Rebind all stores tokenId scrim on both fills in one undo step')

  // CC-TB-011: a token with a literal reads as Mixed sources; Unlink detaches the bound entry and keeps the literal.
  await selectLayer(page, 'rect-accent')
  await selectLayer(page, 'rect-literal', true)
  await field(page, 'Fill 1 color: Mixed sources').waitFor()
  await railShot(page, '06-mixed-sources')
  const depthSources = await historyDepth(page)
  await act(page, () => rail(page).getByRole('button', { name: 'Unlink fill 1 color on every layer', exact: true }).click())
  stored = await storedFile(page)
  assert.deepEqual(stored.nodes['rect-accent'].appearance.fills[0].color, { kind: 'literal', color: { kind: 'hex', hex: '#7c3aed' } })
  assert.deepEqual(stored.nodes['rect-literal'].appearance.fills[0].color, { kind: 'literal', color: { kind: 'hex', hex: '#ff0000' } })
  assert.equal(await historyDepth(page), depthSources + 1, 'Unlink is one undo step')
  await act(page, () => page.keyboard.press('Control+z'))
  record('CC-TB-011: token plus literal shows Mixed sources; Unlink resolves the bound entry and keeps the literal')

  // CC-TB-005: Unlink on both Cards writes each one's own theme literal; alpha survives exactly.
  await selectLayer(page, 'card-light')
  await selectLayer(page, 'card-dark', true)
  await field(page, 'Fill 1 color: Surface token, Varies by theme').scrollIntoViewIfNeeded()
  await railShot(page, '07-varies-by-theme')
  const depthCards = await historyDepth(page)
  await act(page, () => rail(page).getByRole('button', { name: 'Unlink fill 1 color', exact: true }).click())
  stored = await storedFile(page)
  assert.deepEqual(stored.nodes['card-light'].appearance.fills[0], { id: 'card-light-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#ffffff' } } })
  assert.deepEqual(stored.nodes['card-dark'].appearance.fills[0], { id: 'card-dark-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#242427' } } })
  assert.equal(await historyDepth(page), depthCards + 1, 'one undo step for both Cards')
  await act(page, () => page.keyboard.press('Control+z'))
  await selectLayer(page, 'rect-scrim')
  await act(page, () => rail(page).getByRole('button', { name: 'Unlink fill 1 color', exact: true }).click())
  assert.deepEqual((await fillOf(page, 'rect-scrim')).color, { kind: 'literal', color: { kind: 'hex', hex: '#11223380' } }, 'eight-digit hex kept exactly')
  await rail(page).getByRole('textbox', { name: 'Fill 1 opacity', exact: true }).waitFor()
  assert.equal(await rail(page).getByRole('textbox', { name: 'Fill 1 opacity', exact: true }).inputValue(), '50')
  record('CC-TB-005: Unlink writes #ffffff for the light Card and #242427 for the dark Card in one undo step; Scrim unlinks to #11223380')

  // CC-TB-007: a missing token (only reachable as a live override; stored files reject it) shows an error and no swatch.
  await selectLayer(page, 'rect-literal')
  const storeUrl = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/features\/editor\/document-store\.ts(\?|$)/.test(name)) ?? null)
  assert.ok(storeUrl, 'the document store module is loaded')
  await page.evaluate(async url => {
    const { documentStore } = await import(url)
    const node = documentStore.getSnapshot().file.nodes['rect-literal']
    documentStore.commands.appearance.gesture.begin()
    documentStore.commands.appearance.gesture.preview({ 'rect-literal': { ...node.appearance, fills: [{ ...node.appearance.fills[0], color: { kind: 'token', tokenId: 'ghost-token' } }] } })
  }, storeUrl)
  const missing = field(page, 'Fill 1 color: Missing token: ghost-token')
  await missing.waitFor()
  assert.equal(await missing.innerText(), 'Missing token: ghost-token')
  assert.equal(await missing.locator('.token-field-swatch').count(), 0, 'no fabricated swatch')
  const unlinkMissing = rail(page).getByRole('button', { name: 'Unlink fill 1 color', exact: true })
  assert.equal(await unlinkMissing.getAttribute('aria-disabled'), 'true')
  assert.equal(await unlinkMissing.getAttribute('title'), 'Unlink needs a token that resolves to a color')
  assert.equal(await rail(page).getByRole('button', { name: /^Edit token .* from fill 1 color$/ }).count(), 0, 'nothing to edit for a missing token')
  const beforeMissing = await revisionOf(page)
  await unlinkMissing.click({ force: true })
  await assertNoWrite(page, beforeMissing, 'Unlink on a missing token writes nothing')
  await railShot(page, '08-missing-token')
  await act(page, () => rail(page).getByRole('combobox', { name: 'Rebind fill 1 color', exact: true }).selectOption({ label: 'Ink' }))
  assert.deepEqual((await fillOf(page, 'rect-literal')).color, { kind: 'token', tokenId: 'ink' }, 'Rebind repairs the missing binding')
  await selectLayer(page, 'rect-deep')
  const deep = field(page, 'Fill 1 color: Chain 1 alias chain is too long')
  await deep.waitFor()
  assert.equal(await deep.locator('.token-field-swatch').count(), 0)
  assert.equal(await rail(page).getByRole('button', { name: 'Unlink fill 1 color', exact: true }).getAttribute('aria-disabled'), 'true')
  await rail(page).getByRole('button', { name: 'Edit token Chain 1 from fill 1 color', exact: true }).waitFor()
  assert.deepEqual((await fillOf(page, 'rect-deep')).color, { kind: 'token', tokenId: 'chain-1' }, 'no silent detach')
  await railShot(page, '09-unresolved-token')
  record('CC-TB-007: Missing token: ghost-token shows no swatch, Unlink is unavailable with a reason and writes nothing, Rebind repairs it; a too-deep alias chain is an error with Edit token')

  assert.ok(tabSwitched, 'Edit token must switch the sidebar to the Theme tab (needs Library in Editor.tsx to derive its view from themeFocus)')
  record('CC-TB-012: Edit token switched the sidebar to the Theme tab')
  if (evidence.error) throw new Error(evidence.error)
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
