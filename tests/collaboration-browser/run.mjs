import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { createPostgresPool } from '../../packages/database/dist/postgres.js'
import { applyHostedFileCommand, createBlankFile } from '../../packages/repo-engine/dist/file-document.js'
import { localRegistryEnvironment, prepareLocalRegistry } from '../../scripts/local-registry.mjs'

const root = resolve(import.meta.dirname, '../..')
const webOrigin = 'http://127.0.0.1:4517'
const apiOrigin = 'http://127.0.0.1:4520'
const syncOrigin = 'ws://127.0.0.1:4521'
const previewOrigin = 'http://127.0.0.1:4518'
const browserPreviewOrigin = 'http://127.0.0.1:4318'
const buildId = JSON.parse(await import('node:fs/promises').then(module => module.readFile(join(root, 'package.json'), 'utf8'))).version
const ownerId = `stage6-owner-${randomUUID()}`
const viewerId = `stage6-viewer-${randomUUID()}`
const cookieName = 'canvas-stage6-session'
const serviceToken = randomBytes(48).toString('base64url')
const admissionToken = randomBytes(48).toString('base64url')
const coordinatorSecret = randomBytes(48).toString('base64url')
const ticketSecret = randomBytes(48).toString('base64url')
const checkpointDirectory = await mkdtemp(join(tmpdir(), 'canvas-stage6-checkpoints-'))
const evidenceDirectory = join(root, 'outputs', 'collaboration-browser')
const processes = []
const logs = new Map()
let browser
let pool
let cleanupFileId

const record = (name, detail = '') => process.stdout.write(`PASS ${name}${detail ? ` ${detail}` : ''}\n`)
const sleep = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
const cookie = value => ({ name: cookieName, value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' })
const json = async response => {
  const body = await response.json()
  if (!response.ok()) throw new Error(`${response.status()} ${response.url()}: ${JSON.stringify(body)}`)
  return body
}
const api = async (context, path, init = {}) => {
  const response = await context.request.fetch(`${apiOrigin}${path}`, { ...init, headers: { Origin: webOrigin, ...(init.headers ?? {}) } })
  return { response, body: await response.json() }
}

function launch(label, args, environment) {
  const child = globalThis.__stage6Spawn(args, environment)
  child.stage6Label = label
  processes.push(child)
  let output = ''
  const append = chunk => { output = `${output}${String(chunk)}`.slice(-20_000); logs.set(label, output) }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return child
}

async function ready(url, label, accepted = [200]) {
  let last
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const child = processes.find(candidate => candidate.stage6Label === label)
    if (child && child.exitCode !== null) throw new Error(`${label} exited before readiness.\n${logs.get(label) ?? ''}`)
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (accepted.includes(response.status)) return
      last = new Error(`${response.status} ${url}`)
    } catch (error) { last = error }
    await sleep(250)
  }
  throw new Error(`${label} did not become ready: ${last instanceof Error ? last.message : String(last)}\n${logs.get(label) ?? ''}`)
}

async function waitForText(page, nodeId, value) {
  const node = page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-canvas="${nodeId}"]`)
  await node.waitFor({ timeout: 120_000 })
  let observed = null
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    observed = await node.textContent()
    if (observed === value) return
    await sleep(100)
  }
  throw new Error(`Timed out waiting for text ${JSON.stringify(value)}; observed ${JSON.stringify(observed)}.`)
}

async function textFailure(label, page, error) {
  const body = await page.locator('body').innerText().catch(() => '')
  const frameBody = await page.frameLocator('iframe[title="Canvas"]').locator('body').innerText().catch(() => '')
  const frames = await page.locator('iframe[title="Canvas"]').evaluateAll(items => items.map(item => item.getAttribute('src'))).catch(() => [])
  throw new Error(`${label} did not render the collaboration document at ${page.url()}.\nIframes: ${JSON.stringify(frames)}\nPage: ${body.slice(0, 2_000)}\nPreview: ${frameBody.slice(0, 2_000)}\n${error instanceof Error ? error.stack : String(error)}`)
}

function captureBrowserDiagnostics(label, page) {
  let output = ''
  const append = value => { output = `${output}${value}\n`.slice(-20_000); logs.set(`${label}-browser`, output) }
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') append(`console ${message.type()}: ${message.text()}`) })
  page.on('pageerror', error => append(`pageerror: ${error.message}`))
  page.on('requestfailed', request => append(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`))
}

