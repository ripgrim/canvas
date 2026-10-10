import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const outputRoot = join(projectRoot, 'outputs', 'naming-menus')
const editorUrl = 'http://127.0.0.1:4317/'
const previewUrl = 'http://127.0.0.1:4318/'
const webRequire = createRequire(join(webRoot, 'package.json'))
const owned = []
const evidence = { status: 'failed', checks: [], screenshots: [], error: null }

const responseAt = async url => { try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.ok ? await response.text() : null } catch { return null } }
async function ensureServer(name, url, args, expected) {
  if (await responseAt(url) !== null) return
  const vite = join(dirname(webRequire.resolve('vite/package.json')), 'bin', 'vite.js')
  const child = spawn(process.execPath, [vite, ...args], { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  owned.push(child)
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

const record = (name, detail = '') => { evidence.checks.push({ name, status: 'passed', detail }); console.log('✓', name, detail) }
const shot = async (page, name) => { const path = join(outputRoot, `${name}.png`); await page.screenshot({ path }); evidence.screenshots.push(path) }
const pageIdOf = page => new URL(page.url()).searchParams.get('pageId')
const menuTheme = menu => menu.evaluate(element => {
  const root = element.closest('.editor-root')
  const style = getComputedStyle(element)
  return { insideEditorRoot: Boolean(root), rootClass: root?.className ?? '', background: style.backgroundColor, color: style.color }
})

async function run() {
  await mkdir(outputRoot, { recursive: true })
  await ensureServer('editor', editorUrl, ['--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4317', '--strictPort'], /Comp Canvas|Design editor|@vite\/client|TanStack/)
  await ensureServer('preview', previewUrl, ['--config', 'vite.preview.config.ts', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4318', '--strictPort'], /preview-root|@vite\/client|<html/i)
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 940 } })
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /New file/i }).first().click()
    await page.locator('.canvas-stage').waitFor({ timeout: 20_000 })
    if (await page.locator('.editor-root.theme-dark').count()) await page.getByRole('button', { name: 'Switch editor appearance to light' }).click()

    let pageRow = page.locator('.sidebar-page-row').filter({ hasText: 'Page 1' })
    await pageRow.dblclick()
    const pageName = page.getByRole('textbox', { name: 'Rename Page 1' })
    await pageName.fill('Home')
    await pageName.press('Enter')
    pageRow = page.locator('.sidebar-page-row').filter({ hasText: 'Home' })
    await pageRow.waitFor()
    record('Double-click page rename commits through the shared inline editor')

    await pageRow.click({ button: 'right' })
    const pageMenu = page.getByRole('menu', { name: 'Page actions' })
    await pageMenu.waitFor()
    const lightMenuTheme = await menuTheme(pageMenu)
    assert.equal(lightMenuTheme.insideEditorRoot, true)
    assert.match(lightMenuTheme.rootClass, /theme-light/)
    const menuZ = Number(await page.locator('.context-menu-layer').evaluate(element => getComputedStyle(element).zIndex))
    const toolbarZ = Number(await page.locator('.tool-rail').evaluate(element => getComputedStyle(element).zIndex))
    assert.ok(menuZ > toolbarZ, `context menu z-index ${menuZ} must exceed toolbar ${toolbarZ}`)
    const deletePage = page.getByRole('menuitem', { name: 'Delete page' })
    assert.equal(await deletePage.isDisabled(), true)
    assert.equal(await deletePage.getAttribute('title'), 'A file must keep at least one page.')
    const pageMenuWidth = await pageMenu.evaluate(element => element.getBoundingClientRect().width)
    assert.ok(pageMenuWidth >= 160 && pageMenuWidth < 240, `page actions fit their content instead of inheriting the 240px layer-menu width: ${pageMenuWidth}`)
    await shot(page, '01-page-menu-last-page')
    await page.keyboard.press('Escape')
    await pageMenu.waitFor({ state: 'detached' })

    await page.getByRole('button', { name: 'Switch editor appearance to dark' }).click()
    await pageRow.click({ button: 'right' })
    await pageMenu.waitFor()
    const darkMenuTheme = await menuTheme(pageMenu)
    assert.equal(darkMenuTheme.insideEditorRoot, true)
    assert.match(darkMenuTheme.rootClass, /theme-dark/)
    assert.notDeepEqual({ background: darkMenuTheme.background, color: darkMenuTheme.color }, { background: lightMenuTheme.background, color: lightMenuTheme.color })
    await shot(page, '02-page-menu-dark-theme')
    await page.keyboard.press('Escape')
    await pageMenu.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Switch editor appearance to light' }).click()
    record('Portaled context menus stay inside the Wonder theme root in light and dark appearances')

    await pageRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename page' }).click()
    const sharedPageRename = page.getByRole('textbox', { name: 'Rename Home' })
    await sharedPageRename.waitFor()
    await sharedPageRename.fill('Cancelled')
    await sharedPageRename.press('Escape')
    assert.equal(await page.locator('.sidebar-page-row').filter({ hasText: 'Home' }).count(), 1)
    record('Page menu rename uses the same editor; Escape cancels without changing the page')

    const homePageId = pageIdOf(page)
    assert.ok(homePageId)
    await page.getByRole('button', { name: 'Add page' }).click()
    await page.waitForFunction(id => new URL(location.href).searchParams.get('pageId') !== id, homePageId)
    await page.locator('.sidebar-page-row').filter({ hasText: 'Page 1' }).waitFor()
    const secondPage = page.locator('.sidebar-page-row').filter({ hasText: 'Page 1' })
    await secondPage.click({ button: 'right' })
    assert.equal(await page.getByRole('menuitem', { name: 'Delete page' }).isEnabled(), true)
    await page.getByRole('menuitem', { name: 'Delete page' }).click()
    await page.waitForFunction(id => new URL(location.href).searchParams.get('pageId') === id, homePageId)
    assert.equal(await page.locator('.sidebar-page-row').count(), 1)
    assert.equal(await page.locator('.sidebar-page-row').filter({ hasText: 'Home' }).getAttribute('aria-current'), 'page')
    record('Deleting the active page navigates to the surviving page and preserves the last-page guard')

    const expand = page.getByRole('button', { name: /Expand Components/ })
    if (await expand.count()) await expand.click()
    await page.getByRole('button', { name: 'Add Button', exact: true }).click()
    let layer = page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Button', exact: true })
    await layer.waitFor()
    await layer.click({ button: 'right' })
    const layerMenu = page.getByRole('menu', { name: 'Layer actions' })
    await layerMenu.waitFor()
    assert.ok(Number(await page.locator('.context-menu-layer').evaluate(element => getComputedStyle(element).zIndex)) > toolbarZ)
    await page.keyboard.press('Escape')
    await layerMenu.waitFor({ state: 'detached' })
    assert.equal(await layer.getAttribute('aria-selected'), 'true')
    record('First Escape closes the layer menu without clearing selection')

    await layer.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename Button' }).click()
    const layerName = page.getByRole('textbox', { name: 'Rename Button' })
    await layerName.waitFor()
    assert.equal(await layerName.count(), 1)
    assert.equal(await page.locator('.node-label-editor').count(), 0)
    await layerName.fill('Cancelled')
    await layerName.press('Escape')
    assert.equal(await layer.getAttribute('aria-selected'), 'true')
    assert.equal(await layer.getAttribute('aria-label'), 'Button')

    await layer.dblclick()
    const doubleClickRename = page.getByRole('textbox', { name: 'Rename Button' })
    assert.equal(await doubleClickRename.count(), 1)
    assert.equal(await page.locator('.node-label-editor').count(), 0)
    await doubleClickRename.fill('Primary action')
    await shot(page, '03-layer-inline-rename')
    await doubleClickRename.press('Enter')
    layer = page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Primary action', exact: true })
    await layer.waitFor()
    assert.equal(await layer.getAttribute('aria-selected'), 'true')
    await shot(page, '04-layer-rename-committed')
    record('Layer menu and double-click share the inline editor; Escape cancels and Enter commits')
    evidence.status = 'passed'
  } finally {
    await browser.close()
  }
}

try { await run() } catch (error) { evidence.error = error instanceof Error ? error.stack : String(error); console.error(evidence.error); process.exitCode = 1 }
finally {
  for (const child of owned) child.kill()
  await mkdir(outputRoot, { recursive: true })
  await writeFile(join(outputRoot, 'evidence.json'), JSON.stringify(evidence, null, 2))
}
