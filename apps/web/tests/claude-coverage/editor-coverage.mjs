import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const webRoot = fileURLToPath(new URL('../../', import.meta.url))
const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const evidenceRoot = join(projectRoot, 'outputs', 'claude-coverage')
const webRequire = createRequire(join(webRoot, 'package.json'))
const editorUrl = 'http://127.0.0.1:4481/'
const servedPreview = 'http://127.0.0.1:4482'
const previewOriginExpectedByEditor = 'http://127.0.0.1:4318'
const draftKey = 'design-editor.browser-draft.v1'
const only = process.argv.find(argument => argument.startsWith('--only='))?.slice(7)

const ORIGINAL = [
  ['Label', 'sample-instance-label-email'],
  ['Input', 'sample-instance-input-email'],
  ['Label', 'sample-instance-label-password'],
  ['Input', 'sample-instance-input-password'],
  ['Button', 'sample-instance-button'],
]
const ids = ORIGINAL.map(([, id]) => id)
const [LABEL_EMAIL, INPUT_EMAIL, LABEL_PASSWORD, INPUT_PASSWORD, BUTTON] = ids
const CARD = 'browser-local-composition:card'
const TREE = [['Card', CARD], ...ORIGINAL]
const all = [CARD, ...ids]
const COMPOSITION_HINT = 'Composition preview uses the real atoms. App callbacks and providers are not part of this draft.'
const COMPOSITION_STATUS = 'Composition preview'

const owned = []
const evidence = { status: 'failed', startedAt: new Date().toISOString(), browser: 'system Edge, headless', ports: { editor: 4481, preview: 4482 }, routedPreviewRequests: 0, servers: {}, routeTreeHash: {}, scenarios: [], error: null }
let browser

async function responseAt(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return { status: response.status, text: await response.text() }
  } catch { return null }
}