async function run() {
  await mkdir(evidenceDirectory, { recursive: true })
  const registry = await prepareLocalRegistry({ root })
  const registryEnvironment = localRegistryEnvironment(registry)
  const sharedEnvironment = {
    ...process.env,
    APP_URL: webOrigin,
    API_SERVICE_TOKEN: serviceToken,
    COLLABORATION_ADMISSION_SERVICE_TOKEN: admissionToken,
    COLLABORATION_BUILD_ID: buildId,
    SYNC_COORDINATOR_INTERNAL_SECRET: coordinatorSecret,
    SYNC_ROOM_TICKET_SECRET: ticketSecret,
    ALLOWED_ORIGINS: webOrigin,
    DATABASE_URL: process.env.DATABASE_URL,
    CANVAS_VERIFIED_REGISTRY_FINGERPRINT: registry.fingerprint,
    COLLABORATION_TEST_OWNER_ID: ownerId,
    COLLABORATION_TEST_VIEWER_ID: viewerId,
  }
  launch('api', ['tests/collaboration-browser/api-server.mjs'], { ...sharedEnvironment, PORT: '4520' })
  await ready(`${apiOrigin}/healthz`, 'api')
  launch('room', ['node_modules/.bin/pnpm', '--filter', '@canvas/sync-room-core', 'dev'], {
    ...sharedEnvironment, PORT: '4525', SYNC_ROOM_CHECKPOINT_DIR: checkpointDirectory, SYNC_ROOM_LEASE_RENEWAL_MS: '500', SYNC_ROOM_LEASE_DURATION_MS: '3000',
  })
  await ready('http://127.0.0.1:4525/readyz', 'room')
  launch('worker', ['tests/collaboration-browser/sync-edge.mjs'], { ...sharedEnvironment, PORT: '4521', API_ORIGIN: apiOrigin, SYNC_ROOM_RUNTIME_ORIGIN: 'http://127.0.0.1:4525' })
  await ready('http://127.0.0.1:4521/healthz', 'worker')
  launch('preview', ['node_modules/.bin/pnpm', '--filter', '@canvas/web', 'exec', 'vite', '--config', 'vite.preview.config.ts', '--host', '127.0.0.1', '--port', '4518', '--strictPort'], { ...sharedEnvironment, ...registryEnvironment })
  await ready(previewOrigin, 'preview')
  launch('web', ['node_modules/.bin/pnpm', '--filter', '@canvas/web', 'exec', 'vite', '--host', '127.0.0.1', '--port', '4517', '--strictPort'], {
    ...sharedEnvironment,
    VITE_API_ORIGIN: apiOrigin,
    VITE_LOGIN_ORIGIN: webOrigin,
    VITE_PREVIEW_ORIGIN: previewOrigin,
    VITE_ASSETS_ORIGIN: 'http://127.0.0.1:4522',
    VITE_SYNC_ORIGIN: syncOrigin,
    VITE_COLLABORATION_BUILD_ID: buildId,
  })
  await ready(webOrigin, 'web')

  pool = createPostgresPool(process.env.DATABASE_URL)
  browser = await chromium.launch({ headless: true })
  const owner = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true })
  const viewer = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true })
  for (const context of [owner, viewer]) await context.route(`${browserPreviewOrigin}/**`, async route => {
    const response = await route.fetch({ url: route.request().url().replace(browserPreviewOrigin, previewOrigin) })
    const headers = { ...response.headers() }
    if (headers['content-security-policy']) headers['content-security-policy'] = headers['content-security-policy'].replace(/frame-ancestors[^;]*/u, `frame-ancestors ${webOrigin}`)
    await route.fulfill({ response, headers })
  })
  await owner.addCookies([cookie('owner')])
  await viewer.addCookies([cookie('viewer')])

  const created = await api(owner, '/api/files', { method: 'POST', data: { name: 'Stage 6 collaboration' } })
  assert.equal(created.response.status(), 201)
  const fileId = created.body.file.id
  cleanupFileId = fileId
  const pageId = randomUUID()
  const rootNodeId = randomUUID()
  const textNodeId = randomUUID()
  let source = createBlankFile(fileId, pageId, rootNodeId, 'Page 1')
  source = applyHostedFileCommand(source, {
    type: 'node.insert',
    node: {
      id: textNodeId,
      type: 'text',
      name: 'Stage 6 text',
      text: 'Seed',
      textStyle: { fontFamily: 'Inter, sans-serif', fontStyle: 'normal', fontWeight: 400, fontSize: 24, lineHeight: { kind: 'unitless', value: 1.2 }, letterSpacing: 0, horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false },
      textSizing: { width: { mode: 'fixed' }, height: { mode: 'fixed' } },
      styles: { left: -100, top: -40, width: 240, height: 80 },
    },
    placement: { parentId: rootNodeId },
  }, [])
  source = { ...source, revision: 0 }
  const seeded = await api(owner, `/api/files/${fileId}/document`, { method: 'PUT', data: { expectedRevision: 0, document: source } })
  assert.equal(seeded.response.status(), 200, JSON.stringify(seeded.body))
  const share = await api(owner, `/api/files/${fileId}/share`, { method: 'PUT', data: { access: 'view' } })
  assert.equal(share.response.status(), 200)

  const ownerPage = await owner.newPage()
  const viewerPage = await viewer.newPage()
  captureBrowserDiagnostics('owner', ownerPage)
  captureBrowserDiagnostics('viewer', viewerPage)
  const wholeDocumentWrites = []
  for (const page of [ownerPage, viewerPage]) page.on('request', request => {
    if (request.method() === 'PUT' && /\/api\/files\/[^/]+\/document$/.test(new URL(request.url()).pathname)) wholeDocumentWrites.push({ page: page === ownerPage ? 'owner' : 'viewer', url: request.url() })
  })
  await Promise.all([
    ownerPage.goto(`${webOrigin}/file/${fileId}?pageId=${pageId}`, { waitUntil: 'domcontentloaded' }),
    viewerPage.goto(`${webOrigin}/file/${fileId}?pageId=${pageId}`, { waitUntil: 'domcontentloaded' }),
  ])
  await waitForText(ownerPage, textNodeId, 'Seed').catch(error => textFailure('Owner', ownerPage, error))
  await waitForText(viewerPage, textNodeId, 'Seed').catch(error => textFailure('Viewer', viewerPage, error))
  await viewerPage.getByText('You can only view this file', { exact: true }).waitFor({ timeout: 15_000 })
  record('CLOUD-SYNC-CLIENT-001 two authenticated contexts joined the real room path')

  const ownerLayer = ownerPage.getByRole('treeitem', { name: 'Seed', exact: true })
  await ownerLayer.click()
  await ownerPage.locator('.canvas-stage').focus()
  await ownerPage.keyboard.press('Enter')
  await ownerPage.getByRole('textbox', { name: 'Edit text in Seed' }).waitFor({ timeout: 10_000 })
  const editor = ownerPage.locator(`.canvas-text-editor[data-editing="${textNodeId}"]`)
  await editor.press('Control+a')
  const updates = ['L', 'Li', 'Liv', 'Live']
  for (let index = 0; index < updates.length; index += 1) {
    await editor.pressSequentially(updates[index].slice(index), { delay: 20 })
    await waitForText(viewerPage, textNodeId, updates[index])
  }
  await editor.press('Control+Enter')
  await waitForText(viewerPage, textNodeId, 'Live')
  record('PAPER-TEXT-008 every browser input update reached the viewer before commit', updates.join(' -> '))

  await ownerPage.keyboard.press('Control+z')
  await Promise.all([waitForText(ownerPage, textNodeId, 'Seed'), waitForText(viewerPage, textNodeId, 'Seed')])
  record('PAPER-TEXT-008 one semantic undo reverted the complete text session')
  await ownerPage.keyboard.press('Control+Shift+z')
  await Promise.all([waitForText(ownerPage, textNodeId, 'Live'), waitForText(viewerPage, textNodeId, 'Live')])
  record('CLOUD-SYNC-REPLAY-001 semantic redo restored exact final state')

  await Promise.all([ownerPage.reload({ waitUntil: 'domcontentloaded' }), viewerPage.reload({ waitUntil: 'domcontentloaded' })])
  await Promise.all([waitForText(ownerPage, textNodeId, 'Live'), waitForText(viewerPage, textNodeId, 'Live')])
  assert.deepEqual(wholeDocumentWrites, [], 'Browsers must not PUT whole documents after collaboration bootstrap.')
  await Promise.all([
    ownerPage.screenshot({ path: join(evidenceDirectory, 'owner-live-after-reload.png'), fullPage: true }),
    viewerPage.screenshot({ path: join(evidenceDirectory, 'viewer-live-after-reload.png'), fullPage: true }),
  ])
  await writeFile(join(evidenceDirectory, 'live-evidence.json'), JSON.stringify({ fileId, pageId, textNodeId, updates, wholeDocumentWrites }, null, 2))
  record('CLOUD-SYNC-REPLAY-001 both contexts reloaded the acknowledged projection')

  const stale = await api(owner, `/api/files/${fileId}/document`, { method: 'PUT', data: { expectedRevision: 1, document: { ...source, revision: 1 } } })
  assert.equal(stale.response.status(), 409)
  assert.equal(stale.body.error.code, 'collaboration_authoritative')
  const corrupt = await api(owner, `/api/files/${fileId}/document`, { method: 'PUT', data: { expectedRevision: 1, document: { fileId, revision: 1, corrupt: true } } })
  assert.equal(corrupt.response.status(), 400)
  record('Negative controls reject stale and corrupt whole-document writes')

  const revoked = await api(owner, `/api/files/${fileId}/share`, { method: 'PUT', data: { access: 'private' } })
  assert.equal(revoked.response.status(), 200)
  await viewerPage.getByText('Access removed', { exact: true }).waitFor({ timeout: 15_000 })
  const denied = await api(viewer, `/api/shared/files/${fileId}`)
  assert.equal(denied.response.status(), 404)
  record('CLOUD-SYNC-READONLY-001 viewer revocation closes the room and denies HTTP read')
  await Promise.all([
    ownerPage.screenshot({ path: join(evidenceDirectory, 'owner-final.png'), fullPage: true }),
    viewerPage.screenshot({ path: join(evidenceDirectory, 'viewer-revoked.png'), fullPage: true }),
  ])

  const canonical = await api(owner, `/api/files/${fileId}/document`)
  assert.equal(canonical.response.status(), 200)
  assert.equal(canonical.body.document.nodes[textNodeId].text, 'Live', 'The canonical API projection must equal the browser projection.')
  assert.equal(canonical.body.revision, seeded.body.revision + updates.length + 2, 'Text updates, undo, and redo must be projected as ordered semantic operations.')
  record('CLOUD-SYNC-CLIENT-001 canonical API projection exactly matches final browser state')

  await writeFile(join(evidenceDirectory, 'evidence.json'), JSON.stringify({ fileId, pageId, textNodeId, updates, wholeDocumentWrites, canonicalRevision: canonical.body.revision }, null, 2))
}

try {
  await run()
} catch (error) {
  for (const [label, output] of logs) process.stderr.write(`\n--- ${label} ---\n${output}\n`)
  throw error
} finally {
  if (browser) await browser.close().catch(() => undefined)
  if (pool && cleanupFileId) await pool.query('DELETE FROM app_file WHERE id = $1 AND owner_user_id = $2', [cleanupFileId, ownerId]).catch(() => undefined)
  if (pool) await pool.end().catch(() => undefined)
  for (const child of processes.reverse()) await globalThis.__stage6Stop(child)
  await rm(checkpointDirectory, { recursive: true, force: true })
}
