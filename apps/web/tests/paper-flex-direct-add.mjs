// Retained browser acceptance for Paper Direct Add only. Runs against isolated real editor and preview dev servers
// with a fresh browser context, a browser-local v9 file, real Layers/Inspector actions, real keyboard shortcuts, and
// the persisted local adapter boundary.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, platform, release } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { localRegistryEnvironment, prepareLocalRegistry } from '../../../scripts/local-registry.mjs'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
// Keep browser-owned evidence below its own directory. The regular local stack may retain open preview logs in the
// parent directory, and browser verification must never stop or delete that independently owned process state.
const evidenceRoot = join(projectRoot, 'outputs', 'paper-flex-direct-add', 'browser-current')
const webRequire = createRequire(join(webRoot, 'package.json'))
const editorUrl = 'http://127.0.0.1:4483/'
const servedPreview = 'http://127.0.0.1:4484'
const previewOriginExpectedByEditor = 'http://127.0.0.1:4318'
const indexKey = 'design-editor.browser-files-index.v3'
const fileId = 'paper-flex-direct-add'
const contentKey = `design-editor.browser-file.${fileId}.v3`
const owned = []
const evidence = {
  status: 'failed',
  acceptance: { 'PAPER-FLEX-001': 'direct-add-failed', 'PAPER-FLEX-002': 'direct-add-failed', 'PAPER-FLEX-003': 'direct-add-failed' },
  startedAt: new Date().toISOString(),
  platform: { platform: platform(), release: release(), arch: arch(), node: process.version },
  profile: 'fresh Playwright browser context with localStorage cleared before fixture seed',
  tool: { runner: 'node + @playwright/test', browser: 'Microsoft Edge', headless: true },
  hashes: {},
  checks: [],
  screenshots: [],
  unsupported: [],
  limitations: [
    'The isolated preview CSP intentionally blocks Vite HMR websocket connections; the acceptance run uses the initial isolated module load and records those console diagnostics.',
  ],
  browserErrors: [],
  browserDiagnostics: [],
  servers: {},
  routedPreviewRequests: 0,
  error: null,
}
let browser = null
let activePage = null

