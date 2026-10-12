// Per-node theme in the real editor against a seeded v6 file: the Theme row (segments, icons, accessible inheritance,
// and the visible mixed-mode line),
// radio semantics and keyboard, one undo step for a multi-selection, the preview stamping `data-theme` on the Card's own
// root while the document root keeps the light canvas default, and independence from the editor appearance. Expected
// colors come from the bundled sample stylesheet (`:root` --surface #ffffff, `[data-theme='dark']` --surface #242427).
// Requires the dev servers on 4317/4318.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const evidenceRoot = join(projectRoot, 'outputs', 'node-theme')
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
const themeSection = page => rail(page).locator('[data-section="theme"]')
const themeGroup = page => themeSection(page).getByRole('radiogroup')
const radio = (page, name) => themeGroup(page).getByRole('radio', { name, exact: true })
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), contentKey(fileId))
const revisionOf = async page => (await stored(page)).file.revision
const storedMode = async (page, id) => (await stored(page)).file.nodes[id].themeMode ?? 'inherit'
const waitRevision = (page, atLeast) => page.waitForFunction(([key, atLeast]) => (JSON.parse(localStorage.getItem(key) ?? 'null')?.file.revision ?? -1) >= atLeast, [contentKey(fileId), atLeast], { timeout: 10_000 })
const blur = page => page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
/** Runs one editing action and waits until its save lands; returns the new revision. */
async function act(page, action) { const before = await revisionOf(page); await action(); await waitRevision(page, before + 1); await page.waitForTimeout(250); return revisionOf(page) }
async function selectLayer(page, id, modifiers = []) { await page.getByRole('tree', { name: 'Layers' }).locator(`[data-instance-id="${id}"]`).click({ modifiers }); await page.waitForTimeout(250) }
const checkedRadios = page => themeGroup(page).locator('[role="radio"][aria-checked="true"]').evaluateAll(radios => radios.map(radio => radio.getAttribute('aria-label')))
const radioStates = page => themeGroup(page).locator('[role="radio"]').evaluateAll(radios => radios.map(radio => ({ name: radio.getAttribute('aria-label'), checked: radio.getAttribute('aria-checked'), tabIndex: radio.tabIndex, disabled: radio.getAttribute('aria-disabled'), icon: Boolean(radio.querySelector('svg.icon[aria-hidden="true"]')), text: radio.innerText.trim() })))
const focusState = page => page.evaluate(() => {
  const active = document.activeElement
  const style = active ? getComputedStyle(active) : null
  return { name: active?.getAttribute('aria-label') ?? null, role: active?.getAttribute('role') ?? null, focusVisible: active?.matches(':focus-visible') ?? false, outline: style ? `${style.outlineStyle} ${style.outlineWidth}` : null }
})
const previewCard = (page, id) => preview(page).locator(`[data-preview-instance="${id}"]`).evaluate(element => ({ theme: element.getAttribute('data-theme'), scheme: element.style.colorScheme, background: getComputedStyle(element).backgroundColor }))
const previewRoot = page => preview(page).locator('html').evaluate(root => ({ theme: root.getAttribute('data-theme'), surface: getComputedStyle(root).getPropertyValue('--surface').trim() }))
async function waitCard(page, id, predicate, label) {
  let last = null
  for (let attempt = 0; attempt < 80; attempt++) { last = await previewCard(page, id).catch(() => null); if (last && predicate(last)) return last; await page.waitForTimeout(100) }
  assert.fail(`${label}: ${JSON.stringify(last)}`)
}
const editorDark = page => page.evaluate(() => document.querySelector('.editor-root')?.classList.contains('theme-dark') ?? null)

