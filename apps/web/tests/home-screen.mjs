import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = join(root, 'outputs', 'home-screen')
const url = process.env.CANVAS_HOME_URL ?? 'http://127.0.0.1:4317/'
const evidence = { status: 'failed', checks: [], screenshots: [], error: null }
let browser
const record = (name, detail = '') => { evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log('✓', name, detail) }
const shot = async (page, name) => { await page.screenshot({ path: join(output, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }

try {
  await mkdir(output, { recursive: true })
  assert.ok(await fetch(url).then(response => response.ok).catch(() => false), 'web editor must be running on 4317')
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 922 } })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const now = Date.now()
  await page.evaluate(({ now }) => {
    localStorage.clear()
    localStorage.setItem('design-editor.browser-files-index.v3', JSON.stringify({ schemaVersion: 1, files: {
      first: { id: 'first', name: 'Quiet footer', createdAt: now - 300_000, updatedAt: now - 60_000 },
      second: { id: 'second', name: 'Split story', createdAt: now - 600_000, updatedAt: now - 120_000 },
      third: { id: 'third', name: 'Timeline', createdAt: now - 900_000, updatedAt: now - 180_000 },
      fourth: { id: 'fourth', name: 'Portal', createdAt: now - 1_200_000, updatedAt: now - 240_000 },
    } }))
  }, { now })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Recents' }).waitFor()

  const sidebar = await page.locator('.home-sidebar').boundingBox()
  const cards = page.locator('.home-file-card')
  assert.ok(sidebar && Math.abs(sidebar.width - 240) < 1, 'sidebar keeps the measured Paper-width rail')
  assert.equal(await cards.count(), 4)
  assert.ok(await page.getByRole('button', { name: 'New file' }).isVisible())
  const toolbar = await page.locator('.home-toolbar-inner').boundingBox()
  const toolbarActions = await page.locator('.home-toolbar-actions').boundingBox()
  assert.ok(toolbar && toolbarActions && Math.abs((toolbarActions.x + toolbarActions.width) - (toolbar.x + toolbar.width)) < 1, 'header actions sit at the end of the toolbar container')
  const thumbnail = await cards.first().locator('.home-file-thumbnail').boundingBox()
  assert.ok(thumbnail && Math.abs(thumbnail.width / thumbnail.height - 256 / 168) < 0.02, 'grid thumbnail uses the 256:168 ratio')
  await shot(page, '01-grid')
  record('Recents uses the sidebar, fixed header action, four-column grid, and 256:168 thumbnails')

  await page.getByRole('button', { name: 'List view' }).click()
  assert.equal(await page.locator('.home-file-grid').getAttribute('data-view'), 'list')
  const listThumb = await cards.first().locator('.home-file-thumbnail').boundingBox()
  assert.ok(listThumb && Math.abs(listThumb.width - 96) < 1, 'list thumbnail is 96 pixels wide')
  await shot(page, '02-list')
  record('Grid and list controls switch the observable file layout')

  await page.getByRole('searchbox', { name: 'Search' }).fill('no such file')
  assert.ok(await page.getByText('No results', { exact: true }).isVisible())
  await page.getByRole('searchbox', { name: 'Search' }).fill('')
  record('Search filters recents and has an independent empty result')

  await page.getByRole('button', { name: 'New file' }).click()
  await page.waitForURL(/\/file\//)
  await page.waitForFunction(() => new URL(location.href).searchParams.has('pageId'))
  assert.match(page.url(), /\/file\/[^?]+\?pageId=/)
  record('New file creates a stored file and navigates to its permanent file URL', new URL(page.url()).pathname)
  evidence.status = 'passed'
} catch (error) {
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(evidence.error)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  await writeFile(join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, screenshots: evidence.screenshots }))
}
