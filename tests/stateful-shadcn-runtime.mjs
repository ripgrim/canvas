import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { scanShadcnPreviewRegistry } from '../packages/scanner/dist/index.js'
import { createPreviewRuntime } from '../packages/preview-runtime/dist/index.js'
import { verifyComponentRegistry } from '../packages/preview-runtime/dist/verified-registry.mjs'
import { createBlankFile } from '../packages/repo-engine/dist/file-document.js'

const testRoot = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(testRoot, '..')
const repositoryRoot = join(workspaceRoot, 'fixtures/stateful-shadcn-repo')
const thumbnailRoot = join(workspaceRoot, 'apps/thumbnail-renderer')
const viteBin = join(thumbnailRoot, 'node_modules/vite/bin/vite.js')

async function repositoryBytes(directory = repositoryRoot) {
  const output = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(output, await repositoryBytes(absolute))
    else if (entry.isFile()) output[relative(repositoryRoot, absolute).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(absolute)).digest('hex')
  }
  return output
}

async function openPort() {
  const server = createNetServer()
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()))
  return port
}

function runProcess(process, diagnostics) {
  return new Promise((accept, reject) => {
    process.once('error', reject)
    process.once('close', code => code === 0 ? accept() : reject(new Error(`Process exited with ${code}.\n${diagnostics.join('')}`)))
  })
}

async function serveDirectory(directory, port) {
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
  const server = createHttpServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname)
      const relativePath = pathname === '/' || pathname === '/thumbnail-renderer' ? 'index.html' : pathname.replace(/^\/+/, '')
      const filename = resolve(directory, relativePath)
      if (relative(directory, filename).startsWith('..') || !(await stat(filename)).isFile()) { response.writeHead(404); response.end(); return }
      response.setHeader('Content-Type', contentTypes[filename.slice(filename.lastIndexOf('.'))] ?? 'application/octet-stream')
      response.writeHead(200)
      response.end(await readFile(filename))
    })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end() })
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', accept)
  })
  return server
}

function registryBinding(request, verified, props) {
  const entry = request.components.find(component => component.componentId === request.entry.componentId)
  assert(entry, 'Scanner registry entry is missing.')
  return {
    componentId: entry.componentId,
    entryPath: entry.entryPath,
    exportName: entry.exportName,
    props,
    styles: request.styles.map(style => style.path),
    registry: request.components,
    provider: request.provider,
    themeAdapters: request.themeAdapters,
    aliases: request.aliases,
    dependencies: verified.dependencies.map(({ path, integrity }) => ({ path, integrity })),
    assets: request.assets,
    fonts: request.fonts,
  }
}

async function inspectStatefulDialog(page) {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
  })
  const trigger = page.getByTestId('dialog-trigger')
  await trigger.waitFor()
  assert.equal(await trigger.getAttribute('data-provider-brand'), 'Registry provider')
  assert.equal(await page.getByTestId('dialog-portal').count(), 0)
  await trigger.click()
  const portal = page.getByTestId('dialog-portal')
  const panel = page.getByTestId('dialog-panel')
  const close = page.getByTestId('dialog-close')
  await panel.waitFor()
  assert.equal(await portal.evaluate(node => node.parentElement === document.body), true, 'Dialog must portal directly to body.')
  assert.equal(await panel.getAttribute('data-provider-brand'), 'Registry provider')
  assert.equal(await panel.getAttribute('data-variant'), 'danger')
  assert.equal(await page.getByTestId('dialog-content').textContent(), 'Slot content')
  assert.equal(await close.evaluate(node => node === document.activeElement), true, 'Opening the dialog must move focus into it.')
  assert.match(await panel.evaluate(node => getComputedStyle(node).boxShadow), /rgb\(185, 28, 28\)/)
  assert.match(await panel.locator('h2').evaluate(node => getComputedStyle(node).fontFamily), /Basic/)
  const image = panel.getByRole('img', { name: 'Fixture mark' })
  await image.evaluate(node => node.complete ? undefined : new Promise(resolveLoad => {
    node.addEventListener('load', resolveLoad, { once: true })
    node.addEventListener('error', resolveLoad, { once: true })
  }))
  const imageEvidence = await image.evaluate(node => ({ complete: node.complete, naturalWidth: node.naturalWidth, src: node.src }))
  assert.equal(imageEvidence.complete && imageEvidence.naturalWidth > 0, true, `Repository image must load: ${JSON.stringify(imageEvidence)}; ${errors.join(' | ')}`)
  const font = await page.evaluate(async () => {
    let failure = null
    try {
      await document.fonts.load('400 16px "Basic"', 'Registry provider')
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    return {
      available: document.fonts.check('400 16px "Basic"', 'Registry provider'),
      loaded: [...document.fonts].some(face => face.family.includes('Basic') && face.status === 'loaded'),
      failure,
      faces: [...document.fonts].filter(face => face.family.includes('Basic')).map(face => ({ family: face.family, status: face.status })),
      resources: performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('stateful')),
      rules: [...document.styleSheets].flatMap(sheet => [...(sheet.cssRules ?? [])].map(rule => rule.cssText)).filter(rule => rule.includes('Basic')),
    }
  })
  assert.equal(font.available && font.loaded && font.failure === null, true, `Repository font asset must decode and load: ${JSON.stringify(font)}; ${errors.join(' | ')}`)
  if (process.env.STATEFUL_SCREENSHOT) await page.screenshot({ path: process.env.STATEFUL_SCREENSHOT, fullPage: true })
  await page.keyboard.press('Escape')
  assert.equal(await portal.count(), 0, 'Escape must close the portal.')
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'Closing must restore trigger focus.')
  assert.deepEqual(errors, [])
}