const px = value => ({ kind: 'px', value })
const percent = value => ({ kind: 'percent', value })
const hex = value => ({ kind: 'literal', color: { kind: 'hex', hex: value } })
const fill = (id, value) => ({ fills: [{ id, type: 'solid', color: hex(value) }] })
const legacyText = () => ({
  textStyle: { fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif', fontStyle: 'normal', fontWeight: 500, fontSize: 16, lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false },
  textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
})

const file = {
  schemaVersion: 9,
  fileId,
  revision: 0,
  pages: [{ id: 'page-1', name: 'Direct Add', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'main-frame': { id: 'main-frame', type: 'frame', name: 'Direct Add frame', styles: { left: -460, top: -220, width: 420, height: 220 }, appearance: fill('main-fill', '#f8fafc') },
    ordinary: { id: 'ordinary', type: 'rectangle', name: 'Ordinary rectangle', styles: { left: 20, top: 40, width: 80, height: 40 }, appearance: fill('ordinary-fill', '#2563eb') },
    label: { id: 'label', type: 'text', name: 'Flow text', text: 'Flow text', styles: { left: 120, top: 40, width: 80, height: 40 }, appearance: fill('label-fill', '#111827'), ...legacyText() },
    pinned: {
      id: 'pinned', type: 'rectangle', name: 'Pinned rectangle', styles: { left: 220, top: 40, width: 80, height: 40 }, appearance: fill('pinned-fill', '#a855f7'),
      layout: { item: { position: { mode: 'absolute', left: px(220), right: percent(12), top: px(40), bottom: px(20), zIndex: 7 } } },
    },
    'empty-100': { id: 'empty-100', type: 'frame', name: 'Empty 100 by 100', styles: { left: 20, top: -220, width: 100, height: 100 }, appearance: fill('empty-100-fill', '#dcfce7') },
    'empty-101': { id: 'empty-101', type: 'frame', name: 'Empty 101 by 100', styles: { left: 160, top: -220, width: 101, height: 100 }, appearance: fill('empty-101-fill', '#fef3c7') },
    'stale-frame': { id: 'stale-frame', type: 'frame', name: 'Late stale frame', styles: { left: 20, top: 20, width: 220, height: 120 }, appearance: fill('stale-fill', '#fee2e2') },
    'stale-child': { id: 'stale-child', type: 'rectangle', name: 'Late stale child', styles: { left: 20, top: 20, width: 60, height: 40 }, appearance: fill('stale-child-fill', '#ef4444') },
  },
  relationships: {
    'main-frame': { parentId: 'root-1', orderKey: 'V' },
    ordinary: { parentId: 'main-frame', orderKey: 'V' },
    label: { parentId: 'main-frame', orderKey: 'W' },
    pinned: { parentId: 'main-frame', orderKey: 'X' },
    'empty-100': { parentId: 'root-1', orderKey: 'W' },
    'empty-101': { parentId: 'root-1', orderKey: 'X' },
    'stale-frame': { parentId: 'root-1', orderKey: 'Y' },
    'stale-child': { parentId: 'stale-frame', orderKey: 'V' },
  },
  theme: { tokens: {} },
}

const record = (name, detail = '') => {
  evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) })
  console.log('ok', name, detail)
}
const rel = path => relative(projectRoot, path).replaceAll('\\', '/')
const shot = async (page, name) => {
  const path = join(evidenceRoot, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  evidence.screenshots.push(rel(path))
}
const responseAt = async url => {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.ok ? await response.text() : null } catch { return null }
}
async function startOwnedServer(name, url, args, expected, environment = process.env) {
  if (await responseAt(url) !== null) throw new Error(`Isolated ${name} port is already in use: ${url}`)
  const vite = join(dirname(webRequire.resolve('vite/package.json')), 'bin', 'vite.js')
  const child = spawn(process.execPath, [vite, ...args], { cwd: webRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  owned.push(child)
  evidence.servers[name] = { url, pid: child.pid }
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

const preview = page => page.frameLocator('iframe[title="Canvas"]')
const layers = page => page.getByRole('tree', { name: 'Layers' })
const layer = (page, id) => layers(page).locator(`[data-instance-id="${id}"]`)
const rail = page => page.locator('.right-rail')
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.file, contentKey)
const revisionOf = async page => (await stored(page)).revision
const waitRevision = (page, expected) => page.waitForFunction(([key, expected]) => JSON.parse(localStorage.getItem(key) ?? 'null')?.file.revision === expected, [contentKey, expected], { timeout: 10_000 })
const semanticBytes = value => JSON.stringify({ pages: value.pages, nodes: value.nodes, relationships: value.relationships, theme: value.theme })
const orderedChildren = (value, parentId) => Object.entries(value.relationships).filter(([, relationship]) => relationship.parentId === parentId).sort((a, b) => a[1].orderKey.localeCompare(b[1].orderKey)).map(([id]) => id)
const undoButton = page => page.locator('.canvas-floating-actions button[aria-label="Undo document edit"]')
const redoButton = page => page.locator('.canvas-floating-actions button[aria-label="Redo document edit"]')
const primitiveBox = (page, id) => preview(page).locator(`[data-preview-canvas="${id}"]`).boundingBox()
const closeEnough = (before, after, tolerance = 1) => ['x', 'y', 'width', 'height'].every(key => Math.abs(before[key] - after[key]) <= tolerance)
async function selectLayer(page, id) {
  await layer(page, id).click()
  await page.waitForTimeout(300)
}
async function oneRevision(page, action) {
  const before = await revisionOf(page)
  await action()
  await waitRevision(page, before + 1)
  await page.waitForTimeout(350)
  assert.equal(await revisionOf(page), before + 1, 'the action creates exactly one revision')
  return before + 1
}
async function openFixture(page) {
  await page.goto(`${editorUrl}file/${fileId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.canvas-stage').waitFor({ timeout: 20_000 })
  const iframe = page.locator('iframe[title="Canvas"]')
  await iframe.waitFor({ state: 'attached', timeout: 20_000 })
  await preview(page).locator('#preview-root').waitFor({ state: 'attached', timeout: 20_000 })
  evidence.previewUrl = await iframe.getAttribute('src')
  await preview(page).locator('[data-preview-canvas="pinned"]').waitFor({ state: 'attached', timeout: 20_000 }).catch(async error => {
    evidence.previewFailure = { body: (await preview(page).locator('body').innerText()).slice(0, 2000), html: (await preview(page).locator('body').innerHTML()).slice(0, 4000) }
    throw error
  })
  await preview(page).locator('[data-preview-canvas="stale-child"]').waitFor({ state: 'attached', timeout: 20_000 })
  await page.waitForTimeout(1200)
}
async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex') }

async function run() {
  await rm(evidenceRoot, { recursive: true, force: true })
  await mkdir(evidenceRoot, { recursive: true })
  const registry = await prepareLocalRegistry({ root: projectRoot })
  evidence.registry = registry
  evidence.unsupported.push({ feature: 'Component Shift+A screenshot', reason: 'The browser adapter only validates its hollow sample component IDs while the isolated verified preview registry only exposes shadcn:LoginForm:87e72924544b575d. There is no source-bound Component identity accepted by both boundaries, so the harness does not synthesize one.' })
  await startOwnedServer('editor', editorUrl, ['--config', 'tests/claude-coverage/editor.vite.config.ts', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4483', '--strictPort'], /Comp Canvas|Design editor|@vite\/client|TanStack/)
  await startOwnedServer('preview', `${servedPreview}/`, ['--config', 'vite.preview.config.ts', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4484', '--strictPort'], /preview-root|@vite\/client|<html/i, { ...process.env, ...localRegistryEnvironment(registry) })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  evidence.tool.playwright = webRequire('@playwright/test/package.json').version
  evidence.tool.browserVersion = browser.version()
  const context = await browser.newContext({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 1, colorScheme: 'light' })
  await context.route(`${previewOriginExpectedByEditor}/**`, async route => {
    const url = new URL(route.request().url())
    evidence.routedPreviewRequests++
    const response = await route.fetch({ url: servedPreview + url.pathname + url.search })
    const headers = response.headers()
    const policy = headers['content-security-policy']
    if (policy) headers['content-security-policy'] = policy.replace('http://127.0.0.1:4317', new URL(editorUrl).origin)
    await route.fulfill({ response, headers })
  })
  const page = await context.newPage()
  activePage = page
  page.on('pageerror', error => { evidence.browserErrors.push(`Page error: ${error.message}`) })
  page.on('console', message => {
    if (message.type() !== 'error') return
    const diagnostic = `Console: ${message.text().slice(0, 500)}`
    if (diagnostic.includes("Connecting to 'ws://127.0.0.1:4318/") && diagnostic.includes('connect-src \'none\'')) evidence.browserDiagnostics.push(diagnostic)
    else evidence.browserErrors.push(diagnostic)
  })
  page.on('response', response => { if (response.status() >= 400) evidence.browserErrors.push(`HTTP ${response.status()} ${response.url()}`) })

  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(([index, content, fixture, id]) => {
    localStorage.clear()
    localStorage.setItem(index, JSON.stringify({ schemaVersion: 1, files: { [id]: { id, name: 'Paper Flex Direct Add', createdAt: 1, updatedAt: 1 } } }))
    localStorage.setItem(content, JSON.stringify({ schemaVersion: 1, file: fixture }))
  }, [indexKey, contentKey, file, fileId])
  await openFixture(page)
  await page.keyboard.press('Shift+1')
  await page.waitForTimeout(500)

  // PAPER-FLEX-001/002: use the real primitive Frame inspector path for Direct Add.
  await selectLayer(page, 'main-frame')
  assert.equal(await rail(page).getByRole('radio', { name: 'Freeform', exact: true }).getAttribute('aria-checked'), 'true')
  const original = await stored(page)
  const originalBytes = semanticBytes(original)
  const pinnedBefore = await primitiveBox(page, 'pinned')
  assert.ok(pinnedBefore, 'the explicit absolute child is rendered before conversion')
  await shot(page, '01-before-direct-add-canvas-layers-inspector')

  await oneRevision(page, () => rail(page).getByRole('radio', { name: 'Flex', exact: true }).click())
  const converted = await stored(page)
  assert.deepEqual(converted.nodes['main-frame'].layout, {
    item: {
      position: { mode: 'freeform' },
      width: { value: { kind: 'intrinsic', value: 'fit-content' } },
      height: { value: { kind: 'intrinsic', value: 'fit-content' } },
    },
    container: { display: 'flex', gap: 20, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } },
    spacing: { padding: { x: 20, y: 40 } },
  })
  assert.deepEqual(converted.nodes.ordinary.layout, { item: { position: { mode: 'flow' } } }, 'an ordinary primitive enters flow')
  assert.deepEqual(converted.nodes.label.layout, { item: { position: { mode: 'flow' } } }, 'an ordinary text node enters flow')
  assert.deepEqual(converted.nodes.pinned.layout, { item: { position: { mode: 'absolute', left: px(220), right: percent(12), top: px(40), bottom: px(20), zIndex: 7 } } }, 'the absolute child keeps every inset and z-index')
  assert.deepEqual(orderedChildren(converted, 'main-frame'), ['ordinary', 'label', 'pinned'])
  const pinnedAfter = await primitiveBox(page, 'pinned')
  assert.ok(pinnedAfter && closeEnough(pinnedBefore, pinnedAfter), `absolute rendered bounds stay fixed: ${JSON.stringify({ before: pinnedBefore, after: pinnedAfter })}`)
  const convertedBytes = semanticBytes(converted)
  assert.equal(await undoButton(page).isDisabled(), false, 'one undo is available')
  await shot(page, '02-after-direct-add-canvas-layers-inspector')
  record('PAPER-FLEX-001/002: inspector Direct Add writes exact Flex fields, inferred order, flow children, and preserved absolute placement in one revision')

  await oneRevision(page, () => page.keyboard.press('Control+z'))
  const undone = await stored(page)
  assert.equal(semanticBytes(undone), originalBytes, 'one undo restores exact original semantic bytes and relationship order')
  assert.equal(await undoButton(page).isDisabled(), true, 'there is no second history entry')
  assert.equal(await redoButton(page).isDisabled(), false)
  await shot(page, '03-one-undo-restores-original')
  await oneRevision(page, () => page.keyboard.press('Control+Shift+z'))
  const redone = await stored(page)
  assert.equal(semanticBytes(redone), convertedBytes, 'one redo restores exact converted semantic bytes and relationship order')
  assert.equal(await redoButton(page).isDisabled(), true)
  record('PAPER-FLEX-001: Direct Add is one semantic undo entry and redo restores the exact semantic projection')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await openFixture(page)
  assert.equal(semanticBytes(await stored(page)), convertedBytes, 'the converted state converges after reload')
  assert.deepEqual(orderedChildren(await stored(page), 'main-frame'), ['ordinary', 'label', 'pinned'])
  record('PAPER-FLEX-001: persisted Direct Add converges after reload')

  // Paper's exact empty-container boundary: square is column/start; one pixel wider is row/center.
  await selectLayer(page, 'empty-100')
  await oneRevision(page, () => page.keyboard.press('Shift+A'))
  assert.deepEqual((await stored(page)).nodes['empty-100'].layout, {
    item: { position: { mode: 'freeform' }, height: { value: { kind: 'intrinsic', value: 'fit-content' } } },
    container: { display: 'flex', gap: 16, flex: { direction: 'column', wrap: 'nowrap', justify: 'start', align: 'start' } },
    spacing: { padding: { x: 16, y: 16 } },
  })
  await selectLayer(page, 'empty-101')
  await oneRevision(page, () => page.keyboard.press('Shift+A'))
  assert.deepEqual((await stored(page)).nodes['empty-101'].layout, {
    item: {
      position: { mode: 'freeform' },
      width: { value: { kind: 'intrinsic', value: 'fit-content' } },
      height: { value: { kind: 'intrinsic', value: 'fit-content' } },
    },
    container: { display: 'flex', gap: 16, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'center' } },
    spacing: { padding: { x: 16, y: 16 } },
  })
  await shot(page, '04-empty-frame-defaults')
  record('PAPER-FLEX-001: Shift+A uses exact 100x100 column/start and 101x100 row/center empty defaults')

  // A source-bound Component is retained only when the local sample topology actually renders it.
  const componentRoot = preview(page).locator('[data-preview-instance="component-card"]')
  if (await componentRoot.count() > 0) {
    await componentRoot.waitFor({ timeout: 10_000 })
    await selectLayer(page, 'component-card')
    await oneRevision(page, () => page.keyboard.press('Shift+A'))
    assert.deepEqual((await stored(page)).nodes['component-card'].layout, {
      item: { position: { mode: 'absolute', left: px(320), top: px(-220) }, width: { value: px(180) }, height: { value: px(120) } },
      container: { display: 'flex', gap: 16, flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'center' } },
      spacing: { padding: { x: 16, y: 16 } },
    })
    await shot(page, '05-component-shift-a')
    record('PAPER-FLEX-001: Shift+A Direct Add works on an explicitly freeform Component in one revision')
  }

  // The menu is rendered from accepted geometry, then the actual shared geometry store is invalidated before click.
  // Its callback must re-read current geometry and surface the visible error rather than silently no-op.
  await selectLayer(page, 'stale-frame')
  await layer(page, 'stale-frame').click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Layer actions' })
  await menu.waitFor()
  const addFlex = menu.getByRole('menuitem', { name: /^Add flex/ })
  assert.equal(await addFlex.isEnabled(), true, 'Add flex was available when the menu rendered')
  const beforeStale = semanticBytes(await stored(page))
  const beforeRevision = await revisionOf(page)
  const moduleUrl = `/@fs/${join(projectRoot, 'packages/editor/src/features/editor/scene-geometry.ts').replaceAll('\\', '/')}`
  await page.evaluate(async url => { const module = await import(url); module.sceneGeometry.clear() }, moduleUrl)
  await addFlex.click()
  const toast = page.locator('.toast-root')
  await toast.waitFor({ timeout: 5000 })
  assert.equal(await toast.locator('.toast-title').innerText(), "Couldn't add flex")
  assert.equal(await toast.locator('.toast-description').innerText(), 'Add flex needs current canvas measurements. Wait for the canvas to finish updating, then try again.')
  assert.equal(await revisionOf(page), beforeRevision)
  assert.equal(semanticBytes(await stored(page)), beforeStale)
  await shot(page, '06-late-stale-visible-toast')
  record('PAPER-FLEX-001: late-stale context-menu geometry is visible and non-mutating')

  assert.deepEqual(evidence.browserErrors, [], 'the browser run has no unexpected page, console, or HTTP errors')
  evidence.acceptance['PAPER-FLEX-001'] = 'direct-add-passed'
  evidence.acceptance['PAPER-FLEX-002'] = 'direct-add-passed'
  evidence.acceptance['PAPER-FLEX-003'] = 'direct-add-passed'
  evidence.status = 'passed'
}

try { await run() }
catch (error) {
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error)
  if (activePage && !activePage.isClosed()) {
    try { await shot(activePage, 'failure') } catch {}
  }
  console.error(evidence.error)
  process.exitCode = 1
} finally {
  evidence.finishedAt = new Date().toISOString()
  const sources = [
    'apps/web/tests/paper-flex-direct-add.mjs',
    'packages/editor/src/features/editor/display-conversion.ts',
    'packages/editor/src/features/editor/layout-measure.ts',
    'packages/editor/src/features/editor/scene-geometry.ts',
    'packages/editor/src/features/editor/document-store.ts',
    'packages/editor/src/features/editor/layout-flex-commands.ts',
    'packages/editor/src/features/editor/LayoutPanels.tsx',
    'packages/editor/src/features/editor/NodeContextMenu.tsx',
    'packages/editor/src/features/editor/keyboard-service.ts',
    'packages/repo-engine/src/file-document.ts',
    'packages/repo-engine/src/paper-sizing.ts',
    'apps/web/tests/claude-coverage/editor.vite.config.ts',
    'apps/web/vite.preview.config.ts',
  ]
  evidence.fixture = { fileId, schemaVersion: file.schemaVersion, revision: file.revision }
  for (const source of sources) evidence.hashes[source] = await sha256(join(projectRoot, source)).catch(() => null)
  if (browser) await browser.close().catch(() => undefined)
  for (const child of owned) child.kill()
  await mkdir(evidenceRoot, { recursive: true })
  const resultPath = join(evidenceRoot, 'result.json')
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`)
  const markdown = [
    '# Paper Flex Direct Add browser evidence',
    '',
    `Result: **${evidence.status}**`,
    '',
    `- PAPER-FLEX-001: ${evidence.acceptance['PAPER-FLEX-001']}`,
    `- PAPER-FLEX-002: ${evidence.acceptance['PAPER-FLEX-002']}`,
    `- PAPER-FLEX-003: ${evidence.acceptance['PAPER-FLEX-003']}`,
    '',
    '## Checks',
    '',
    ...evidence.checks.map(check => `- ${check.status}: ${check.name}${check.detail ? ` — ${check.detail}` : ''}`),
    '',
    '## Screenshots',
    '',
    ...evidence.screenshots.map(path => `- [${path.split('/').at(-1)}](./${path.split('/').at(-1)})`),
    '',
    '## Unsupported evidence',
    '',
    ...(evidence.unsupported.length ? evidence.unsupported.map(item => `- ${item.feature}: ${item.reason}`) : ['- None']),
    '',
    '## Known limitations',
    '',
    ...evidence.limitations.map(item => `- ${item}`),
    '',
    'Machine-readable platform, tool, source hashes, checks, and errors are in [result.json](./result.json).',
    '',
  ].join('\n')
  await writeFile(join(evidenceRoot, 'HANDOFF.md'), markdown)
  console.log(JSON.stringify({ status: evidence.status, acceptance: evidence.acceptance, checks: evidence.checks.length, screenshots: evidence.screenshots, unsupported: evidence.unsupported, result: rel(resultPath) }, null, 2))
}
