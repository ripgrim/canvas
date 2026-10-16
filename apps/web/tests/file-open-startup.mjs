import assert from 'node:assert/strict'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { cpus, platform, release, totalmem } from 'node:os'
import { chromium } from '@playwright/test'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const appearance = process.env.CANVAS_STARTUP_APPEARANCE === 'dark' ? 'dark' : 'light'
const evidenceRoot = join(projectRoot, 'outputs', `file-open-startup-${appearance}`)
const url = process.env.CANVAS_FILE_STARTUP_URL ?? 'http://127.0.0.1:4317/file/dfd1dbcc-808b-4618-b9f5-332a25fc0f40'
const evidence = {
  status: 'failed',
  acceptance: ['AT-UX-003'],
  performanceCoverage: { acceptance: 'AT-PERF-001', status: 'partial', scope: 'Cold file-open shell only. The complete interaction-budget suite remains separate.' },
  appearance,
  environment: {
    platform: `${platform()} ${release()}`,
    processor: cpus()[0]?.model ?? 'Unknown',
    logicalProcessors: cpus().length,
    memoryBytes: totalmem(),
    viewport: { width: 1232, height: 839 },
    cache: 'disabled',
    network: { latencyMs: 150, downloadBytesPerSecond: 200_000, uploadBytesPerSecond: 100_000 },
    clientScriptDelayMs: 900,
    sampleCount: 1,
    state: 'cold direct file URL',
    build: null,
  },
  measurements: {},
  checks: [], screenshots: [], recording: null, samples: [], diagnostics: [], error: null,
}
let browser
let context
let page
let delayedScripts = 0
const record = (name, detail = '') => { evidence.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) }); console.log('✓', name, detail) }
const shot = async name => { await page.screenshot({ path: join(evidenceRoot, `${name}.png`) }); evidence.screenshots.push(`${name}.png`) }

