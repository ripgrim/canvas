import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const outputRoot = join(projectRoot, 'outputs', 'repository-token-import')
const fileId = '22222222-2222-4222-8222-222222222222'
const editorUrl = 'http://127.0.0.1:4317/'
const webRequire = createRequire(join(webRoot, 'package.json'))
const owned = []
const evidence = { status: 'failed', checks: [], screenshots: [], error: null }
let activePage = null

const responseAt = async url => { try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.ok ? await response.text() : null } catch { return null } }
async function ensureServer() {
  if (await responseAt('http://127.0.0.1:4317/') !== null) return
  const vite = join(dirname(webRequire.resolve('vite/package.json')), 'bin', 'vite.js')
  const child = spawn(process.execPath, [vite, '--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4317', '--strictPort'], { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  owned.push(child)
  let log = ''
  child.stdout.on('data', chunk => { log = (log + String(chunk)).slice(-4000) })
  child.stderr.on('data', chunk => { log = (log + String(chunk)).slice(-4000) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Editor exited: ${log}`)
    if (await responseAt('http://127.0.0.1:4317/') !== null) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Editor did not start: ${log}`)
}

const file = {
  schemaVersion: 9, fileId, revision: 0,
  pages: [{ id: 'page-1', name: 'Tokens', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' } }, relationships: {}, theme: { tokens: {} },
}
const snapshot = {
  projectId: fileId, fileId: file.fileId, atoms: [], sourceHashes: {},
  composition: { id: 'composition', name: 'Tokens', componentId: null, children: [] }, file,
  sourceHistory: [], conflict: null, phases: [], tokens: [], designThemes: [],
  preview: { status: 'stopped', currentGeneration: 0, activeGeneration: null, origin: null, url: null, stale: false, diagnostics: ['Preview is not required for this acceptance test.'] },
}
const token = (name, value, theme = 'base') => ({ name, value, theme, path: 'src/globals.css', selector: theme === 'dark' ? '.dark' : ':root', atRules: ['@layer base'], aliases: [...value.matchAll(/var\((--[A-Za-z0-9_-]+)/g)].map(match => match[1]), line: 1, column: 1 })
const component = (exportName, path, propCount) => ({ path, exportName, declarationKind: 'function', props: Array.from({ length: propCount }, (_, index) => ({ name: `prop${index + 1}`, type: 'string', optional: true })), slots: ['children'], sourceHash: 'hash', fingerprint: `fingerprint-${exportName}` })
const components = [
  component('Accordion', 'packages/ui/src/components/accordion.tsx', 18),
  component('Button', 'packages/ui/src/components/button.tsx', 12),
  ...['Card', 'Checkbox', 'Dialog', 'Input', 'Label', 'Popover', 'Select', 'Tabs'].map(name => component(name, `packages/ui/src/components/${name.toLowerCase()}.tsx`, 6)),
]
const colorTokens = [
  token('--background', 'oklch(1 0 0)'),
  token('--background', 'oklch(0.2 0 0)', 'dark'),
  token('--brand', '#685fff'),
  token('--color-background', 'var(--background)', 'custom'),
  token('--accent', '#0f766e'),
  token('--accent-blue', '#3b82f6'),
  token('--accent-foreground', '#111827'),
  token('--border', '#d4d4d8'),
  token('--destructive', '#dc2626'),
  token('--foreground', '#18181b'),
  token('--muted', '#f4f4f5'),
  token('--primary', '#18181b'),
  token('--secondary', '#e4e4e7'),
]
const connection = {
  repository: { id: '11111111-1111-4111-8111-111111111111', name: 'UI repository', source: 'local' },
  scan: {
    adapterId: 'shadcn-v1', configs: [{ source: 'inferred', path: 'apps/web/package.json', workspace: 'apps/web', uiAlias: null, uiRoots: ['apps/web/src/components/ui'], registryRoots: [], tokenFiles: ['apps/web/src/styles.css'], registries: [] }], sourceHashes: {},
    components,
    tokens: [...colorTokens, token('--radius', '0.5rem'), token('--font-sans', '"Geist Variable", sans-serif', 'custom'), token('--font-heading', 'var(--font-sans)', 'custom')],
    diagnostics: Array.from({ length: 12 }, (_, index) => ({ code: 'unsupported-export', path: `packages/ui/src/components/helper-${index}.tsx`, message: `Helper${index} is not a component.` })),
  },
}

const record = name => { evidence.checks.push(name); console.log('✓', name) }

async function run() {
  await mkdir(outputRoot, { recursive: true })
  await ensureServer()
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 940 } })
    activePage = page
    page.on('pageerror', error => { evidence.checks.push(`page error: ${error.message}`) })
    page.on('console', message => { if (message.type() === 'error') evidence.checks.push(`console error: ${message.text()}`) })
    await page.addInitScript(({ initial, repository }) => {
      let current = structuredClone(initial)
      let connected = structuredClone(repository)
      window.__repositoryTokenSaved = structuredClone(current.file)
      window.__setRepositoryScan = scan => { connected = { ...connected, scan: structuredClone(scan) } }
      const unavailable = async () => { throw new Error('Unavailable in repository token acceptance test.') }
      window.designEditor = {
        inspectFixture: async () => structuredClone(current), refresh: async () => structuredClone(current),
        saveFile: async (next, expectedRevision) => {
          if (expectedRevision !== current.file.revision) throw new Error('Revision conflict')
          current = { ...current, file: { ...structuredClone(next), revision: expectedRevision + 1 } }
          window.__repositoryTokenSaved = structuredClone(current.file)
          return structuredClone(current)
        },
        getConnectedRepository: async () => structuredClone(connected), rescanConnectedRepository: async () => structuredClone(connected),
        pickLocalRepository: async () => null, cloneGitHubRepository: unavailable,
        prepareLabelPadding: unavailable, prepareToken: unavailable, preparePromotion: unavailable, prepareUndo: unavailable, prepareRedo: unavailable, savePrepared: unavailable,
      }
    }, { initial: snapshot, repository: connection })
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Open fixture', exact: true }).first().click()
    await page.locator('.canvas-stage').waitFor({ timeout: 20_000 })
    await page.getByText('Preview is not connected.', { exact: true }).waitFor()
    assert.equal(await page.locator('.canvas-hud-canvas').count(), 0)
    assert.equal(await page.locator('[data-node-label]').count(), 0)
    assert.equal(await page.locator('.canvas-stage').getAttribute('data-inactive'), 'true')
    record('A disconnected preview exposes no stale node chrome or invisible canvas interaction plane')
    await page.screenshot({ path: join(outputRoot, '00-disconnected-preview.png'), fullPage: true })
    evidence.screenshots.push('00-disconnected-preview.png')
    const rail = page.locator('.right-rail')
    await rail.locator('details').filter({ has: page.locator(':scope > summary', { hasText: 'Repository' }) }).locator(':scope > summary').click()
    await rail.getByText('12 importable color tokens found', { exact: false }).waitFor()
    await rail.getByText('Auto-detected', { exact: true }).waitFor()
    await rail.getByText('apps/web', { exact: true }).waitFor()
    record('Inferred monorepo discovery is named instead of presented as an unexplained empty scan')

    const componentDisclosure = rail.locator('details').filter({ has: page.locator(':scope > summary', { hasText: 'Components (10)' }) })
    await componentDisclosure.locator(':scope > summary').click()
    assert.equal(await componentDisclosure.locator('.repository-row[data-kind="component"]').count(), 10)
    assert.match(await componentDisclosure.locator('.repository-row').first().innerText(), /Accordion.*18 props.*1 slots/s)
    assert.equal(await componentDisclosure.getByText('prop1', { exact: true }).count(), 0, 'full prop inventory must not spam the component row')
    const componentViewport = componentDisclosure.locator('.repository-scroll-viewport')
    assert.equal(await componentViewport.count(), 1)
    assert.equal(await componentViewport.evaluate(element => element.scrollHeight > element.clientHeight), true)
    record('Components render as dedicated compact icon rows without expanded prop spam')

    const tokens = rail.locator('details').filter({ has: page.locator(':scope > summary', { hasText: 'Tokens (12)' }) })
    await tokens.locator(':scope > summary').click()
    assert.equal(await tokens.locator('.repository-row[data-kind="token"]').count(), 12)
    assert.equal(await tokens.locator('.theme-swatch').count(), 12)
    assert.match(await tokens.innerText(), /3 non-color variables were hidden/)
    const aliasSwatch = tokens.locator('.repository-row').filter({ hasText: '--color-background' }).locator('.theme-swatch-fill')
    assert.match(await aliasSwatch.evaluate(element => getComputedStyle(element).backgroundColor), /^(?:oklch\(1 0 0\)|rgb\(255, 255, 255\))$/)
    assert.equal(await tokens.getByText('Font heading', { exact: true }).count(), 0)
    const tokenViewport = tokens.locator('.repository-scroll-viewport')
    assert.equal(await tokenViewport.count(), 1)
    assert.equal(await tokenViewport.evaluate(element => element.scrollHeight > element.clientHeight), true)
    await tokenViewport.focus()
    await page.keyboard.press('PageDown')
    assert.ok(await tokenViewport.evaluate(element => element.scrollTop > 0))
    await tokenViewport.evaluate(element => { element.scrollTop = 0 })
    await tokenViewport.hover()
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(100)
    assert.ok(await tokenViewport.evaluate(element => element.scrollTop > 0))
    record('Long component and token catalogs use bounded nested scroll viewports')
    record('The token viewport handles keyboard and wheel scrolling')
    record('Theme variants deduplicate into color rows with swatches and non-color values hidden')
    await rail.screenshot({ path: join(outputRoot, '01-compact-catalog.png') })
    evidence.screenshots.push('01-compact-catalog.png')

    await tokenViewport.evaluate(element => { element.scrollTop = 0 })
    const tokenRows = tokens.locator('.repository-row[data-kind="token"]')
    const selectAllTokens = tokens.getByRole('checkbox', { name: 'Select all tokens', exact: true })
    await selectAllTokens.check()
    assert.equal(await tokens.locator('.repository-row[data-kind="token"] .repository-select:checked').count(), 12)
    await tokens.getByRole('button', { name: 'Import 12', exact: true }).waitFor()
    await selectAllTokens.uncheck()
    assert.equal(await tokens.locator('.repository-row[data-kind="token"] .repository-select:checked').count(), 0)
    record('Select all selects every importable token and clears the same set')

    await tokenRows.nth(0).locator('.repository-row-body').click()
    await tokenRows.nth(3).locator('.repository-row-body').click({ modifiers: ['Shift'] })
    assert.equal(await tokens.locator('.repository-row[data-kind="token"] .repository-select:checked').count(), 4)
    assert.equal(await tokenRows.nth(0).evaluate(element => getComputedStyle(element).userSelect), 'none')
    record('Shift-click selects the contiguous range from the last token interaction')
    record('Token rows prevent accidental text selection')
    await selectAllTokens.check()
    await selectAllTokens.uncheck()

    const firstTokenRow = tokenRows.nth(0)
    await firstTokenRow.locator('.repository-row-body').click()
    assert.equal(await firstTokenRow.locator('.repository-select').isChecked(), true)
    await firstTokenRow.locator('.repository-row-body').click()
    assert.equal(await firstTokenRow.locator('.repository-select').isChecked(), false)
    await firstTokenRow.locator('.repository-row-body').click()
    assert.equal(await firstTokenRow.locator('.repository-select').isChecked(), true)
    record('Clicking a token row toggles its selection on and off')
    assert.equal(await tokens.getByRole('button', { name: 'Import 2', exact: true }).count(), 0)
    const thirdTokenRow = tokens.locator('.repository-row[data-kind="token"]').nth(2)
    await thirdTokenRow.getByRole('button', { name: 'Import', exact: true }).click()
    await page.waitForFunction(() => Object.keys(window.__repositoryTokenSaved.theme.tokens).length === 1)
    assert.equal(await thirdTokenRow.locator('.repository-select').isChecked(), false)
    await page.getByRole('button', { name: 'Undo document edit', exact: true }).click()
    await page.waitForFunction(() => Object.keys(window.__repositoryTokenSaved.theme.tokens).length === 0)
    record('A nested Import action does not also toggle its row')
    await tokenRows.nth(1).locator('.repository-select').check()
    const bulkImport = tokens.getByRole('button', { name: 'Import 2', exact: true })
    await bulkImport.waitFor()
    assert.equal(await tokenViewport.getByRole('button', { name: 'Import 2', exact: true }).count(), 0)
    const tokenSurface = tokens.locator('.repository-scroll-area')
    assert.equal(await tokenSurface.getByRole('button', { name: 'Import 2', exact: true }).count(), 1)
    await tokenViewport.evaluate(element => { element.scrollTop = element.scrollHeight })
    assert.equal(await bulkImport.isVisible(), true)
    const actionGeometry = await tokenSurface.evaluate((surface) => {
      const button = surface.querySelector('.repository-bulk-bar .button')
      if (!(button instanceof HTMLElement)) return null
      const surfaceBox = surface.getBoundingClientRect()
      const buttonBox = button.getBoundingClientRect()
      return { widthRatio: buttonBox.width / surfaceBox.width, bottomInset: surfaceBox.bottom - buttonBox.bottom }
    })
    assert.ok(actionGeometry && actionGeometry.widthRatio > 0.9 && actionGeometry.bottomInset >= 0 && actionGeometry.bottomInset <= 8)
    assert.match(await tokens.locator('.repository-bulk-bar').evaluate(element => getComputedStyle(element, '::before').backgroundImage), /^linear-gradient/)
    record('Bulk Import N appears only when at least two tokens are selected')
    record('Bulk import spans the bottom of the inset surface above a progressive row fade')
    await tokenViewport.evaluate(element => { element.scrollTop = Math.min(180, element.scrollHeight - element.clientHeight) })
    await rail.screenshot({ path: join(outputRoot, '02-bulk-selection.png') })
    evidence.screenshots.push('02-bulk-selection.png')

    await bulkImport.click()
    await page.waitForFunction(() => Object.keys(window.__repositoryTokenSaved.theme.tokens).length === 2)
    const imported = await page.evaluate(() => Object.values(window.__repositoryTokenSaved.theme.tokens).map(token => token.value))
    assert.deepEqual(imported.map(value => value.kind), ['source', 'source'])
    assert.deepEqual(imported.map(value => value.property), ['--accent', '--accent-blue'])
    assert.equal(await tokens.getByRole('button', { name: 'Imported', exact: true }).count(), 2)
    record('Bulk import writes two source-backed design tokens and marks their rows imported')
    await rail.screenshot({ path: join(outputRoot, '03-imported.png') })
    evidence.screenshots.push('03-imported.png')

    await page.getByRole('button', { name: 'Undo document edit', exact: true }).click()
    await page.waitForFunction(() => Object.keys(window.__repositoryTokenSaved.theme.tokens).length === 0)
    record('One Undo removes the complete bulk import')

    const diagnostics = rail.locator('details').filter({ has: page.locator(':scope > summary', { hasText: 'scanner diagnostics' }) })
    await diagnostics.locator(':scope > summary').click()
    assert.equal(await diagnostics.locator('.repository-diagnostic').count(), 1)
    assert.match(await diagnostics.innerText(), /unsupported export.*12.*Non-component helpers and providers were skipped/is)
    assert.equal(await diagnostics.getByText(/helper-1\.tsx/).count(), 0)
    record('Unsupported exports collapse into one grouped diagnostic instead of twelve messages')

    await page.evaluate(() => window.__setRepositoryScan({ adapterId: 'shadcn-v1', configs: [], components: [], tokens: [], sourceHashes: {}, diagnostics: [] }))
    await rail.getByRole('button', { name: 'Scan again', exact: true }).click()
    await rail.getByText('No supported UI source found', { exact: true }).waitFor()
    assert.equal(await rail.getByText(/0 components and 0 importable color tokens found/).count(), 0)
    record('Repositories without a supported entry point show an actionable state instead of a successful zero-result scan')
    evidence.status = 'passed'
  } finally {
    await browser.close()
  }
}

try { await run() } catch (error) { evidence.error = error instanceof Error ? error.stack : String(error); if (activePage && !activePage.isClosed()) { evidence.checks.push(`page text: ${(await activePage.locator('body').innerText().catch(() => '')).slice(0, 1000)}`); await activePage.screenshot({ path: join(outputRoot, 'failure.png') }).catch(() => undefined) }; console.error(evidence.error); process.exitCode = 1 }
finally {
  for (const child of owned) child.kill()
  await mkdir(outputRoot, { recursive: true })
  await writeFile(join(outputRoot, 'evidence.json'), JSON.stringify(evidence, null, 2))
}
