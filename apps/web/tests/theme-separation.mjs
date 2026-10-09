// Editor appearance versus design preview theme: two independent states, verified against the running dev servers.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const evidenceRoot = join(projectRoot, 'outputs', 'theme-separation')
const editorUrl = 'http://127.0.0.1:4317/'
// The legacy draft key is a migration input only. Files are stored as an index plus one record per file; the preview theme is view state.
const indexKey = 'design-editor.browser-files-index.v3'
const contentKey = fileId => `design-editor.browser-file.${fileId}.v3`
const viewKey = 'design-editor.view-state.v1'
const draftKey = 'design-editor.browser-draft.v1'
const appearanceKey = 'design-editor.appearance.v1'
const draftName = 'Local draft'
const cardId = 'browser-local-composition:card'
const buttonId = 'sample-instance-button'
const surfaceFrameId = 'legacy-surface-frame'
const legacyIds = ['sample-instance-label-email', 'sample-instance-input-email', 'sample-instance-label-password', 'sample-instance-input-password', buttonId]
const legacyDocument = { version: 1, revision: 0, rootIds: [cardId], nodes: {
  [cardId]: { id: cardId, componentId: 'sample-card', exportName: 'Card', props: { heading: 'Welcome back' }, children: { children: legacyIds } },
  'sample-instance-label-email': { id: 'sample-instance-label-email', componentId: 'sample-label', exportName: 'Label', props: { htmlFor: 'email', children: 'Email' }, children: {} },
  'sample-instance-input-email': { id: 'sample-instance-input-email', componentId: 'sample-input', exportName: 'Input', props: { id: 'email', type: 'email', placeholder: 'you@example.com' }, children: {} },
  'sample-instance-label-password': { id: 'sample-instance-label-password', componentId: 'sample-label', exportName: 'Label', props: { htmlFor: 'password', children: 'Password' }, children: {} },
  'sample-instance-input-password': { id: 'sample-instance-input-password', componentId: 'sample-input', exportName: 'Input', props: { id: 'password', type: 'password' }, children: {} },
  [buttonId]: { id: buttonId, componentId: 'sample-button', exportName: 'Button', props: { children: 'Sign in', variant: 'primary' }, children: {} },
}, frame: { width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false },
// A version 1 frame filled with the built-in `surface` name: migration turns it into a file token bound to the stylesheet's --surface.
canvas: { elements: [{ id: surfaceFrameId, kind: 'frame', name: 'Surface panel', x: 480, y: 0, width: 160, height: 120, rotation: 0, fill: 'surface', clip: true }] } }
// The bundled sample stylesheet: `:root` is the base theme, `[data-theme='dark']` the only other mode.
// The preview body is transparent over the unbounded canvas, so the design's custom properties are read from its root.
const designSurface = { default: '#ffffff', dark: '#242427' }
const designInk = { default: '#202124', dark: '#eeeeef' }
const portalInk = { default: 'rgb(32, 33, 36)', dark: 'rgb(238, 238, 239)' }
const tokenHex = { default: '#FFFFFF', dark: '#242427' }
const surfaceRgb = { default: 'rgb(255, 255, 255)', dark: 'rgb(36, 36, 39)' }

