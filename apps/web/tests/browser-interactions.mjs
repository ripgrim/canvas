import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from '@playwright/test'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const evidenceRoot = join(projectRoot, 'outputs', 'browser-interactions')
const webRequire = createRequire(join(webRoot, 'package.json'))
const editorUrl = 'http://127.0.0.1:4317/'
const previewUrl = 'http://127.0.0.1:4318/'
const owned = []
const evidence = { status: 'failed', checks: [], screenshots: [], servers: {}, browser: 'system Edge, headless', error: null }
evidence.browserErrors = []
let activePage = null
let activeBrowser = null

function record(name, detail = '') {
  evidence.checks.push({ name, status: 'passed', detail })
}

async function responseAt(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
}

async function ensureServer(name, url, args, expected) {
  const existing = await responseAt(url)
  if (existing !== null) {
    assert.match(existing, expected, `Existing ${name} returned an unexpected page`)
    const entry = name === 'editor' ? ['src', 'client.tsx'] : name === 'preview' ? ['preview', 'main.ts'] : null
    if (!entry) throw new Error(`Port for ${name} already has an unverified server.`)
    const served = await responseAt(new URL(name === 'editor' ? 'src/client.tsx' : 'main.ts', url))
    const encoded = served?.match(/sourceMappingURL=data:application\/json;base64,([^\s]+)/)?.[1]
    assert.ok(encoded, `Existing ${name} must expose its authored entry source map`)
    const map = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    const expectedPath = join(webRoot, ...entry).replaceAll('\\', '/')
    // The preview server's root is apps/web/preview, so its map names the entry relatively; the editor map carries the absolute path.
    if (name === 'editor') assert.equal(map.file.toLowerCase(), expectedPath.toLowerCase(), `Existing ${name} source root mismatch`)
    else assert.deepEqual(map.sources, [entry.at(-1)], `Existing ${name} entry mismatch`)
    const expectedSource = await readFile(join(webRoot, ...entry), 'utf8')
    assert.equal(map.sourcesContent[0].replaceAll('\r\n', '\n'), expectedSource.replaceAll('\r\n', '\n'), `Existing ${name} source bytes mismatch`)
    if (name === 'editor') assert.ok(served.includes(projectRoot.replaceAll('\\', '/') + 'packages/editor/src/bootstrap.tsx'), 'Existing editor must resolve this repository bootstrap')
    evidence.servers[name] = { ownership: 'external verified by source map and bytes', sourceRoot: webRoot, url }
    return
  }
  const vite = join(dirname(webRequire.resolve('vite/package.json')), 'bin', 'vite.js')
  const child = spawn(process.execPath, [vite, ...args], { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  owned.push(child)
  evidence.servers[name] = { ownership: 'owned', sourceRoot: webRoot, url, pid: child.pid }
  let log = ''
  child.stdout.on('data', chunk => { log = (log + String(chunk)).slice(-4000) })
  child.stderr.on('data', chunk => { log = (log + String(chunk)).slice(-4000) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited: ${log}`)
    const body = await responseAt(url)
    if (body !== null) {
      assert.match(body, expected, `${name} returned an unexpected page`)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`${name} did not become ready: ${log}`)
}

async function sharedCopy() {
  const source = await readFile(join(projectRoot, 'packages', 'editor', 'src', 'features', 'editor', 'copy.ts'), 'utf8')
  const canvas = await readFile(join(projectRoot, 'packages', 'editor', 'src', 'features', 'editor', 'canvas-copy.ts'), 'utf8')
  const browser = await readFile(join(webRoot, 'src', 'adapters', 'browser.ts'), 'utf8')
  const pick = (text, key) => {
    const value = new RegExp(`\\b${key}: '([^']+)'`).exec(text)?.[1]
    assert.ok(value, `Missing shared copy key ${key}`)
    return value
  }
  return {
    share: pick(source, 'share'), shareUnavailable: pick(source, 'shareUnavailable'),
    themeDark: pick(source, 'themeDark'), themeLight: pick(source, 'themeLight'),
    review: pick(source, 'review'), promotion: pick(source, 'promotion'),
    preview: pick(canvas, 'preview'), layers: pick(canvas, 'layers'), undo: pick(canvas, 'undo'),
    sourceReason: /const sourceReason = '([^']+)'/.exec(browser)?.[1],
  }
}