async function exerciseThumbnail(registryRequest, fingerprint) {
  const temporary = await mkdtemp(join(tmpdir(), 'stateful-shadcn-thumbnail-'))
  const manifest = join(temporary, 'registry.json')
  const outputRoot = join(temporary, 'dist')
  await writeFile(manifest, JSON.stringify({ repositoryRoot, registry: registryRequest }), 'utf8')
  const port = await openPort()
  const origin = `http://127.0.0.1:${port}`
  const diagnostics = []
  const build = spawn(process.execPath, [viteBin, 'build', '--outDir', outputRoot, '--emptyOutDir'], {
    cwd: thumbnailRoot,
    env: { ...process.env, CANVAS_VERIFIED_COMPONENT_REGISTRY: manifest },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  build.stdout.on('data', chunk => diagnostics.push(String(chunk)))
  build.stderr.on('data', chunk => diagnostics.push(String(chunk)))
  await runProcess(build, diagnostics)
  const server = await serveDirectory(outputRoot, port)
  let browser
  try {
    const fileId = 'stateful_fixture_file'
    const pageId = 'stateful_fixture_page'
    const rootId = 'stateful_fixture_root'
    const entry = registryRequest.components.find(component => component.componentId === registryRequest.entry.componentId)
    assert(entry)
    const file = createBlankFile(fileId, pageId, rootId, 'Fixture')
    file.nodes.dialog = {
      id: 'dialog',
      type: 'component',
      componentId: entry.componentId,
      exportName: entry.exportName,
      props: { defaultOpen: true, variant: 'danger', children: 'Thumbnail trigger', content: 'Thumbnail content' },
    }
    file.relationships.dialog = { parentId: rootId, orderKey: 'V' }
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
    const browserDiagnostics = []
    page.on('console', message => { if (message.type() === 'error') browserDiagnostics.push(message.text()) })
    page.on('pageerror', error => browserDiagnostics.push(error.message))
    page.on('response', response => { if (response.status() >= 400) browserDiagnostics.push(`${response.status()} ${response.url()}`) })
    await page.addInitScript(source => { window.__CANVAS_THUMBNAIL_SOURCE__ = source }, { file, fileId, revision: 0, pageId, registryFingerprint: fingerprint })
    await page.goto(`${origin}/thumbnail-renderer`, { waitUntil: 'domcontentloaded' })
    try {
      await page.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.paperThumbnailPhase ?? ''), undefined, { timeout: 20_000 })
    } catch (error) {
      const state = await page.evaluate(() => ({ phase: document.documentElement.dataset.paperThumbnailPhase ?? null, body: document.body.innerText.slice(0, 1_000) }))
      throw new Error(`${error.message}\nPage state: ${JSON.stringify(state)}\nBrowser diagnostics: ${browserDiagnostics.join(' | ')}\nServer diagnostics: ${diagnostics.join('')}`)
    }
    const evidence = await page.evaluate(() => ({
      phase: document.documentElement.dataset.paperThumbnailPhase,
      error: document.documentElement.dataset.paperThumbnailError ?? null,
      fingerprint: document.documentElement.dataset.previewRegistry,
      content: document.querySelector('[data-testid="dialog-content"]')?.textContent ?? null,
      trigger: document.querySelector('[data-testid="dialog-trigger"]')?.textContent ?? null,
      variant: document.querySelector('[data-testid="dialog-panel"]')?.getAttribute('data-variant') ?? null,
      provider: document.querySelector('[data-testid="dialog-panel"]')?.getAttribute('data-provider-brand') ?? null,
    }))
    assert.deepEqual(evidence, { phase: 'ready', error: null, fingerprint, content: 'Thumbnail content', trigger: 'Thumbnail trigger', variant: 'danger', provider: 'Registry provider' })

    const invalid = structuredClone(file)
    invalid.nodes.dialog.props.undeclared = 'Rejected'
    const rejected = await browser.newPage({ viewport: { width: 900, height: 700 } })
    await rejected.addInitScript(source => { window.__CANVAS_THUMBNAIL_SOURCE__ = source }, { file: invalid, fileId, revision: 0, pageId, registryFingerprint: fingerprint })
    await rejected.goto(`${origin}/thumbnail-renderer`, { waitUntil: 'domcontentloaded' })
    await rejected.waitForFunction(() => document.documentElement.dataset.paperThumbnailPhase === 'error', undefined, { timeout: 20_000 })
    const rejection = await rejected.evaluate(() => document.documentElement.dataset.paperThumbnailError ?? null)
    assert.match(rejection ?? '', /Unsupported value for Dialog\.undeclared/, 'Thumbnail must reject undeclared document props.')
    await rejected.close()
    return evidence
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise(resolveClose => server.close(() => resolveClose()))
    await rm(temporary, { recursive: true, force: true })
  }
}