try {
  await mkdir(evidenceRoot, { recursive: true })
  assert.ok(await fetch(url).then(response => response.ok).catch(() => false), 'the web editor must be running before cold-start evidence begins')
  evidence.environment.build = await fetch(new URL('/version.json', url)).then(response => response.ok ? response.json() : null).catch(() => null)
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  evidence.environment.browser = `${browser.browserType().name()} ${browser.version()}`
  context = await browser.newContext({ viewport: { width: 1232, height: 839 }, recordVideo: { dir: evidenceRoot, size: { width: 1232, height: 839 } } })
  await context.addInitScript(mode => { localStorage.setItem('design-editor.appearance.v1', mode) }, appearance)
  page = await context.newPage()
  page.on('pageerror', error => evidence.diagnostics.push({ kind: 'pageerror', message: error.message }))
  page.on('console', message => { if (message.type() === 'error') evidence.diagnostics.push({ kind: 'console', message: message.text() }) })
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname
    if (pathname === '/api/session' || pathname.startsWith('/api/files/') || pathname.startsWith('/api/shared/files/')) evidence.diagnostics.push({ kind: 'response', pathname, status: response.status() })
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await page.addInitScript(() => {
    window.__canvasStartupSamples = []
    window.__canvasStartupMetrics = { layoutShift: 0, longTasks: [] }
    const sample = source => {
      const root = document.querySelector('body > main')
      const mark = document.querySelector('.startup-mark')
      const box = mark?.getBoundingClientRect()
      const style = root ? getComputedStyle(root) : null
      window.__canvasStartupSamples.push({
        at: performance.now(),
        source,
        htmlClass: document.documentElement.className,
        className: root?.className ?? null,
        text: root?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        background: style?.backgroundColor ?? null,
        bodyBackground: document.body ? getComputedStyle(document.body).backgroundColor : null,
        mark: box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null,
      })
    }
    new MutationObserver(() => sample('mutation')).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] })
    new PerformanceObserver(list => { for (const entry of list.getEntries()) sample(entry.name) }).observe({ type: 'paint', buffered: true })
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__canvasStartupMetrics.layoutShift += entry.value
    }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__canvasStartupMetrics.longTasks.push({ startTime: entry.startTime, duration: entry.duration })
    }).observe({ type: 'longtask', buffered: true })
  })
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 100_000, connectionType: 'cellular3g' })
  await page.route('**/*', async route => {
    if (route.request().resourceType() !== 'script') { await route.fallback(); return }
    delayedScripts += 1
    await new Promise(resolve => setTimeout(resolve, 900))
    await route.continue()
  })
  const editorOrigin = new URL(url).origin
  const responseHeaders = { 'access-control-allow-origin': editorOrigin, 'access-control-allow-credentials': 'true', 'content-type': 'application/json', 'x-canvas-request-id': '11111111-2222-4333-8444-555555555555' }
  await page.route('**/api/session', route => route.fulfill({ status: 401, headers: responseHeaders, body: JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in required.' } }) }))
  await page.route('**/api/files', route => route.fulfill({ status: 200, headers: responseHeaders, body: JSON.stringify({ files: [] }) }))
  await page.route(`**/api/files/${new URL(url).pathname.split('/').pop()}`, async route => { await new Promise(resolve => setTimeout(resolve, 1_500)); await route.fulfill({ status: 404, headers: responseHeaders, body: JSON.stringify({ error: { code: 'not_found', message: 'File not found.' } }) }) })
  await page.route(`**/api/shared/files/${new URL(url).pathname.split('/').pop()}`, route => route.fulfill({ status: 404, headers: responseHeaders, body: JSON.stringify({ error: { code: 'not_found', message: 'File not found.' } }) }))
  await page.goto(url, { waitUntil: 'commit' })
  await page.locator('.startup-root').waitFor({ state: 'visible', timeout: 10_000 })
  await shot('01-first-styled-frame')
  try {
    await page.waitForFunction(() => document.querySelector('.startup-root')?.textContent?.includes('Opening file'), undefined, { timeout: 60_000 })
  } catch (error) {
    const state = await page.evaluate(() => ({ root: document.querySelector('body > main')?.outerHTML ?? null, samples: window.__canvasStartupSamples }))
    evidence.samples = state.samples
    throw new Error(`Opening file state was not reached. Current root: ${state.root}`, { cause: error })
  }
  await shot('02-hydrated-opening-frame')
  await page.waitForTimeout(1_000)

  evidence.samples = await page.evaluate(() => window.__canvasStartupSamples)
  const browserMetrics = await page.evaluate(() => ({
    navigation: performance.getEntriesByType('navigation')[0]?.toJSON() ?? null,
    paints: performance.getEntriesByType('paint').map(entry => entry.toJSON()),
    startup: window.__canvasStartupMetrics,
  }))
  const painted = evidence.samples.filter(sample => sample.source === 'first-paint' || sample.source === 'first-contentful-paint')
  const rooted = evidence.samples.filter(sample => sample.className)
  const startup = rooted.filter(sample => sample.className.includes('startup-root'))
  assert.ok(delayedScripts > 0, 'the cold-start negative control must delay at least one client script')
  assert.ok(startup.length > 0, 'the first visible application state must use the startup shell')
  assert.ok(startup.every(sample => sample.background !== 'rgba(0, 0, 0, 0)'), 'every startup sample must have an opaque themed background')
  assert.ok(rooted[0].className.includes('startup-root'), `the first observed root was ${rooted[0].className}`)
  assert.ok(painted.length > 0 && painted.every(sample => sample.className?.includes('startup-root') && sample.background !== 'rgba(0, 0, 0, 0)'), 'the browser first paint must contain the opaque startup shell')
  assert.ok(painted.every(sample => sample.htmlClass === `theme-${appearance}`), `the first paint must use the persisted ${appearance} appearance`)
  const firstRooted = evidence.samples.findIndex(sample => sample.className)
  assert.ok(evidence.samples.slice(firstRooted).every(sample => sample.className), 'the application must never return to a rootless frame after its shell appears')
  assert.ok(startup.every(sample => sample.text.includes('Opening file')), 'every startup sample must show the file-opening state')
  assert.ok(startup.every(sample => !sample.text.includes('Checking your session…')), 'authentication must not replace the route-owned file-opening state')
  assert.ok(rooted.every(sample => !sample.className.includes('auth-root')), 'authentication must not substitute a different first-paint shell')
  const positions = startup.map(sample => sample.mark).filter(Boolean)
  const drift = positions.reduce((maximum, position) => Math.max(maximum, Math.abs(position.x - positions[0].x), Math.abs(position.y - positions[0].y)), 0)
  assert.ok(drift <= 1, `the loader moved ${drift.toFixed(2)}px while startup state changed`)
  const openingSample = startup.find(sample => sample.text.includes('Opening file'))
  const firstContentfulPaint = browserMetrics.paints.find(entry => entry.name === 'first-contentful-paint')?.startTime ?? null
  evidence.measurements = {
    firstContentfulPaintMs: firstContentfulPaint,
    openingStateObservedMs: openingSample?.at ?? null,
    cumulativeLayoutShift: browserMetrics.startup.layoutShift,
    longTasks: browserMetrics.startup.longTasks,
    loaderMaximumDriftPx: drift,
    navigation: browserMetrics.navigation,
  }
  record('The server shell is already themed and visible before the delayed client bundle runs', `${delayedScripts} scripts delayed`)
  record('The route-owned file-opening state remains stable while authentication resolves')
  record('The loader remains geometrically stable while startup copy changes', `maximum drift ${drift.toFixed(2)}px`)
  record('Cold-start performance metadata is recorded without claiming the complete interaction budget', `FCP ${firstContentfulPaint?.toFixed(1) ?? 'unavailable'}ms`)
  evidence.status = 'passed'
} catch (error) {
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(evidence.error)
  process.exitCode = 1
} finally {
  const video = page?.video()
  if (page && !page.isClosed()) await page.close()
  if (context) await context.close()
  if (video) {
    try { const current = await video.path(); const target = join(evidenceRoot, 'cold-file-open.webm'); await rename(current, target); evidence.recording = 'cold-file-open.webm' } catch (error) { evidence.error ??= error instanceof Error ? error.message : String(error); evidence.status = 'failed'; process.exitCode = 1 }
  }
  if (browser) await browser.close()
  await writeFile(join(evidenceRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, screenshots: evidence.screenshots, recording: evidence.recording }))
}