async function startServer(name, url, config, expected) {
  if (await responseAt(url) !== null) throw new Error(`Port for ${name} (${url}) is already in use by a process this harness does not own`)
  const vite = join(dirname(webRequire.resolve('vite/package.json')), 'bin', 'vite.js')
  const child = spawn(process.execPath, [vite, '--config', config, '--configLoader', 'runner', '--strictPort'], { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  owned.push(child)
  evidence.servers[name] = { url, pid: child.pid, config }
  let log = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + String(chunk)).slice(-4000) })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before readiness: ${log}`)
    const response = await responseAt(url)
    if (response?.status === 200) { assert.match(response.text, expected); return }
    await new Promise(resolveWait => setTimeout(resolveWait, 300))
  }
  throw new Error(`${name} did not become ready: ${log}`)
}

async function hashFile(path) {
  try { return createHash('sha256').update(await readFile(path)).digest('hex') } catch { return null }
}

const layers = page => page.getByRole('tree', { name: 'Layers', exact: true })
const preview = page => page.frameLocator('iframe[title="Canvas"]')
const instance = (page, id) => preview(page).locator(`[data-preview-instance="${id}"]`)
const layer = (page, id) => layers(page).locator(`[role="treeitem"][data-instance-id="${id}"]`)
const field = (page, id, prop) => page.locator('.right-rail').locator(`[id="instance-${id}-${prop}"]`)
const inspectorTitle = page => page.locator('.right-rail .panel-header .heading').first().textContent()
const savedDraft = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), draftKey)

async function tree(page) {
  return layers(page).locator('[role="treeitem"]').evaluateAll(items => items.map(item => ({ name: item.getAttribute('aria-label'), id: item.getAttribute('data-instance-id'), selected: item.getAttribute('aria-selected') === 'true' })))
}
const treeOrder = async page => (await tree(page)).map(item => [item.name, item.id])
const selectedIds = async page => (await tree(page)).filter(item => item.selected).map(item => item.id)
const previewOrder = page => preview(page).locator('body').evaluate(() => Array.from(document.querySelectorAll('[data-preview-instance]')).map(element => element.getAttribute('data-preview-instance')))

async function eventually(read, expected, message, timeout = 5000) {
  const deadline = Date.now() + timeout
  let actual
  while (Date.now() < deadline) {
    actual = await read()
    try { assert.deepEqual(actual, expected); return actual } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert.deepEqual(actual, expected, message)
}

async function openDraft(page) {
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  const open = page.locator('.file-bar').getByRole('button', { name: 'Open local draft', exact: true })
  await open.waitFor({ timeout: 30_000 })
  await open.click()
  await layer(page, BUTTON).waitFor()
  await preview(page).getByRole('button', { name: 'Sign in', exact: true }).waitFor()
}

async function enterComposition(page) {
  const width = page.locator('.right-rail').getByRole('spinbutton', { name: 'Frame width', exact: true })
  await width.fill('420')
  await width.press('Enter')
  await instance(page, BUTTON).waitFor()
  await eventually(async () => (await savedDraft(page))?.frame.width, 420, 'Frame width edit must persist to the local draft')
}

async function scenario(name, acceptance, body) {
  if (only && !name.includes(only)) return
  const result = { name, acceptance, status: 'failed', checks: [], controls: [], pageErrors: [], consoleErrors: [], screenshot: null, error: null }
  evidence.scenarios.push(result)
  const context = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 })
  await context.route(`${previewOriginExpectedByEditor}/**`, async route => {
    const url = new URL(route.request().url())
    evidence.routedPreviewRequests++
    const response = await route.fetch({ url: servedPreview + url.pathname + url.search })
    await route.fulfill({ response })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', error => result.pageErrors.push(error.message.slice(0, 1000)))
  page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text().slice(0, 1000)) })
  const check = (label, detail) => result.checks.push(detail === undefined ? label : { label, detail })
  const control = (label, detail) => result.controls.push(detail === undefined ? label : { label, detail })
  try {
    await openDraft(page)
    await body(page, check, control)
    result.status = 'passed'
  } catch (error) {
    result.error = error instanceof Error ? error.stack ?? error.message : String(error)
  } finally {
    const file = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}${result.status === 'passed' ? '' : '-failure'}.png`
    await page.screenshot({ path: join(evidenceRoot, file), fullPage: true }).then(() => { result.screenshot = file }).catch(() => undefined)
    await context.close()
  }
}

async function selectionAndInspector(page, check, control) {
  assert.deepEqual(await treeOrder(page), TREE)
  assert.deepEqual(await layers(page).locator('[role="treeitem"]').evaluateAll(items => items.map(item => item.getAttribute('aria-level'))), ['1', '2', '2', '2', '2', '2'])
  assert.deepEqual(await selectedIds(page), [])
  assert.equal(await inspectorTitle(page), 'Local draft')
  assert.equal(await page.locator('.right-rail').getByRole('spinbutton', { name: 'Frame width', exact: true }).inputValue(), '400')
  assert.equal(await page.locator('.right-rail').getByRole('spinbutton', { name: 'Frame height', exact: true }).inputValue(), '520')
  check('Initial layer tree is Card (level 1) containing the five atoms (level 2) in composition order, nothing selected, frame controls 400 x 520')

  await layer(page, CARD).click()
  assert.equal(await inspectorTitle(page), 'Card')
  assert.equal(await field(page, CARD, 'heading').inputValue(), 'Welcome back')
  assert.equal(await page.locator('.right-rail section[aria-label="Slots"]').getByText('5', { exact: true }).count(), 1)
  check('Selecting the Card shows its heading prop and its children slot count of 5')

  await layer(page, BUTTON).click()
  assert.deepEqual(await selectedIds(page), [BUTTON])
  assert.equal(await inspectorTitle(page), 'Button')
  assert.equal(await field(page, BUTTON, 'children').inputValue(), 'Sign in')
  assert.equal(await field(page, BUTTON, 'variant').inputValue(), 'primary')
  assert.equal(await field(page, BUTTON, 'type').inputValue(), '')
  assert.equal(await field(page, BUTTON, 'disabled').isChecked(), false)
  assert.equal(await page.locator('.right-rail').getByRole('spinbutton', { name: 'Frame width', exact: true }).count(), 0)
  await page.locator('.right-rail').getByRole('region', { name: 'Source', exact: true }).getByText('Bundled sample / Button', { exact: true }).waitFor()
  check('Click selects one layer and the inspector shows that instance props and source binding')

  await layer(page, LABEL_EMAIL).click({ modifiers: ['Control'] })
  assert.deepEqual((await selectedIds(page)).sort(), [BUTTON, LABEL_EMAIL].sort())
  assert.equal(await inspectorTitle(page), '2 selected')
  await page.locator('.right-rail').getByText('Multiple instances selected. Choose one to edit its properties.', { exact: true }).waitFor()
  assert.equal(await field(page, BUTTON, 'children').count(), 0)
  check('Ctrl+click adds a layer and the inspector refuses ambiguous multi-instance editing')

  await layer(page, LABEL_EMAIL).click({ modifiers: ['Control'] })
  assert.deepEqual(await selectedIds(page), [BUTTON])
  assert.equal(await inspectorTitle(page), 'Button')
  check('Ctrl+click on a selected layer toggles it off')

  await layer(page, INPUT_EMAIL).click()
  await layer(page, INPUT_PASSWORD).click({ modifiers: ['Shift'] })
  assert.deepEqual(await selectedIds(page), [INPUT_EMAIL, LABEL_PASSWORD, INPUT_PASSWORD])
  assert.equal(await inspectorTitle(page), '3 selected')
  await layer(page, LABEL_EMAIL).click({ modifiers: ['Shift'] })
  assert.deepEqual(await selectedIds(page), [LABEL_EMAIL, INPUT_EMAIL])
  check('Shift+click selects the document range from the anchor in either direction')

  await layer(page, LABEL_EMAIL).focus()
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-instance-id')), INPUT_EMAIL)
  assert.deepEqual(await selectedIds(page), [LABEL_EMAIL, INPUT_EMAIL])
  control('Arrow navigation moves focus without changing selection')
  await page.keyboard.press('Enter')
  assert.deepEqual(await selectedIds(page), [INPUT_EMAIL])
  assert.equal(await inspectorTitle(page), 'Input')
  assert.equal(await field(page, INPUT_EMAIL, 'id').inputValue(), 'email')
  assert.equal(await field(page, INPUT_EMAIL, 'type').inputValue(), 'email')
  assert.equal(await field(page, INPUT_EMAIL, 'placeholder').inputValue(), 'you@example.com')
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-instance-id')), BUTTON)
  await page.keyboard.press(' ')
  assert.deepEqual(await selectedIds(page), [BUTTON])
  await page.keyboard.press('Home')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-instance-id')), CARD)
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-instance-id')), LABEL_EMAIL)
  await page.keyboard.press('Enter')
  assert.deepEqual(await selectedIds(page), [LABEL_EMAIL])
  assert.equal(await field(page, LABEL_EMAIL, 'children').inputValue(), 'Email')
  assert.equal(await field(page, LABEL_EMAIL, 'htmlFor').inputValue(), 'email')
  check('Keyboard Arrow, Home, End, Enter and Space traverse and select layers; inspector follows each selection')

  await page.keyboard.press('Control+a')
  assert.deepEqual(await selectedIds(page), all)
  assert.equal(await inspectorTitle(page), '6 selected')
  check('Ctrl+A selects every layer in document order')
  await page.keyboard.press('Escape')
  assert.deepEqual(await selectedIds(page), [])
  assert.equal(await page.locator('.right-rail').getByRole('spinbutton', { name: 'Frame width', exact: true }).inputValue(), '400')
  check('Escape clears selection and the inspector returns to frame controls')

  await layer(page, BUTTON).click()
  const children = field(page, BUTTON, 'children')
  await children.focus()
  await page.keyboard.press('Control+a')
  assert.deepEqual(await selectedIds(page), [BUTTON])
  assert.deepEqual(await children.evaluate(input => [input.selectionStart, input.selectionEnd]), [0, 'Sign in'.length])
  await page.keyboard.press('End')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Escape')
  assert.deepEqual(await treeOrder(page), TREE)
  assert.deepEqual(await selectedIds(page), [BUTTON])
  assert.equal(await children.inputValue(), 'Sign in')
  control('Ctrl+A, Delete and Escape typed in an inspector field do not select all, delete the layer, or clear selection')

  assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), null)
  control('Selection-only interaction persists no document edit')
}

async function inspectorEditsAndHistory(page, check, control) {
  const undo = page.getByRole('button', { name: 'Undo document edit', exact: true })
  const redo = page.getByRole('button', { name: 'Redo document edit', exact: true })
  assert.equal(await undo.isDisabled(), true)
  assert.equal(await redo.isDisabled(), true)
  control('Undo and redo start disabled with no history')

  await layer(page, BUTTON).click()
  await field(page, BUTTON, 'children').fill('Log in')
  await instance(page, BUTTON).waitFor()
  await eventually(() => instance(page, BUTTON).textContent(), 'Log in', 'Preview button text must follow the inspector')
  assert.equal(await instance(page, BUTTON).evaluate(element => element.tagName), 'BUTTON')
  assert.equal(await instance(page, LABEL_EMAIL).textContent(), 'Email')
  assert.equal(await instance(page, INPUT_EMAIL).getAttribute('placeholder'), 'you@example.com')
  await eventually(async () => (await savedDraft(page))?.nodes[BUTTON]?.props.children, 'Log in', 'Draft must persist the edit')
  assert.equal(await undo.isDisabled(), false)
  check('Text prop edit re-renders the real Button atom in the isolated preview, leaves other instances unchanged, and persists')

  await field(page, BUTTON, 'variant').selectOption('quiet')
  await eventually(() => instance(page, BUTTON).getAttribute('data-variant'), 'quiet', 'Variant select must reach the atom')
  await field(page, BUTTON, 'disabled').check()
  await eventually(() => instance(page, BUTTON).evaluate(element => element.disabled), true, 'Boolean toggle must disable the real button')
  check('Enum and boolean prop edits reach the real atom DOM (data-variant, disabled)')

  await layer(page, BUTTON).focus()
  await page.keyboard.press('Control+z')
  await eventually(() => instance(page, BUTTON).evaluate(element => element.disabled), false, 'Undo must revert disabled')
  assert.equal(await field(page, BUTTON, 'disabled').isChecked(), false)
  await page.keyboard.press('Control+z')
  await eventually(() => instance(page, BUTTON).getAttribute('data-variant'), 'primary', 'Second undo must revert variant')
  await page.keyboard.press('Control+z')
  await eventually(() => instance(page, BUTTON).textContent(), 'Sign in', 'Third undo must revert text')
  assert.equal(await field(page, BUTTON, 'children').inputValue(), 'Sign in')
  assert.equal(await undo.isDisabled(), true)
  assert.equal(await redo.isDisabled(), false)
  await eventually(async () => (await savedDraft(page))?.nodes[BUTTON]?.props, { children: 'Sign in', variant: 'primary' }, 'Undo must persist the original props')
  check('Ctrl+Z steps back through three edits in reverse order, updating inspector, preview, and stored draft')

  await page.keyboard.press('Control+y')
  await eventually(() => instance(page, BUTTON).textContent(), 'Log in', 'Ctrl+Y must redo text')
  await page.keyboard.press('Control+Shift+z')
  await eventually(() => instance(page, BUTTON).getAttribute('data-variant'), 'quiet', 'Ctrl+Shift+Z must redo variant')
  await undo.click()
  await eventually(() => instance(page, BUTTON).getAttribute('data-variant'), 'primary', 'Undo button must undo')
  await redo.click()
  await eventually(() => instance(page, BUTTON).getAttribute('data-variant'), 'quiet', 'Redo button must redo')
  assert.deepEqual(await selectedIds(page), [BUTTON])
  check('Ctrl+Y, Ctrl+Shift+Z and the toolbar Undo/Redo buttons all move through the same history')

  await layer(page, BUTTON).focus()
  await page.keyboard.press('Control+d')
  const afterDuplicate = await tree(page)
  assert.equal(afterDuplicate.length, 7)
  const copy = afterDuplicate[6]
  assert.equal(copy.name, 'Button')
  assert.notEqual(copy.id, BUTTON)
  assert.deepEqual(afterDuplicate.slice(0, 6).map(item => item.id), all)
  assert.deepEqual(await selectedIds(page), [copy.id])
  await eventually(() => previewOrder(page), [...all, copy.id], 'Duplicate must render in the preview right after the original')
  assert.equal(await instance(page, copy.id).textContent(), 'Log in')
  assert.equal(await instance(page, copy.id).getAttribute('data-variant'), 'quiet')
  check('Ctrl+D duplicates with a new identity directly after the original, selects it, and copies props', copy.id)
  await layer(page, copy.id).focus()
  await page.keyboard.press('Control+z')
  await eventually(() => previewOrder(page), all, 'Undo of duplicate must remove the copy')
  assert.deepEqual(await selectedIds(page), [BUTTON])
  check('Undo of duplicate removes the copy and restores prior selection')

  await layer(page, INPUT_EMAIL).click()
  await layer(page, INPUT_EMAIL).press('Delete')
  await eventually(async () => (await tree(page)).map(item => item.id), all.filter(id => id !== INPUT_EMAIL), 'Delete must remove the layer')
  await eventually(() => previewOrder(page), all.filter(id => id !== INPUT_EMAIL), 'Delete must remove the preview instance')
  assert.equal(await page.getByRole('button', { name: 'Delete', exact: true }).isDisabled(), true)
  await page.locator('.editor-root').press('Control+z')
  await eventually(() => previewOrder(page), all, 'Undo of delete must restore the instance')
  assert.deepEqual(await selectedIds(page), [INPUT_EMAIL])
  assert.equal(await instance(page, INPUT_EMAIL).getAttribute('placeholder'), 'you@example.com')
  check('Delete key removes the selected layer; undo restores the same instance identity, props, and selection')

  await layer(page, BUTTON).click()
  const moveUp = page.getByRole('button', { name: 'Move up', exact: true })
  const moveDown = page.getByRole('button', { name: 'Move down', exact: true })
  assert.equal(await moveDown.isDisabled(), true)
  assert.equal(await moveUp.isDisabled(), false)
  control('Move down is disabled for the last layer')
  await layer(page, BUTTON).press('Alt+ArrowUp')
  const moved = [CARD, LABEL_EMAIL, INPUT_EMAIL, LABEL_PASSWORD, BUTTON, INPUT_PASSWORD]
  await eventually(async () => (await tree(page)).map(item => item.id), moved, 'Alt+ArrowUp must reorder the layer')
  await eventually(() => previewOrder(page), moved, 'Preview DOM order must follow the layer order')
  await moveDown.click()
  await eventually(() => previewOrder(page), all, 'Move down must restore the order')
  check('Alt+ArrowUp and Move down reorder layers and the preview DOM order matches')

  const parentOf = id => instance(page, id).evaluate(element => element.parentElement?.closest('[data-preview-instance]')?.getAttribute('data-preview-instance') ?? element.parentElement?.id ?? null)
  assert.equal(await parentOf(BUTTON), CARD)
  await page.getByRole('button', { name: 'Move to frame', exact: true }).click()
  await eventually(() => parentOf(BUTTON), 'preview-root', 'Move to frame must lift the Button out of the Card')
  assert.deepEqual(await layers(page).locator(`[data-instance-id="${BUTTON}"]`).getAttribute('aria-level'), '1')
  assert.equal(await page.getByRole('button', { name: 'Move to frame', exact: true }).isDisabled(), true)
  await page.locator('.editor-root').press('Control+z')
  await eventually(() => parentOf(BUTTON), CARD, 'Undo must return the Button into the Card slot')
  check('Move to frame lifts a child out of the Card slot in both layer tree and preview DOM; undo nests it again')

  await eventually(async () => (await savedDraft(page))?.nodes[CARD]?.children.children, ids, 'Reorder must persist')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.file-bar').getByRole('button', { name: 'Open local draft', exact: true }).click()
  await layer(page, BUTTON).waitFor()
  await eventually(() => undo.isDisabled(), false, 'Undo history must survive reload')
  await instance(page, BUTTON).waitFor()
  assert.equal(await instance(page, BUTTON).textContent(), 'Log in')
  await page.locator('.editor-root').press('Control+z')
  await eventually(() => previewOrder(page), moved, 'First undo after reload must revert the last move')
  assert.equal(await parentOf(BUTTON), CARD)
  check('After reload the persisted document and undo history are restored; undo reverts the last action')
}

async function canvasSelectionAndTools(page, check, control) {
  const fit = page.getByRole('button', { name: 'Fit canvas', exact: true })
  const width = page.locator('.right-rail').getByRole('spinbutton', { name: 'Frame width', exact: true })
  await layer(page, LABEL_EMAIL).focus()
  for (const [key, expected] of [['0', '100%'], ['+', '125%'], ['+', '156%'], ['-', '125%'], ['0', '100%']]) {
    await page.keyboard.press(key)
    assert.equal(await fit.textContent(), expected, `Zoom after ${key}`)
  }
  check('Zoom shortcuts 0, +, - produce 100%, 125%, 156%, 125%, 100%')
  await width.focus()
  await page.keyboard.press('+')
  await page.keyboard.press('0')
  assert.equal(await fit.textContent(), '100%')
  await width.press('Escape')
  await layer(page, LABEL_EMAIL).focus()
  await page.keyboard.press('+')
  assert.equal(await fit.textContent(), '125%')
  await page.keyboard.press('0')
  control('Zoom keys typed in the frame width field do not change zoom while the same keys on a layer do')

  await enterComposition(page)
  const tool = name => page.locator('.toolbar').getByRole('button', { name, exact: true })
  await layer(page, LABEL_EMAIL).focus()
  await page.keyboard.press('v')
  assert.equal(await tool('Select').getAttribute('data-active'), 'true')
  assert.equal(await tool('Interact').getAttribute('data-active'), null)
  await page.waitForTimeout(400)
  await instance(page, INPUT_PASSWORD).click()
  await eventually(() => selectedIds(page), [INPUT_PASSWORD], 'Clicking the preview instance in Select mode must select its layer')
  assert.equal(await inspectorTitle(page), 'Input')
  assert.equal(await field(page, INPUT_PASSWORD, 'type').inputValue(), 'password')
  await page.locator(`.selection-bounds[data-selection-id="${INPUT_PASSWORD}"]`).waitFor()
  check('Select tool: clicking a preview instance selects the exact layer, inspector, and HUD')

  await instance(page, INPUT_EMAIL).pressSequentially('abc')
  assert.equal(await instance(page, INPUT_EMAIL).inputValue(), '')
  control('Select tool suppresses typing into preview inputs')

  await layer(page, INPUT_PASSWORD).focus()
  await page.keyboard.press('h')
  assert.equal(await tool('Hand').getAttribute('data-active'), 'true')
  await page.waitForTimeout(400)
  await instance(page, LABEL_EMAIL).click({ force: true })
  await page.waitForTimeout(400)
  assert.deepEqual(await selectedIds(page), [INPUT_PASSWORD])
  control('Hand tool: clicking a preview instance does not change selection')

  await layer(page, INPUT_PASSWORD).focus()
  await page.keyboard.press('i')
  assert.equal(await tool('Interact').getAttribute('data-active'), 'true')
  await page.waitForTimeout(400)
  await instance(page, INPUT_EMAIL).pressSequentially('abc')
  assert.equal(await instance(page, INPUT_EMAIL).inputValue(), 'abc')
  check('Interact tool lets the real Input receive typed text')

  const viewport = await page.locator('.canvas-viewport').boundingBox()
  assert.ok(viewport)
  await tool('Select').click()
  await page.mouse.click(viewport.x + 20, viewport.y + viewport.height - 20)
  await eventually(() => selectedIds(page), [], 'Clicking blank canvas must clear selection')
  check('Clicking blank canvas clears selection')
}

async function compositionLifecycle(page, check, control) {
  await enterComposition(page)
  const email = instance(page, INPUT_EMAIL)
  await email.pressSequentially('probe@example.test')
  assert.equal(await email.inputValue(), 'probe@example.test')
  await preview(page).locator('body').evaluate((_body, id) => { window.coverageProbe = document.querySelector(`[data-preview-instance="${id}"]`) }, INPUT_EMAIL)
  const probe = () => preview(page).locator('body').evaluate((_body, id) => {
    const current = document.querySelector(`[data-preview-instance="${id}"]`)
    return { same: current === window.coverageProbe, value: current?.value ?? null }
  }, INPUT_EMAIL)

  await layer(page, BUTTON).click()
  await field(page, BUTTON, 'children').fill('Continue')
  await eventually(() => instance(page, BUTTON).textContent(), 'Continue', 'Edit must reach preview')
  assert.deepEqual(await probe(), { same: true, value: 'probe@example.test' })
  check('Editing a sibling prop keeps the typed Input DOM node and its uncontrolled value')

  await layer(page, INPUT_EMAIL).click()
  await layer(page, INPUT_EMAIL).press('Alt+ArrowDown')
  await eventually(() => previewOrder(page), [CARD, LABEL_EMAIL, LABEL_PASSWORD, INPUT_EMAIL, INPUT_PASSWORD, BUTTON], 'Reorder must reach preview')
  assert.deepEqual(await probe(), { same: true, value: 'probe@example.test' })
  check('Reordering keeps the moved Input DOM node and value (keyed by instance identity)')

  await page.locator('.file-actions').getByRole('button', { name: 'Switch to dark mode', exact: true }).click()
  await preview(page).locator('html[data-theme="dark"]').waitFor()
  assert.deepEqual(await probe(), { same: true, value: 'probe@example.test' })
  check('Theme switch reaches the preview without remounting the Input')

  await layer(page, INPUT_EMAIL).press('Delete')
  await email.waitFor({ state: 'detached' })
  await page.locator('.editor-root').press('Control+z')
  await email.waitFor()
  assert.deepEqual(await probe(), { same: false, value: '' })
  control('Delete then undo remounts the Input: probe detects a new node and lost value, proving it can fail')

  await page.locator('.toolbar').getByRole('button', { name: 'Interact', exact: true }).click()
  await page.waitForTimeout(300)
  await instance(page, BUTTON).click()
  await page.waitForTimeout(500)
  assert.equal(await preview(page).getByRole('dialog', { name: 'Preview result' }).count(), 0)
  const status = page.locator('.canvas-runtime-status')
  await status.getByText(COMPOSITION_STATUS, { exact: true }).waitFor()
  assert.equal(await status.getAttribute('title'), COMPOSITION_HINT)
  check('Composition mode drops app callbacks and provider; the fixed canvas footer discloses this without resizing the workspace', 'Clicking the composed Button opens no portal dialog')
}

try {
  await mkdir(evidenceRoot, { recursive: true })
  const routeTree = join(webRoot, 'src', 'routeTree.gen.ts')
  evidence.routeTreeHash.before = await hashFile(routeTree)
  await startServer('editor', editorUrl, 'tests/claude-coverage/editor.vite.config.ts', /@vite\/client|TanStack|Design editor|Comp Canvas/)
  await startServer('preview', `${servedPreview}/`, 'tests/claude-coverage/preview.vite.config.ts', /preview-root/)
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  await scenario('selection and inspector', ['AT-CAN-001', 'AT-UX-002'], selectionAndInspector)
  await scenario('inspector edits and history', ['AT-CAN-001', 'AT-CAN-004', 'AT-PRV-001'], inspectorEditsAndHistory)
  await scenario('canvas selection and tools', ['AT-CAN-001', 'AT-CAN-004', 'AT-CAN-005'], canvasSelectionAndTools)
  await scenario('composition lifecycle', ['AT-PRV-001', 'AT-PRV-005'], compositionLifecycle)
  evidence.routeTreeHash.after = await hashFile(routeTree)
  assert.ok(evidence.routedPreviewRequests > 0, 'Preview requests must be served by the owned preview server')
  evidence.status = evidence.scenarios.length && evidence.scenarios.every(item => item.status === 'passed') ? 'passed' : 'failed'
  if (evidence.status !== 'passed') process.exitCode = 1
} catch (error) {
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => undefined)
  await Promise.all(owned.map(child => child.exitCode !== null ? undefined : new Promise(resolveExit => {
    const timer = setTimeout(resolveExit, 5000)
    child.once('exit', () => { clearTimeout(timer); resolveExit() })
    child.kill()
  })))
  evidence.finishedAt = new Date().toISOString()
  await writeFile(join(evidenceRoot, `editor-coverage-result${only ? '-' + only.replace(/[^a-z0-9]+/gi, '-') : ''}.json`), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ status: evidence.status, error: evidence.error, routedPreviewRequests: evidence.routedPreviewRequests, scenarios: evidence.scenarios.map(({ name, status, checks, controls, error }) => ({ name, status, checks: checks.length, controls: controls.length, error: error?.split('\n').slice(0, 6).join('\n') })) }, null, 2))
}