// Files are stored as an index (names only) plus one content record per file; the legacy draft key is a migration input only.
const indexKey = 'design-editor.browser-files-index.v3'
const contentPrefix = 'design-editor.browser-file.'
const draftKey = 'design-editor.browser-draft.v1'
const draftName = 'Local draft'
const cardId = 'browser-local-composition:card'
const buttonId = 'sample-instance-button'
const conflictText = 'Document conflict: the saved revision changed'
const legacyIds = ['sample-instance-label-email', 'sample-instance-input-email', 'sample-instance-label-password', 'sample-instance-input-password', buttonId]
const legacyDocument = { version: 1, revision: 0, rootIds: [cardId], nodes: {
  [cardId]: { id: cardId, componentId: 'sample-card', exportName: 'Card', props: { heading: 'Welcome back' }, children: { children: legacyIds } },
  'sample-instance-label-email': { id: 'sample-instance-label-email', componentId: 'sample-label', exportName: 'Label', props: { htmlFor: 'email', children: 'Email' }, children: {} },
  'sample-instance-input-email': { id: 'sample-instance-input-email', componentId: 'sample-input', exportName: 'Input', props: { id: 'email', type: 'email', placeholder: 'you@example.com' }, children: {} },
  'sample-instance-label-password': { id: 'sample-instance-label-password', componentId: 'sample-label', exportName: 'Label', props: { htmlFor: 'password', children: 'Password' }, children: {} },
  'sample-instance-input-password': { id: 'sample-instance-input-password', componentId: 'sample-input', exportName: 'Input', props: { id: 'password', type: 'password' }, children: {} },
  [buttonId]: { id: buttonId, componentId: 'sample-button', exportName: 'Button', props: { children: 'Sign in', variant: 'primary' }, children: {} },
}, frame: { width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false } }

let copy = null
const layers = page => page.getByRole('tree', { name: copy.layers })
const layer = (page, name) => layers(page).getByRole('treeitem', { name, exact: true })
const numberField = (page, label) => page.locator('.right-rail').getByRole('textbox', { name: label, exact: true })
// Runs in the page: finds the draft through the index by name, then reads its own content record.
const readDraft = ({ indexKey, contentPrefix, name }) => {
  const entry = Object.values(JSON.parse(localStorage.getItem(indexKey) ?? '{"files":{}}').files).find(candidate => candidate.name === name)
  const raw = entry ? localStorage.getItem(`${contentPrefix}${entry.id}.v3`) : null
  return raw === null ? null : JSON.parse(raw).file
}
const draftQuery = { indexKey, contentPrefix, name: draftName }

async function savedFile(page) {
  const file = await page.evaluate(([source, query]) => new Function(`return (${source})`)()(query), [readDraft.toString(), draftQuery])
  assert.ok(file, `${draftName} file must be stored`)
  return file
}

async function storedCard(page) {
  const card = (await savedFile(page)).nodes[cardId]
  assert.equal(card?.type, 'component', 'the Card is stored as a component node')
  return card
}

async function seedLegacyDraft(page) {
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(({ document, key }) => { localStorage.clear(); localStorage.setItem(key, JSON.stringify(document)) }, { document: legacyDocument, key: draftKey })
}

async function openDraft(page) {
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  const open = page.getByRole('button', { name: new RegExp(draftName) }).first()
  try {
    await open.waitFor({ timeout: 20_000 })
  } catch (error) {
    if (!evidence.browserErrors.some(message => message.includes('Outdated Optimize Dep'))) throw error
    await page.reload({ waitUntil: 'domcontentloaded' })
    await open.waitFor({ timeout: 20_000 })
  }
  await open.click()
  await layer(page, 'Button').waitFor({ timeout: 20_000 })
  await page.frameLocator(`iframe[title="${copy.preview}"]`).getByRole('button', { name: 'Sign in' }).waitFor({ timeout: 20_000 })
}

async function waitForRevision(page, above) {
  await page.waitForFunction(([source, query, above]) => (new Function(`return (${source})`)()(query)?.revision ?? -1) > above, [readDraft.toString(), draftQuery, above])
}

async function nudgeCard(page, key) {
  await layer(page, 'Card').click()
  assert.equal(await layer(page, 'Card').getAttribute('aria-selected'), 'true')
  await page.keyboard.press(key)
}

