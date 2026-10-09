import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const scriptRoot = fileURLToPath(new URL('../../../', import.meta.url))
const option = name => process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
const projectRoot = resolve(option('project-root') ?? scriptRoot)
const phase = option('phase') ?? 'check'
assert.ok(['baseline', 'fixed', 'check'].includes(phase), 'Phase must be baseline, fixed, or check')
const webRoot = join(projectRoot, 'apps', 'web')
const evidenceRoot = join(scriptRoot, 'outputs', 'selection-preserves-runtime')
const webRequire = createRequire(join(webRoot, 'package.json'))
const editorUrl = 'http://127.0.0.1:4317/'
const previewUrl = 'http://127.0.0.1:4318/'
const owned = []
const evidence = { phase, status: 'failed', browser: 'system Edge, headless', scenarios: [], servers: {}, sourceHashes: {}, negativeControlsProven: false, error: null }
let browser

async function responseAt(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return { status: response.status, text: await response.text() }
  } catch { return null }
}

async function ensureServer(name, url, args, expected) {
  const existing = await responseAt(url)
  if (existing !== null) {
    evidence.servers[name] = 'preexisting'
    assert.equal(existing.status, 200, `${name} already occupies its port but returned HTTP ${existing.status}`)
    assert.match(existing.text, expected, `${name} port belongs to an unexpected service`)
    return
  }
  const vite = join(dirname(webRequire.resolve('vite/package.json')), 'bin', 'vite.js')
  const child = spawn(process.execPath, [vite, ...args], { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  owned.push(child)
  evidence.servers[name] = 'owned'
  let log = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + String(chunk)).slice(-4000) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited before readiness: ${log}`)
    const response = await responseAt(url)
    if (response?.status === 200) { assert.match(response.text, expected); return }
    await new Promise(resolveWait => setTimeout(resolveWait, 300))
  }
  throw new Error(`${name} did not become ready: ${log}`)
}

async function sourceHashes() {
  const paths = ['packages/editor/src/bootstrap.tsx', 'packages/editor/src/features/editor/preview-service.ts']
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(join(projectRoot, path))).digest('hex')])))
}

async function observeRuntime(frame) {
  return frame.locator('body').evaluate(() => {
    const probe = window.selectionRuntimeProbe
    const email = document.getElementById('email')
    const password = document.getElementById('password')
    const portal = document.querySelector('[role="dialog"][aria-label="Preview result"]')
    return {
      sameEmail: email === probe?.email,
      samePassword: password === probe?.password,
      samePortal: portal === probe?.portal,
      email: email?.value ?? null,
      password: password?.value ?? null,
      status: document.querySelector('[role="status"]')?.textContent ?? null,
      provider: portal?.querySelector('p')?.textContent ?? null,
    }
  })
}

const expectedRuntime = {
  sameEmail: true, samePassword: true, samePortal: true,
  email: 'caleb.selection@example.test', password: 'fixture-password-17',
  status: 'Preview form submitted', provider: 'This is a local preview',
}

async function assertPreserved(frame, action, scenario) {
  for (let observation = 0; observation < 4; observation += 1) {
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    const actual = await observeRuntime(frame)
    scenario.observations.push({ action, actual })
    assert.deepEqual(actual, expectedRuntime, `EC-01 ${action} must preserve the running component, uncontrolled input values, provider, and open portal`)
  }
  scenario.checks.push(action)
}

async function seedOriginal(page, scenario) {
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('.file-bar').getByRole('button', { name: 'Open local draft', exact: true }).click()
  await page.getByRole('tree', { name: 'Layers', exact: true }).getByRole('treeitem', { name: 'Button', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => typeof window.designEditor), 'undefined')
  await page.getByRole('button', { name: 'Interact', exact: true }).click()
  const iframe = page.locator('iframe[title="Canvas"]')
  await iframe.contentFrame().getByRole('textbox', { name: 'Email', exact: true }).waitFor()
  const isolation = await iframe.evaluate(element => ({ parent: location.origin, child: new URL(element.src).origin, inaccessible: element.contentDocument === null }))
  assert.equal(isolation.child, new URL(previewUrl).origin)
  assert.notEqual(isolation.child, isolation.parent)
  assert.equal(isolation.inaccessible, true)
  const frame = await iframe.contentFrame()
  await frame.getByRole('textbox', { name: 'Email', exact: true }).fill(expectedRuntime.email)
  await frame.locator('input[type="password"]').fill(expectedRuntime.password)
  await frame.getByRole('button', { name: 'Sign in', exact: true }).click()
  await frame.getByRole('dialog', { name: 'Preview result', exact: true }).waitFor()
  assert.equal(await frame.getByRole('status').textContent(), 'Preview form submitted')
  assert.equal(await frame.getByRole('dialog', { name: 'Preview result', exact: true }).locator('p').textContent(), 'This is a local preview')
  await frame.locator('body').evaluate(() => {
    window.selectionRuntimeProbe = { email: document.getElementById('email'), password: document.getElementById('password'), portal: document.querySelector('[role="dialog"][aria-label="Preview result"]') }
  })
  scenario.checks.push('Original sample inputs, submitted state, provider, and portal are active')
  return frame
}

async function runScenario(name, firstAction) {
  const scenario = { name, status: 'failed', checks: [], observations: [], pageErrors: [], consoleErrors: [], failedRequests: [], failureView: null, error: null }
  evidence.scenarios.push(scenario)
  const context = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', error => scenario.pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') scenario.consoleErrors.push(message.text().slice(0, 1500)) })
  page.on('requestfailed', request => scenario.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
  try {
    const frame = await seedOriginal(page, scenario)
    const stored = await page.evaluate(() => localStorage.getItem('design-editor.browser-draft.v1'))
    const layers = page.getByRole('tree', { name: 'Layers', exact: true })
    if (firstAction === 'layer') {
      const button = layers.getByRole('treeitem', { name: 'Button', exact: true })
      await button.click()
      assert.equal(await button.getAttribute('aria-selected'), 'true')
      await assertPreserved(frame, 'Select Button layer', scenario)
      const label = layers.getByRole('treeitem', { name: 'Label', exact: true }).first()
      await label.click()
      assert.equal(await label.getAttribute('aria-selected'), 'true')
      await assertPreserved(frame, 'Select Label layer', scenario)
    }
    for (const tool of ['Select', 'Hand', 'Interact']) {
      await page.getByRole('button', { name: tool, exact: true }).click()
      await assertPreserved(frame, `Switch to ${tool}`, scenario)
    }
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click()
    await frame.locator('html[data-theme="dark"]').waitFor()
    await assertPreserved(frame, 'Switch to dark mode', scenario)
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click()
    await frame.locator('html[data-theme="light"]').waitFor()
    await assertPreserved(frame, 'Switch to light mode', scenario)
    const button = layers.getByRole('treeitem', { name: 'Button', exact: true })
    await button.click()
    await page.keyboard.press('Escape')
    assert.equal(await layers.locator('[aria-selected="true"]').count(), 0)
    await assertPreserved(frame, 'Clear selection', scenario)
    assert.equal(await page.evaluate(() => localStorage.getItem('design-editor.browser-draft.v1')), stored, 'Selection, tools and theme must not persist a document edit')
    await frame.getByRole('button', { name: 'Close preview', exact: true }).click()
    await frame.getByRole('dialog', { name: 'Preview result', exact: true }).waitFor({ state: 'detached' })
    assert.equal(await frame.getByRole('status').textContent(), 'This is a local preview')
    assert.equal(await frame.getByRole('textbox', { name: 'Email', exact: true }).inputValue(), expectedRuntime.email)
    assert.equal(await frame.locator('input[type="password"]').inputValue(), expectedRuntime.password)
    scenario.checks.push('Original Close preview callback still updates real component state')
    await frame.getByRole('button', { name: 'Sign in', exact: true }).click()
    await frame.getByRole('dialog', { name: 'Preview result', exact: true }).waitFor()
    assert.equal(await frame.getByRole('status').textContent(), 'Preview form submitted')
    scenario.checks.push('Original Sign in callback can reopen the provider-backed portal')
    scenario.status = 'passed'
  } catch (error) {
    scenario.error = error instanceof Error ? error.stack ?? error.message : String(error)
    if (scenario.checks.length === 0) scenario.status = 'blocked'
    if (!page.isClosed()) {
      scenario.failureView = await page.evaluate(() => ({ url: location.href, ready: document.readyState, text: document.body.innerText.slice(0, 2000), scripts: Array.from(document.scripts).map(script => ({ type: script.type, src: script.src })) })).catch(() => null)
      await page.screenshot({ path: join(evidenceRoot, `${phase}-${firstAction}-failure.png`), fullPage: true }).catch(() => undefined)
    }
  } finally { await context.close() }
}

try {
  await mkdir(evidenceRoot, { recursive: true })
  evidence.sourceHashes = await sourceHashes()
  await ensureServer('editor', editorUrl, ['--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4317', '--strictPort'], /Design editor|@vite\/client|TanStack/)
  await ensureServer('preview', previewUrl, ['--config', 'vite.preview.config.ts', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4318', '--strictPort'], /preview-root|@vite\/client|<html/i)
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  await runScenario('EC-01 layer selection preserves original runtime', 'layer')
  await runScenario('EC-01 tool changes preserve original runtime', 'tool')
  assert.deepEqual(await sourceHashes(), evidence.sourceHashes, 'This regression must not modify the editor transition source')
  evidence.negativeControlsProven = phase === 'baseline' && evidence.scenarios.every(scenario => scenario.observations.length > 0 && scenario.error?.includes('EC-01'))
  if (evidence.scenarios.every(scenario => scenario.status === 'passed')) {
    evidence.status = phase === 'baseline' ? 'unexpected-pass' : 'passed'
    if (phase === 'baseline') { evidence.error = 'Baseline did not demonstrate the two required EC-01 negative controls'; process.exitCode = 1 }
  }
  else { if (evidence.scenarios.every(scenario => scenario.status === 'blocked')) evidence.status = 'blocked'; process.exitCode = 1 }
} catch (error) {
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await Promise.all(owned.map(child => child.exitCode !== null ? undefined : new Promise(resolveExit => { child.once('close', resolveExit); child.kill() })))
  await mkdir(evidenceRoot, { recursive: true })
  const result = join(evidenceRoot, `${phase}.json`)
  await writeFile(result, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ status: evidence.status, phase, scenarios: evidence.scenarios.map(({ name, status, error }) => ({ name, status, error })), error: evidence.error, result }))
}