const before = await repositoryBytes()
const generated = await scanShadcnPreviewRegistry(repositoryRoot)
assert.deepEqual(generated.scan.diagnostics, [])
const entry = generated.request.components.find(component => component.exportName === 'Dialog')
assert(entry, 'The public scanner must discover Dialog.')
assert.deepEqual(entry.slots, ['children', 'content'])
assert.deepEqual(entry.props, {
  defaultOpen: { kind: 'boolean' },
  variant: { kind: 'enum', values: ['default', 'danger'] },
})
assert.deepEqual(generated.request.aliases?.[0]?.paths, [{ pattern: '@/*', target: './src/*' }])
assert.equal(generated.request.provider?.exportName, 'PreviewProvider')
assert.equal(generated.request.themeAdapters?.[0]?.exportName, 'statefulThemeAdapter')

const request = {
  ...generated.request,
  assets: [
    { assetId: 'stateful-mark', sourcePath: 'src/assets/stateful-mark.svg', publicPath: '/registry-assets/stateful-mark.svg', mime: 'image/svg+xml' },
    { assetId: 'stateful-font', sourcePath: 'src/assets/stateful-fixture.woff2', publicPath: '/registry-assets/stateful-fixture.woff2', mime: 'font/woff2' },
  ],
  fonts: [{ family: 'Basic', assetId: 'stateful-font', weight: '400', style: 'normal', display: 'swap' }],
}
const verified = await verifyComponentRegistry(repositoryRoot, request)
assert.match(verified.fingerprint, /^sha256-/)
assert(verified.dependencies.some(dependency => dependency.path === 'src/preview/context.tsx'))
assert(verified.resolutions.some(resolution => resolution.specifier === '@/preview/context'))
assert.equal(verified.packageResolution?.manifest.path, 'package.json')
assert.equal(verified.packageResolution?.lockfile.path, 'pnpm-lock.yaml')
assert.deepEqual(verified.packageResolution?.specifiers.map(item => item.specifier), ['react', 'react-dom', 'react-dom/client'])
assert(verified.packageResolution?.packages.some(item => item.name === 'react'))
assert(verified.packageResolution?.packages.some(item => item.name === 'react-dom'))
assert.deepEqual(verified.assets.map(asset => asset.assetId).sort(), ['stateful-font', 'stateful-mark'])
assert.deepEqual(verified.fonts.map(font => font.family), ['Basic'])

const preview = createPreviewRuntime({ repositoryRoot, editorOrigin: 'http://127.0.0.1:4319', executionTrust: 'fixture-only' })
let browser
let previewEvidence
try {
  const state = await preview.start(registryBinding(request, verified, {
    children: 'Open stateful dialog',
    content: 'Slot content',
    defaultOpen: false,
    variant: 'danger',
  }))
  assert.equal(state.status, 'ready', state.diagnostics.join('\n'))
  assert(state.url)
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  await page.goto(state.url, { waitUntil: 'networkidle' })
  await inspectStatefulDialog(page)
  const buildAssets = `${state.origin}/build/${state.activeGeneration}/registry-assets`
  const assetResponses = await Promise.all([
    fetch(`${buildAssets}/stateful-mark.svg`),
    fetch(`${buildAssets}/stateful-fixture.woff2`),
  ])
  assert.deepEqual(assetResponses.map(response => [response.status, response.headers.get('content-type')]), [[200, 'image/svg+xml'], [200, 'font/woff2']])
  previewEvidence = { generation: state.activeGeneration, origin: new URL(state.url).origin, fingerprint: verified.fingerprint }
} finally {
  await browser?.close()
  await preview.dispose()
}

const thumbnailEvidence = await exerciseThumbnail(request, verified.fingerprint)
assert.deepEqual(await repositoryBytes(), before, 'Scanner, preview, and thumbnail paths must not write repository bytes.')

console.log(`STATEFUL_SHADCN_ACCEPTANCE ${JSON.stringify({
  acceptance: ['AT-COMP-001', 'AT-SCAN-001', 'AT-PRV-001'],
  component: entry.componentId,
  dependencies: verified.dependencies.map(dependency => dependency.path),
  packages: verified.packageResolution?.packages.map(item => item.name),
  preview: previewEvidence,
  thumbnail: thumbnailEvidence,
  repositoryBytesUnchanged: true,
})}`)