async function run() {
  await mkdir(evidenceRoot, { recursive: true })
  copy = await sharedCopy()
  await ensureServer('editor', editorUrl, ['--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4317', '--strictPort'], /Comp Canvas|Design editor|@vite\/client|TanStack/)
  await ensureServer('preview', previewUrl, ['--config', 'vite.preview.config.ts', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4318', '--strictPort'], /preview-root|@vite\/client|<html/i)
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  activeBrowser = browser
  {
    const context = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    activePage = page
    page.on('pageerror', error => { evidence.error = `Page error: ${error.message}` })
    page.on('console', message => { if (message.type() === 'error') evidence.browserErrors.push(message.text().slice(0, 1000)) })
    page.on('response', response => { if (response.status() >= 400) evidence.browserErrors.push(`HTTP ${response.status()} ${response.url()}`) })
    await seedLegacyDraft(page)
    await openDraft(page)
    assert.equal(await page.evaluate(() => window.designEditor === undefined), true)
    record('Browser draft opened without desktop preload')

    const frame = page.locator(`iframe[title="${copy.preview}"]`)
    const preview = page.frameLocator(`iframe[title="${copy.preview}"]`)
    const isolation = await frame.evaluate(element => ({
      origin: new URL(element.src).origin,
      parentOrigin: location.origin,
      directDocument: element.contentDocument === null,
      sandbox: element.getAttribute('sandbox'),
    }))
    assert.equal(isolation.origin, new URL(previewUrl).origin)
    assert.notEqual(isolation.origin, isolation.parentOrigin)
    assert.equal(isolation.directDocument, true)
    assert.match(isolation.sandbox, /allow-scripts/)
    assert.equal(await preview.locator('body').evaluate(() => typeof window.designEditor), 'undefined')
    assert.equal(await preview.locator('body').evaluate(() => typeof window.require), 'undefined')
    record('Preview runs on a separate origin without Node or preload', JSON.stringify(isolation))

    await page.keyboard.press('i')
    await preview.getByRole('textbox', { name: 'Email' }).fill('caleb@example.com')
    assert.equal(await preview.getByRole('textbox', { name: 'Email' }).inputValue(), 'caleb@example.com')
    await preview.getByRole('button', { name: 'Sign in' }).click()
    await preview.getByRole('dialog', { name: 'Preview result' }).waitFor()
    await preview.getByText('This is a local preview').last().waitFor()
    record('Bundled Input, Button, provider, state, and portal respond in the iframe')

    const buttonLayer = layer(page, 'Button')
    const initialId = await buttonLayer.getAttribute('data-instance-id')
    assert.equal(initialId, buttonId)
    await buttonLayer.click()
    await page.keyboard.press('v')
    assert.equal(await buttonLayer.getAttribute('aria-selected'), 'true')
    assert.equal(await preview.getByRole('textbox', { name: 'Email' }).inputValue(), 'caleb@example.com')
    await preview.getByRole('dialog', { name: 'Preview result' }).waitFor()
    // Selection chrome is painted on the HUD canvas, which publishes its painted screen rectangles (viewport-relative).
    await page.waitForFunction(id => JSON.parse(document.querySelector('.canvas-hud-canvas')?.getAttribute('data-hud') ?? '{"selected":{}}').selected[id] !== undefined, buttonId)
    const hudBox = await page.locator('.canvas-hud-canvas').boundingBox()
    const painted = JSON.parse(await page.locator('.canvas-hud-canvas').getAttribute('data-hud')).selected[buttonId]
    const outlineBox = { x: hudBox.x + painted.x, y: hudBox.y + painted.y, width: painted.width, height: painted.height }
    const buttonBox = await preview.getByRole('button', { name: 'Sign in' }).boundingBox()
    assert.ok(outlineBox && buttonBox)
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(outlineBox[key] - buttonBox[key]) <= 2, `Selection outline ${key} ${outlineBox[key]} does not match iframe Button ${key} ${buttonBox[key]}`)
    record('Layer selection preserves the running app and outlines the live Button geometry', JSON.stringify({ id: initialId, outline: outlineBox, button: buttonBox }))

    await page.screenshot({ path: join(evidenceRoot, 'light.png'), fullPage: true })
    evidence.screenshots.push('light.png')
    await page.getByRole('button', { name: copy.themeDark, exact: true }).click()
    await page.getByRole('button', { name: copy.themeLight, exact: true }).waitFor()
    await page.screenshot({ path: join(evidenceRoot, 'dark.png'), fullPage: true })
    evidence.screenshots.push('dark.png')
    record('Light and dark UI screenshots captured')

    const originalCard = await storedCard(page)
    assert.equal(originalCard.componentId, 'sample-card')
    const revisionBefore = (await savedFile(page)).revision
    await nudgeCard(page, 'ArrowRight')
    await waitForRevision(page, revisionBefore)
    const nudgedCard = await storedCard(page)
    assert.notDeepEqual(nudgedCard, originalCard, 'Nudge must change the stored Card')
    assert.equal(nudgedCard.layout?.item?.position?.mode, 'absolute', 'a nudged root Card leaves the host flow')
    const nudgedX = await numberField(page, 'X position').inputValue()
    assert.equal(nudgedCard.layout.item.position.left.value, Number(nudgedX), 'the stored layout matches the inspector')
    await page.getByRole('button', { name: copy.undo, exact: true }).click()
    await page.waitForFunction(([source, query, id, original]) => JSON.stringify(new Function(`return (${source})`)()(query)?.nodes[id]) === original, [readDraft.toString(), draftQuery, cardId, JSON.stringify(originalCard)])
    const undoneX = await numberField(page, 'X position').inputValue()
    assert.equal(Number(nudgedX) - Number(undoneX), 1, `Undo must restore X: nudged ${nudgedX}, undone ${undoneX}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openDraft(page)
    assert.equal(await layer(page, 'Button').getAttribute('data-instance-id'), initialId)
    assert.deepEqual(await storedCard(page), originalCard)
    record('Card nudge saves locally, undo reverts it, reload keeps node identity', JSON.stringify({ nudgedX, undoneX, id: initialId }))

    await page.locator('.right-rail summary').filter({ hasText: /^Create component$/ }).click()
    const disclosure = title => page.locator('.right-rail details').filter({ has: page.locator(':scope > summary', { hasText: new RegExp(`^${title}$`) }) })
    const createComponent = disclosure(copy.promotion).getByRole('button', { name: 'Review component source', exact: true })
    assert.equal(await createComponent.isDisabled(), true)
    await page.getByText(copy.sourceReason, { exact: true }).first().waitFor()
    assert.equal(await disclosure('Source tokens').count(), 0)
    assert.equal(await disclosure('Source editing').count(), 0)
    assert.equal(await disclosure('Code tools').count(), 0)
    record('Legacy source and code utility disclosures are absent while source-backed component creation still explains its availability')

    await page.getByRole('button', { name: copy.share, exact: true }).click()
    await page.getByText(copy.shareUnavailable, { exact: true }).waitFor()
    record('Share explains that no hosted project or upload exists')
    await context.close()

    const conflictContext = await browser.newContext({ viewport: { width: 1500, height: 940 } })
    const first = await conflictContext.newPage()
    const second = await conflictContext.newPage()
    activePage = first
    await seedLegacyDraft(first)
    await Promise.all([openDraft(first), openDraft(second)])
    const base = await savedFile(first)
    await Promise.all([nudgeCard(first, 'ArrowRight'), nudgeCard(second, 'Shift+ArrowRight')])
    await Promise.race([
      first.getByText(conflictText, { exact: false }).first().waitFor(),
      second.getByText(conflictText, { exact: false }).first().waitFor(),
    ])
    const saved = await savedFile(first)
    assert.equal(saved.revision, base.revision + 1)
    const outcomes = await Promise.all([first.getByText(conflictText, { exact: false }).count(), second.getByText(conflictText, { exact: false }).count()])
    assert.equal(outcomes.filter(count => count > 0).length, 1)
    const winner = outcomes[0] > 0 ? second : first
    const winnerX = await numberField(winner, 'X position').inputValue()
    await Promise.all([openDraft(first), openDraft(second)])
    await Promise.all([layer(first, 'Card').click(), layer(second, 'Card').click()])
    assert.equal(await numberField(first, 'X position').inputValue(), winnerX)
    assert.equal(await numberField(second, 'X position').inputValue(), winnerX)
    assert.deepEqual(await storedCard(first), saved.nodes[cardId])
    assert.equal(saved.nodes[cardId].layout.item.position.left.value, Number(winnerX), 'the stored Card is the winner\'s')
    record('Concurrent pages preserve one winning save and surface one conflict', `winner ${winner === first ? 'first (+1 px)' : 'second (+10 px)'}, X ${winnerX}`)
    await conflictContext.close()
    evidence.status = 'passed'
  }
}

try {
  await run()
} catch (error) {
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error)
  if (activePage && !activePage.isClosed()) {
    try {
      await activePage.screenshot({ path: join(evidenceRoot, 'failure.png'), fullPage: true })
      evidence.screenshots.push('failure.png')
      evidence.failureText = (await activePage.locator('body').innerText()).slice(0, 2000)
    } catch {}
  }
  console.error(evidence.error)
  process.exitCode = 1
} finally {
  if (activeBrowser) await activeBrowser.close().catch(() => undefined)
  await Promise.all(owned.map(child => new Promise(resolve => {
    if (child.exitCode !== null) { resolve(); return }
    const timeout = setTimeout(resolve, 5000)
    child.once('exit', () => { clearTimeout(timeout); resolve() })
    child.kill()
  })))
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(join(evidenceRoot, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, screenshots: evidence.screenshots, result: join(evidenceRoot, 'result.json') }))
}