const evidence = { status: 'failed', checks: [], screenshots: [], error: null }
let browser = null
let activePage = null
const record = (name, detail = '') => { evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log('✓', name, detail) }
const shot = async (page, name) => { await page.screenshot({ path: join(evidenceRoot, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }
const previewFrame = page => page.frameLocator('iframe[title="Canvas"]')
const themeSelect = page => page.getByRole('combobox', { name: 'Canvas default theme' })
const appearanceToggle = page => page.locator('.right-rail').getByRole('button', { name: /Switch editor appearance to/ })
const fileIdNamed = (page, name) => page.evaluate(([key, name]) => Object.values(JSON.parse(localStorage.getItem(key) ?? '{"files":{}}').files).find(entry => entry.name === name)?.id ?? null, [indexKey, name])
const storedContent = (page, fileId) => page.evaluate(key => localStorage.getItem(key), contentKey(fileId))
const storedView = (page, fileId) => page.evaluate(([key, fileId]) => JSON.parse(localStorage.getItem(key) ?? '{"files":{}}').files[fileId] ?? null, [viewKey, fileId])
const waitPreviewThemeId = (page, fileId, themeId) => page.waitForFunction(([key, fileId, themeId]) => JSON.parse(localStorage.getItem(key) ?? '{"files":{}}').files[fileId]?.previewThemeId === themeId, [viewKey, fileId, themeId])
const sidebarTab = (page, name) => page.getByRole('tab', { name, exact: true })
const surfaceFill = page => previewFrame(page).locator(`[data-preview-canvas="${surfaceFrameId}"]`).evaluate(element => getComputedStyle(element).backgroundColor)
/** Reads the `surface` row in the Theme tab, which resolves source tokens against the active preview theme, then returns to Design. */
async function surfaceRow(page, hex) {
  await sidebarTab(page, 'Theme').click()
  const row = page.getByRole('listbox', { name: 'Color tokens' }).getByRole('option', { name: /^surface, / })
  await row.waitFor()
  await page.waitForFunction(expected => document.querySelector('[role="listbox"][aria-label="Color tokens"] [role="option"][aria-label^="surface, "]')?.getAttribute('aria-label') === expected, `surface, Source --surface, ${hex}, 100% opacity`, { timeout: 5000 }).catch(() => {})
  const shown = { label: await row.getAttribute('aria-label'), hex: await row.locator('.theme-color-hex').innerText() }
  await sidebarTab(page, 'Design').click()
  assert.equal(shown.label, `surface, Source --surface, ${hex}, 100% opacity`)
  assert.equal(shown.hex, hex)
  return shown
}
async function editorState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.editor-root')
    const rail = document.querySelector('.right-rail')
    return { dark: root?.classList.contains('theme-dark') ?? null, chromeBackground: rail ? getComputedStyle(rail).backgroundColor : null, chromeColor: rail ? getComputedStyle(rail).color : null }
  })
}
async function previewState(page) {
  return previewFrame(page).locator('html').evaluate(root => ({
    attribute: root.getAttribute('data-theme'),
    colorScheme: root.style.colorScheme,
    background: getComputedStyle(root).getPropertyValue('--surface').trim(),
    ink: getComputedStyle(root).getPropertyValue('--ink').trim(),
    probe: root.dataset.probe ?? null,
  }))
}
async function waitPreview(page, expected) {
  await page.waitForFunction(() => Boolean(document.querySelector('iframe[title="Canvas"]')))
  await previewFrame(page).locator('body').waitFor()
  for (let attempt = 0; attempt < 80; attempt++) {
    const state = await previewState(page).catch(() => null)
    if (state && state.background === expected.background && state.attribute === expected.attribute && state.colorScheme === expected.colorScheme) return state
    await page.waitForTimeout(100)
  }
  assert.deepEqual(await previewState(page), expected)
}
async function waitEditor(page) { await page.locator('.canvas-stage').waitFor({ timeout: 20_000 }); await themeSelect(page).waitFor({ timeout: 20_000 }) }
async function expectCombination(page, { editorDark, theme }, name) {
  const editor = await editorState(page)
  assert.equal(editor.dark, editorDark, `${name}: editor appearance`)
  const preview = await waitPreview(page, { attribute: theme === 'default' ? null : theme, colorScheme: theme === 'dark' ? 'dark' : 'light', background: designSurface[theme], ink: designInk[theme], probe: await previewState(page).then(state => state.probe) })
  assert.equal(await themeSelect(page).inputValue(), theme, `${name}: select reflects the stored theme`)
  await shot(page, name)
  return { editor, preview }
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
  await page.evaluate(([document, key]) => { localStorage.clear(); localStorage.setItem(key, JSON.stringify(document)) }, [legacyDocument, draftKey])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: new RegExp(draftName) }).first().click()
  await waitEditor(page)
  await previewFrame(page).getByRole('button', { name: 'Sign in' }).waitFor({ timeout: 20_000 })

  // 1. Baseline: light editor, base design theme, options come from the stylesheet, migration persisted the default once.
  assert.deepEqual(await themeSelect(page).locator('option').allTextContents(), ['Default', 'Dark'], 'only the themes the stylesheet declares')
  await expectCombination(page, { editorDark: false, theme: 'default' }, '01-light-editor-light-components')
  const draftId = await fileIdNamed(page, draftName)
  assert.ok(draftId, 'the migrated draft is in the file index')
  await waitPreviewThemeId(page, draftId, 'default')
  assert.equal((await storedView(page, draftId)).previewThemeId, 'default', 'a pre-existing file settles on the documented default once')
  const draftSource = await storedContent(page, draftId)
  const draftFile = JSON.parse(draftSource).file
  const surface = Object.values(draftFile.theme.tokens).find(token => token.name === 'surface')
  assert.ok(surface, 'the migrated file theme has a surface token')
  assert.equal(surface.value.kind, 'source')
  assert.equal(surface.value.property, '--surface')
  assert.deepEqual(draftFile.nodes[surfaceFrameId].appearance.fills.map(({ id, ...paint }) => paint), [{ type: 'solid', color: { kind: 'token', tokenId: surface.id } }], 'the legacy surface fill is bound to the token, not frozen')
  assert.equal('previewTheme' in draftFile || 'previewThemeId' in draftFile, false, 'the preview theme is not file data')
  await surfaceRow(page, tokenHex.default)
  assert.equal(await surfaceFill(page), surfaceRgb.default)
  record('Baseline: light editor with the base design theme; options come from the stylesheet; migrated view state stores "default"; surface token resolves to #FFFFFF')

  // 2. Dark editor, light components.
  const lightChrome = (await editorState(page)).chromeBackground
  await appearanceToggle(page).click()
  await page.waitForFunction(() => document.querySelector('.editor-root')?.classList.contains('theme-dark'))
  const dim = await expectCombination(page, { editorDark: true, theme: 'default' }, '02-dark-editor-light-components')
  assert.notEqual(dim.editor.chromeBackground, lightChrome, 'editor chrome recolors')
  assert.equal(await page.evaluate(key => localStorage.getItem(key), appearanceKey), 'dark', 'appearance is a stored user preference')
  assert.equal((await storedView(page, draftId)).previewThemeId, 'default', 'editor appearance never touches the preview theme')
  assert.equal(await storedContent(page, draftId), draftSource, 'editor appearance never touches the file')
  await surfaceRow(page, tokenHex.default)
  record('Dark editor with light components: chrome recolors, preview, tokens, and file unchanged')

  // 3. Dark editor, dark components.
  const darkChrome = dim.editor.chromeBackground
  await themeSelect(page).selectOption('dark')
  const both = await expectCombination(page, { editorDark: true, theme: 'dark' }, '03-dark-editor-dark-components')
  assert.equal(both.editor.chromeBackground, darkChrome, 'design theme never recolors the editor')
  await waitPreviewThemeId(page, draftId, 'dark')
  await surfaceRow(page, tokenHex.dark)
  assert.equal(await surfaceFill(page), surfaceRgb.dark, 'a node bound to the source token renders the dark value')
  assert.equal(await storedContent(page, draftId), draftSource, 'previewing a mode writes nothing into the file')
  record('Dark editor with dark components: preview root carries data-theme=dark and color-scheme dark; view state stores the theme; tokens follow the design theme')

  // 4. Light editor, dark components.
  await appearanceToggle(page).click()
  await page.waitForFunction(() => !document.querySelector('.editor-root')?.classList.contains('theme-dark'))
  const mixed = await expectCombination(page, { editorDark: false, theme: 'dark' }, '04-light-editor-dark-components')
  assert.equal(mixed.editor.chromeBackground, lightChrome)
  record('Light editor with dark components')

  // 5. State preservation across a preview theme switch: typed input, open portal, selection, undo state, no iframe remount.
  await previewFrame(page).locator('html').evaluate(root => { root.dataset.probe = 'kept' })
  await page.keyboard.press('i')
  await previewFrame(page).getByRole('textbox', { name: 'Email' }).fill('caleb@example.com')
  await previewFrame(page).getByRole('button', { name: 'Sign in' }).click()
  const dialog = previewFrame(page).getByRole('dialog', { name: 'Preview result' })
  await dialog.waitFor()
  assert.equal(await dialog.evaluate(element => getComputedStyle(element).color), portalInk.dark, 'portal content follows the design theme')
  await page.keyboard.press('v')
  await page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Button', exact: true }).click()
  const undoBefore = await page.locator('.canvas-floating-actions button[aria-label="Undo document edit"]').isDisabled()
  await themeSelect(page).selectOption('default')
  const after = await waitPreview(page, { attribute: null, colorScheme: 'light', background: designSurface.default, ink: designInk.default, probe: 'kept' })
  assert.equal(after.probe, 'kept', 'the preview document was updated in place, not remounted')
  assert.equal(await previewFrame(page).getByRole('textbox', { name: 'Email' }).inputValue(), 'caleb@example.com', 'typed input survives')
  await dialog.waitFor()
  assert.equal(await dialog.evaluate(element => getComputedStyle(element).color), portalInk.default, 'portal recolors with the design theme')
  assert.equal(await page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Button', exact: true }).getAttribute('aria-selected'), 'true', 'selection survives')
  assert.equal(await page.locator('.canvas-floating-actions button[aria-label="Undo document edit"]').isDisabled(), undoBefore, 'undo history untouched')
  await themeSelect(page).selectOption('dark')
  await waitPreview(page, { attribute: 'dark', colorScheme: 'dark', background: designSurface.dark, ink: designInk.dark, probe: 'kept' })
  record('Switching the preview theme is a state update: input text, portal, selection, undo state, and the iframe instance persist')

  // 6. Operating-system theme changes move neither state.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(400)
  assert.equal((await editorState(page)).dark, false, 'editor appearance ignores the OS theme')
  await waitPreview(page, { attribute: 'dark', colorScheme: 'dark', background: designSurface.dark, ink: designInk.dark, probe: 'kept' })
  await themeSelect(page).selectOption('default')
  await waitPreview(page, { attribute: null, colorScheme: 'light', background: designSurface.default, ink: designInk.default, probe: 'kept' })
  assert.equal((await editorState(page)).dark, false)
  await page.emulateMedia({ colorScheme: 'light' })
  await themeSelect(page).selectOption('dark')
  await waitPreview(page, { attribute: 'dark', colorScheme: 'dark', background: designSurface.dark, ink: designInk.dark, probe: 'kept' })
  record('OS color scheme changes leave both the editor appearance and the design preview theme alone')

  // 7. Reopening restores the file's theme and the user's appearance independently.
  await appearanceToggle(page).click()
  await page.waitForFunction(() => document.querySelector('.editor-root')?.classList.contains('theme-dark'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitEditor(page)
  await expectCombination(page, { editorDark: true, theme: 'dark' }, '05-reopened')
  record('Reload restores the stored preview theme (dark) and the stored appearance (dark) separately')

  // 8. Switching files restores each file's own theme; a new file starts on the documented default.
  await page.getByRole('button', { name: 'Files' }).click()
  await page.getByRole('button', { name: /New file/i }).first().click()
  await waitEditor(page)
  await expectCombination(page, { editorDark: true, theme: 'default' }, '06-second-file-default')
  const untitledId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
  assert.notEqual(untitledId, draftId)
  await waitPreviewThemeId(page, untitledId, 'default')
  assert.equal((await storedView(page, untitledId)).previewThemeId, 'default', 'new files persist the default explicitly')
  assert.equal((await storedView(page, draftId)).previewThemeId, 'dark', 'the other file keeps its own theme')
  await page.goBack()
  await page.waitForFunction(() => location.pathname === '/')
  await page.getByRole('button', { name: new RegExp(draftName) }).first().click()
  await waitEditor(page)
  await expectCombination(page, { editorDark: true, theme: 'dark' }, '07-draft-restored')
  record('Switching files restores each file\'s own preview theme; the editor appearance stays the user\'s')
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
