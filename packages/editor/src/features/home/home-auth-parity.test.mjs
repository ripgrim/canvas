import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const output = join(root, 'outputs', 'home-auth-parity')
const homeUrl = process.env.CANVAS_HOME_URL ?? 'http://127.0.0.1:4317/'
const loginUrl = process.env.CANVAS_LOGIN_URL ?? 'http://127.0.0.1:4319/'
const evidence = { status: 'failed', acceptance: ['AT-UX-003', 'AT-AUTH-001'], viewports: ['1500x922', '480x800'], checks: [], screenshots: [], error: null }
let browser

const record = (name, detail = '') => {
  evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) })
  console.log('✓', name, detail)
}

const shot = async (page, name) => {
  await page.screenshot({ path: join(output, `${name}.png`) })
  evidence.screenshots.push(`${name}.png`)
}

try {
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1500, height: 922 } })
  const home = await context.newPage()
  await home.goto(homeUrl, { waitUntil: 'domcontentloaded' })
  await home.getByRole('heading', { name: 'Recents' }).waitFor()
  const sidebar = await home.locator('.home-sidebar').boundingBox()
  assert.ok(sidebar && Math.abs(sidebar.width - 240) < 1, 'Recents must keep the observed 240-pixel rail')
  await shot(home, '01-empty')
  record('Recents opens with the observed rail and an honest empty state')

  for (let index = 1; index <= 4; index += 1) {
    await home.getByRole('button', { name: 'New file' }).click()
    await home.waitForURL(/\/file\//)
    await home.goto(homeUrl, { waitUntil: 'domcontentloaded' })
    await home.getByRole('button', { name: `Open Untitled ${index}` }).waitFor()
  }
  assert.equal(await home.locator('.home-file-card').count(), 4)
  const gridThumbnail = await home.locator('.home-file-thumbnail').first().boundingBox()
  assert.ok(gridThumbnail && Math.abs(gridThumbnail.width / gridThumbnail.height - 256 / 168) < 0.02, 'Grid thumbnails must use the observed ratio')
  await shot(home, '02-grid')
  record('New file persists and returns to the observed desktop grid')

  await home.getByRole('button', { name: 'List view' }).click()
  const listThumbnail = await home.locator('.home-file-thumbnail').first().boundingBox()
  assert.ok(listThumbnail && Math.abs(listThumbnail.width - 96) < 1, 'List thumbnails must keep the observed width')
  await shot(home, '03-list')
  record('List view keeps the observed compact thumbnail treatment')

  await home.getByRole('searchbox', { name: 'Search' }).fill('missing')
  await home.getByText('No results', { exact: true }).waitFor()
  await shot(home, '04-no-results')
  record('Search has an independent no-results state')

  await home.setViewportSize({ width: 480, height: 800 })
  await home.goto(homeUrl, { waitUntil: 'domcontentloaded' })
  await home.getByRole('heading', { name: 'Recents' }).waitFor()
  const compactSidebar = await home.locator('.home-sidebar').boundingBox()
  const overflow = await home.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(compactSidebar && Math.abs(compactSidebar.width - 56) < 1, 'Compact home must collapse to an icon rail')
  assert.ok(overflow <= 0, 'Compact home must not overflow horizontally')
  assert.equal(await home.getByRole('button', { name: 'New file' }).isVisible(), true)
  await home.getByRole('searchbox', { name: 'Search' }).fill('Untitled 2')
  const compactSearch = await home.getByRole('searchbox', { name: 'Search' }).boundingBox()
  assert.ok(compactSearch && compactSearch.width > 100, 'Compact search must expand while focused')
  assert.equal(await home.locator('.home-file-card').count(), 1)
  await shot(home, '05-compact')
  record('Compact home keeps New file and an expanding search visible without horizontal clipping')

  const login = await context.newPage()
  await login.goto(loginUrl, { waitUntil: 'domcontentloaded' })
  await login.getByRole('heading', { name: 'Canvas' }).waitFor()
  assert.equal(await login.getByLabel('Work email').isEnabled(), false)
  assert.equal(await login.getByRole('button', { name: 'Continue with Google' }).isEnabled(), false)
  assert.equal(await login.getByText('Google sign-in is not configured.', { exact: true }).count(), 0)
  assert.equal(await login.getByRole('button', { name: 'Continue with GitHub' }).isEnabled(), true)
  await login.setViewportSize({ width: 1500, height: 922 })
  await shot(login, '06-sign-in')
  record('Sign in shows both provider treatments without enabling an unconfigured provider')
  evidence.status = 'passed'
} catch (error) {
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(evidence.error)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  await writeFile(join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, screenshots: evidence.screenshots.length }))
}
