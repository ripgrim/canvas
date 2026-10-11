import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { loadVerifiedRegistryManifest } from '@canvas/preview-runtime/verified-registry'

const port = await availablePort()
const origin = `http://127.0.0.1:${port}`
const fileId = '11111111-2222-4333-8444-555555555555'
const file = createBlankFile(fileId, 'page_thumbnail', 'root_thumbnail', 'Page 1')
const manifestPath = fileURLToPath(new URL('./verified-registry.json', import.meta.url))
const registryContract = await loadVerifiedRegistryManifest(manifestPath)
if (!registryContract) throw new Error('Thumbnail registry fixture is unavailable.')
file.nodes.button = { id: 'button', type: 'component', componentId: 'atom-button', exportName: 'Button', props: { children: 'Verified button' } }
file.relationships.button = { parentId: 'root_thumbnail', orderKey: 'V' }
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const server = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CANVAS_VERIFIED_COMPONENT_REGISTRY: manifestPath },
})
let serverOutput = ''
server.stdout?.on('data', value => { serverOutput += String(value) })
server.stderr?.on('data', value => { serverOutput += String(value) })

async function availablePort() {
  const reservation = createServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a thumbnail renderer port.')
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function waitForServer() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Thumbnail renderer did not start.\n${serverOutput}`)
}

let browser
try {
  await waitForServer()
  browser = await chromium.launch({ headless: true })
  for (const [label, registryFingerprint] of [['missing', undefined], ['mismatched', `sha256-${'a'.repeat(43)}=`]]) {
    const rejected = await browser.newPage({ viewport: { width: 1024, height: 768 } })
    const rejectedErrors = []
    rejected.on('console', message => { if (message.type() === 'error') rejectedErrors.push(message.text()) })
    rejected.on('pageerror', error => rejectedErrors.push(error.message))
    rejected.on('response', response => {
      if (response.status() < 400) return
      rejectedErrors.push(`${response.status()} ${response.url()}`)
      void response.text().then(body => rejectedErrors.push(body.slice(0, 800))).catch(() => undefined)
    })
    const rejectedSource = { file, fileId, revision: 0, pageId: 'page_thumbnail', ...(registryFingerprint ? { registryFingerprint } : {}) }
    await rejected.addInitScript(source => { window.__CANVAS_THUMBNAIL_SOURCE__ = source }, rejectedSource)
    await rejected.goto(`${origin}/thumbnail-renderer`, { waitUntil: 'domcontentloaded' })
    try { await rejected.waitForFunction(() => document.documentElement.dataset.paperThumbnailPhase === 'error', undefined, { timeout: 12_000 }) }
    catch (error) { throw new Error(`${error.message}\nRejected-page errors: ${rejectedErrors.join(' | ')}`) }
    const rejectedError = await rejected.evaluate(() => document.documentElement.dataset.paperThumbnailError)
    if (!rejectedError?.includes('registry does not match')) throw new Error(`${label} registry fingerprint was not rejected: ${rejectedError}`)
    await rejected.close()
  }
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  const browserErrors = []
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('response', response => { if (response.status() >= 400) void response.text().then(body => browserErrors.push(`${response.status()} ${response.url()} ${body.slice(0, 800)}`)).catch(() => undefined) })
  await page.addInitScript(source => { window.__CANVAS_THUMBNAIL_SOURCE__ = source }, { file, fileId, revision: 0, pageId: 'page_thumbnail', registryFingerprint: registryContract.fingerprint })
  await page.goto(`${origin}/thumbnail-renderer`, { waitUntil: 'domcontentloaded' })
  try { await page.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.paperThumbnailPhase), undefined, { timeout: 12_000 }) }
  catch (error) { throw new Error(`${error.message}\nBrowser errors: ${browserErrors.join(' | ')}`) }
  const evidence = await page.evaluate(() => ({
    ready: window.__PAPER_THUMBNAIL_READY,
    phase: document.documentElement.dataset.paperThumbnailPhase,
    fileId: document.documentElement.dataset.paperThumbnailFileId,
    error: document.documentElement.dataset.paperThumbnailError ?? null,
    selectionChrome: document.querySelectorAll('[data-preview-selected="true"]').length,
    button: document.querySelector('.fixture-button')?.textContent ?? null,
    registry: document.documentElement.dataset.previewRegistry ?? null,
  }))
  if (!evidence.ready || evidence.phase !== 'ready' || evidence.fileId !== fileId || evidence.error || evidence.selectionChrome !== 0 || evidence.button !== 'Verified button' || evidence.registry !== registryContract.fingerprint) {
    throw new Error(`Unexpected renderer evidence: ${JSON.stringify(evidence)}`)
  }
  console.log(`THUMBNAIL_RENDERER_EVIDENCE ${JSON.stringify(evidence)}`)
} finally {
  await browser?.close()
  server.kill()
}