const fileId = 'node-theme-file'
const literal = hex => ({ kind: 'literal', color: { kind: 'hex', hex } })
/** Login card (inherit) with two Labels, Promo card stored Dark with one Label, and a free rectangle. */
const file = {
  schemaVersion: 9, fileId, revision: 2,
  pages: [{ id: 'page-1', name: 'Themes', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    card: { id: 'card', type: 'component', name: 'Login card', componentId: 'sample-card', exportName: 'Card', props: {} },
    'label-a': { id: 'label-a', type: 'component', name: 'Email label', componentId: 'sample-label', exportName: 'Label', props: { children: 'Email' } },
    'label-b': { id: 'label-b', type: 'component', name: 'Password label', componentId: 'sample-label', exportName: 'Label', props: { children: 'Password' } },
    promo: { id: 'promo', type: 'component', name: 'Promo card', componentId: 'sample-card', exportName: 'Card', props: {}, themeMode: 'dark' },
    'label-c': { id: 'label-c', type: 'component', name: 'Promo label', componentId: 'sample-label', exportName: 'Label', props: { children: 'Offer' } },
    box: { id: 'box', type: 'rectangle', name: 'Box', styles: { left: 480, top: 0, width: 120, height: 80 }, appearance: { fills: [{ id: 'box-fill', type: 'solid', color: literal('#d9d9d9') }] } },
  },
  relationships: {
    card: { parentId: 'root-1', orderKey: 'V' },
    'label-a': { parentId: 'card', orderKey: 'V', slot: 'children' },
    'label-b': { parentId: 'card', orderKey: 'W', slot: 'children' },
    promo: { parentId: 'root-1', orderKey: 'W' },
    'label-c': { parentId: 'promo', orderKey: 'V', slot: 'children' },
    box: { parentId: 'root-1', orderKey: 'X' },
  },
  theme: { tokens: {} },
}

async function seed(page) {
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(([indexKey, contentKey, content, id]) => {
    localStorage.clear()
    localStorage.setItem(indexKey, JSON.stringify({ schemaVersion: 1, files: { [id]: { id, name: 'Node themes', createdAt: 1, updatedAt: 1 } } }))
    localStorage.setItem(contentKey, content)
  }, [indexKey, contentKey(fileId), JSON.stringify({ schemaVersion: 1, file }), fileId])
}
async function open(page) {
  await page.goto(`${editorUrl}file/${fileId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.canvas-stage').waitFor({ timeout: 20_000 })
  await page.locator('iframe[title="Canvas"]').waitFor()
  await preview(page).locator('[data-preview-instance="label-c"]').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(800)
}

async function run() {
  await mkdir(evidenceRoot, { recursive: true })
  assert.ok(await fetch(editorUrl).then(response => response.ok).catch(() => false), 'editor dev server must be running on 4317')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'light' })
  const page = await context.newPage()
  activePage = page
  page.on('pageerror', error => { evidence.error = `Page error: ${error.message}` })
  await seed(page)
  await open(page)
  assert.equal(await editorDark(page), false, 'the editor chrome starts light')

  // 1. CC-NT-017: the Theme row for a Card that inherits the light canvas default.
  await selectLayer(page, 'card')
  await themeSection(page).waitFor()
  assert.deepEqual(await radioStates(page), [
    { name: 'Inherit', checked: 'true', tabIndex: 0, disabled: null, icon: false, text: 'Inherit' },
    { name: 'Light', checked: 'false', tabIndex: -1, disabled: null, icon: true, text: 'Light' },
    { name: 'Dark', checked: 'false', tabIndex: -1, disabled: null, icon: true, text: 'Dark' },
  ])
  await expect(themeGroup(page)).toHaveAccessibleName('Theme. Inherited: Light from canvas default')
  await expect(themeSection(page)).not.toContainText('Inherited: Light from canvas default')
  record('CC-NT-017: Theme row shows Inherit, Light with sun and Dark with moon; inheritance remains accessible without a visible helper line')
  await shot(themeSection(page), 'theme-row-light')

  // 2. CC-NT-018: same stored Inherit with different effective themes (Email label is light, Promo label inherits dark).
  await selectLayer(page, 'label-a')
  await selectLayer(page, 'label-c', ['Control'])
  assert.deepEqual(await checkedRadios(page), ['Inherit'])
  await expect(themeGroup(page)).toHaveAccessibleName('Theme. Effective themes: Mixed')
  await expect(themeSection(page)).not.toContainText('Effective themes: Mixed')
  record('CC-NT-018: same stored Inherit with different effective themes keeps Inherit checked and exposes the effective mix accessibly')
  await shot(themeSection(page), 'theme-row-effective-mixed')

  // 3. CC-NT-018: different stored modes (Login card inherit, Promo card dark) check nothing and describe the mix.
  await selectLayer(page, 'card')
  await selectLayer(page, 'promo', ['Control'])
  assert.deepEqual(await checkedRadios(page), [])
  await expect(themeGroup(page)).toHaveAccessibleDescription('Mixed theme modes')
  await expect(themeSection(page)).toContainText('Mixed theme modes')
  assert.deepEqual((await radioStates(page)).map(state => state.tabIndex), [0, -1, -1], 'the first enabled option is the tab stop while mixed')
  record('CC-NT-018: mixed stored modes show no checked radio and the Mixed theme modes description')
  await shot(themeSection(page), 'theme-row-mixed')

  // 4. CC-NT-020: three layers of mixed kinds set to Light in one revision; one Ctrl+Z restores all three.
  await selectLayer(page, 'box', ['Control'])
  assert.equal(await rail(page).getByRole('heading', { name: '3 layers selected' }).count(), 1)
  const beforeMulti = await stored(page)
  const multiRevision = await act(page, () => radio(page, 'Light').click())
  assert.equal(multiRevision, beforeMulti.file.revision + 1, 'one revision for three layers')
  assert.deepEqual(await Promise.all(['card', 'promo', 'box'].map(id => storedMode(page, id))), ['light', 'light', 'light'])
  assert.deepEqual(await checkedRadios(page), ['Light'])
  await blur(page)
  await act(page, () => page.keyboard.press('Control+z'))
  const undone = await stored(page)
  assert.deepEqual(undone.file.nodes, beforeMulti.file.nodes, 'one undo step returns every node to the stored content before the change')
  assert.deepEqual(await checkedRadios(page), [])
  await act(page, () => page.keyboard.press('Control+Shift+z'))
  assert.deepEqual(await Promise.all(['card', 'promo', 'box'].map(id => storedMode(page, id))), ['light', 'light', 'light'], 'redo reapplies all three')
  await blur(page)
  await act(page, () => page.keyboard.press('Control+z'))
  assert.deepEqual((await stored(page)).file.nodes, beforeMulti.file.nodes)
  record('CC-NT-020: multi-select applies to all three layers in one revision; one Ctrl+Z restores them and redo reapplies')

  // 5. CC-NT-017: Dark on the Login card survives reselection and reload; its label shows where Dark comes from.
  await selectLayer(page, 'card')
  await act(page, () => radio(page, 'Dark').click())
  assert.equal(await storedMode(page, 'card'), 'dark')
  await selectLayer(page, 'label-a')
  assert.deepEqual(await checkedRadios(page), ['Inherit'])
  await expect(themeGroup(page)).toHaveAccessibleName('Theme. Inherited: Dark from Login card')
  await expect(themeSection(page)).not.toContainText('Inherited: Dark from Login card')
  await shot(themeSection(page), 'theme-row-dark')
  await selectLayer(page, 'card')
  assert.deepEqual(await checkedRadios(page), ['Dark'])
  await expect(themeGroup(page)).toHaveAccessibleName('Theme')
  assert.equal(await themeGroup(page).getAttribute('aria-describedby'), null, 'an explicit mode has no inherited line')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await open(page)
  assert.equal(await storedMode(page, 'card'), 'dark', 'the stored mode survives reload')
  await selectLayer(page, 'card')
  assert.deepEqual(await checkedRadios(page), ['Dark'])
  record('CC-NT-017: Dark is stored, checked after reselect and after reload; Email label reads Inherited: Dark from Login card')

  // 6. CC-NT-010: the Card's own root carries data-theme="dark" and renders the dark surface; the document root stays light.
  const darkCard = await waitCard(page, 'card', state => state.theme === 'dark', 'Login card root gets data-theme="dark"')
  assert.deepEqual(darkCard, { theme: 'dark', scheme: 'dark', background: 'rgb(36, 36, 39)' })
  assert.deepEqual(await previewRoot(page), { theme: null, surface: '#ffffff' }, 'the preview document root keeps the light canvas default')
  const labelTheme = await preview(page).locator('[data-preview-instance="label-a"]').evaluate(element => ({ own: element.getAttribute('data-theme'), nearest: element.parentElement?.closest('[data-theme]')?.getAttribute('data-preview-instance') ?? null, html: element.parentElement?.outerHTML.slice(0, 400) }))
  assert.equal(labelTheme.own, null, `the inheriting label is not stamped itself: ${labelTheme.html}`)
  assert.equal(labelTheme.nearest, 'card', 'the nearest themed ancestor of the label is the Card root itself')
  record('CC-NT-010: Login card root has data-theme="dark" and background rgb(36, 36, 39) while the document root keeps the light fallback')

  // 7. CC-NT-008: switching the editor appearance changes neither the preview root nor the Card.
  const rootBefore = await previewRoot(page)
  const cardBefore = await previewCard(page, 'card')
  await rail(page).getByRole('button', { name: /Switch editor appearance to/ }).click()
  await page.waitForFunction(() => document.querySelector('.editor-root')?.classList.contains('theme-dark'))
  await page.waitForTimeout(600)
  assert.deepEqual(await previewRoot(page), rootBefore, 'editor appearance leaves the preview root alone')
  assert.deepEqual(await previewCard(page, 'card'), cardBefore, 'editor appearance leaves the Card alone')
  assert.deepEqual(await checkedRadios(page), ['Dark'])
  await shot(themeSection(page), 'theme-row-dark-editor-chrome')
  await rail(page).getByRole('button', { name: /Switch editor appearance to/ }).click()
  await page.waitForFunction(() => document.querySelector('.editor-root')?.classList.contains('theme-light'))
  assert.deepEqual(await previewRoot(page), rootBefore)
  record('CC-NT-008: toggling the editor appearance keeps the preview root (no data-theme, --surface #ffffff) and the Card (dark)')

  // 8. CC-NT-019: radio semantics and keyboard on the Login card (stored Dark).
  assert.equal(await themeSection(page).getByRole('radiogroup').count(), 1)
  assert.deepEqual((await radioStates(page)).map(state => [state.checked, state.tabIndex]), [['false', -1], ['false', -1], ['true', 0]], 'the checked option is the only tab stop')
  await radio(page, 'Dark').focus()
  let revision = await act(page, () => page.keyboard.press('ArrowLeft'))
  assert.equal(await storedMode(page, 'card'), 'light', 'ArrowLeft selects Light and writes the file')
  let focus = await focusState(page)
  assert.equal(focus.name, 'Light')
  assert.equal(focus.focusVisible, true, 'keyboard focus is visible')
  assert.notEqual(focus.outline.split(' ')[0], 'none', `focused option draws the focus ring: ${focus.outline}`)
  const checkedUnfocused = await radio(page, 'Light').evaluate(element => { element.blur(); const style = getComputedStyle(element); return `${style.outlineStyle}` })
  assert.equal(checkedUnfocused, 'none', 'checked without focus has no focus ring, so focus is distinct from checked')
  await radio(page, 'Light').focus()
  await shot(themeSection(page), 'theme-row-focus')
  revision = await act(page, () => page.keyboard.press('ArrowRight'))
  assert.equal(await storedMode(page, 'card'), 'dark', 'ArrowRight selects the next option')
  revision = await act(page, () => page.keyboard.press('ArrowRight'))
  assert.equal(await storedMode(page, 'card'), 'inherit', 'ArrowRight wraps from Dark to Inherit')
  assert.equal((await focusState(page)).name, 'Inherit')
  revision = await act(page, () => page.keyboard.press('End'))
  assert.equal(await storedMode(page, 'card'), 'dark', 'End selects the last option')
  revision = await act(page, () => page.keyboard.press('Home'))
  assert.equal(await storedMode(page, 'card'), 'inherit', 'Home selects the first option')
  await radio(page, 'Light').focus()
  revision = await act(page, () => page.keyboard.press(' '))
  assert.equal(await storedMode(page, 'card'), 'light', 'Space selects the focused option')
  await page.waitForTimeout(400)
  assert.equal(await revisionOf(page), revision, 'Space wrote exactly one revision')
  assert.equal((await stored(page)).file.nodes.card.layout, undefined, 'arrow keys never nudged the selected layer')
  record('CC-NT-019: radiogroup named Theme with aria-checked and roving tab stop; arrows (wrapping), Home, End and Space select and write; focus ring visible and distinct')
  await act(page, () => radio(page, 'Dark').click())

  // 9. CC-NT-019: an unavailable option exposes its reason and is skipped. Two dark design themes and no `dark` id make
  // Dark ambiguous; only the editor's copy of the design stylesheet changes, in a separate browser context.
  const ambiguous = await browser.newContext({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'light' })
  await ambiguous.route(/component-repo-seed\/src\/globals\.css\?raw/, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: `export default ${JSON.stringify(":root { --surface: #ffffff; --ink: #202124; }\n[data-theme='night'] { --surface: #242427; }\n[data-theme='midnight'] { --surface: #000000; }\n")}` }))
  const second = await ambiguous.newPage()
  activePage = second
  second.on('pageerror', error => { evidence.error = `Page error: ${error.message}` })
  await seed(second)
  await open(second)
  await selectLayer(second, 'label-a')
  const reason = 'Dark is unavailable: two dark design themes need a primary mapping'
  const dark = radio(second, 'Dark')
  assert.equal(await dark.getAttribute('aria-disabled'), 'true')
  await expect(dark).toHaveAccessibleDescription(reason)
  await expect(themeSection(second)).toContainText(reason)
  assert.equal(await radio(second, 'Light').getAttribute('aria-disabled'), null)
  await shot(themeSection(second), 'theme-row-unavailable')
  const unavailableRevision = await revisionOf(second)
  // Playwright refuses aria-disabled targets, so the click is forced to prove the option itself is inert.
  await dark.click({ force: true })
  await second.waitForTimeout(400)
  assert.equal(await revisionOf(second), unavailableRevision, 'clicking the unavailable option writes nothing')
  await radio(second, 'Inherit').focus()
  await act(second, () => second.keyboard.press('ArrowRight'))
  assert.equal(await storedMode(second, 'label-a'), 'light')
  await act(second, () => second.keyboard.press('ArrowRight'))
  assert.equal(await storedMode(second, 'label-a'), 'inherit', 'ArrowRight skips the unavailable Dark and wraps to Inherit')
  await act(second, () => second.keyboard.press('End'))
  assert.equal(await storedMode(second, 'label-a'), 'light', 'End selects the last enabled option')
  record('CC-NT-019: unavailable Dark is aria-disabled with its reason as the accessible description, skipped by arrows and End, and inert on click')
  await ambiguous.close()
  activePage = page
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
  await writeFile(join(evidenceRoot, 'node-theme.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, screenshots: evidence.screenshots }))
}
