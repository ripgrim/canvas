import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const outputRoot = join(projectRoot, 'outputs', 'component-insertion')
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
const preview = page => page.frameLocator('iframe[title="Canvas"]')
const selectedLayer = (page, name) => page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name, exact: true }).filter({ has: page.locator('[aria-selected="true"]') })

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
    await preview(page).locator('#preview-root').waitFor({ state: 'attached', timeout: 20_000 })
    const expand = page.getByRole('button', { name: /Expand Components/ })
    if (await expand.count()) await expand.click()

    assert.equal(await page.getByText('From code', { exact: true }).count(), 0, 'redundant library label is absent')
    assert.equal(await page.getByRole('button', { name: 'Add Card', exact: true }).innerText(), 'Card')
    await page.getByRole('button', { name: 'Add Card', exact: true }).click()
    const cardLayer = page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Card', exact: true })
    await cardLayer.waitFor()
    assert.equal(await cardLayer.getAttribute('aria-selected'), 'true')
    const cardId = await cardLayer.getAttribute('data-instance-id')
    const card = preview(page).locator(`[data-preview-instance="${cardId}"]`)
    await card.waitFor({ state: 'visible', timeout: 20_000 })
    const cardBox = await card.boundingBox()
    const stageBox = await page.locator('.canvas-stage').boundingBox()
    assert.ok(cardBox && stageBox && cardBox.x >= stageBox.x && cardBox.y >= stageBox.y && cardBox.x < stageBox.x + stageBox.width && cardBox.y < stageBox.y + stageBox.height, 'clicked Card is inside the visible canvas')
    assert.ok(Math.abs(cardBox.x - (stageBox.x + stageBox.width / 2)) < 2 && Math.abs(cardBox.y - (stageBox.y + stageBox.height / 2)) < 2, 'click insertion starts at the visible canvas center')
    assert.deepEqual(await card.evaluate(element => ({ tag: element.tagName, className: element.className })), { tag: 'SECTION', className: 'fixture-card' })
    const clickShot = join(outputRoot, '01-click-card.png')
    await page.screenshot({ path: clickShot })
    evidence.screenshots.push(clickShot)
    record('Click adds a visible real Card and selects the same layer identity', cardId)

    await page.getByRole('button', { name: 'Undo document edit' }).click()
    await card.waitFor({ state: 'detached' })
    const stage = page.locator('.canvas-stage')
    await page.getByRole('button', { name: 'Add Button', exact: true }).dragTo(stage, { targetPosition: { x: 180, y: 160 } })
    const buttonLayer = page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Button', exact: true })
    await buttonLayer.waitFor()
    assert.equal(await buttonLayer.getAttribute('aria-selected'), 'true')
    const buttonId = await buttonLayer.getAttribute('data-instance-id')
    const button = preview(page).locator(`[data-preview-instance="${buttonId}"]`)
    await button.waitFor({ state: 'visible', timeout: 20_000 })
    const buttonBox = await button.boundingBox()
    assert.ok(buttonBox && stageBox && buttonBox.x >= stageBox.x && buttonBox.y >= stageBox.y && buttonBox.x < stageBox.x + stageBox.width && buttonBox.y < stageBox.y + stageBox.height, 'dropped Button is inside the visible canvas')
    assert.ok(Math.abs(buttonBox.x - (stageBox.x + 180)) < 2 && Math.abs(buttonBox.y - (stageBox.y + 160)) < 2, 'drop insertion starts at the pointer target')
    assert.deepEqual(await button.evaluate(element => ({ tag: element.tagName, text: element.textContent })), { tag: 'BUTTON', text: 'Button' })
    const dropShot = join(outputRoot, '02-drop-button.png')
    await page.screenshot({ path: dropShot })
    evidence.screenshots.push(dropShot)
    record('Drag adds a visible real Button at the canvas target and selects the same layer identity', buttonId)
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
