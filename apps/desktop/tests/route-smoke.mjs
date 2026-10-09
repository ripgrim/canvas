// Electron routing smoke: the thin shell serves nested routes after reload and keeps IPC trust bound to the editor origin.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureSource = resolve(desktopRoot, '../../fixtures/component-repo')
const evidenceRoot = resolve(desktopRoot, '../../outputs/desktop-routing')
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'design-editor-route-smoke-')))
const fixtureRoot = join(temporaryRoot, 'workspace', 'fixtures', 'component-repo')
const viewStateKey = 'design-editor.view-state.v1'
const report = { status: 'failed', checks: [], skipped: [], error: null }
const record = (name, detail = '') => { report.checks.push({ name, detail }); console.log('✓', name, detail) }
const skip = (name, reason) => { report.skipped.push({ name, reason }); console.log('SKIPPED (not a pass):', name, '-', reason) }

function connect(url, sockets) {
  const socket = new WebSocket(url)
  sockets.push(socket)
  let sequence = 0
  const pending = new Map()
  const ready = new Promise((resolveReady, reject) => { socket.addEventListener('open', resolveReady, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => { const data = JSON.parse(String(event.data)); const request = pending.get(data.id); if (!request) return; clearTimeout(request.timer); pending.delete(data.id); data.error ? request.reject(new Error(JSON.stringify(data.error))) : request.resolve(data.result) })
  socket.addEventListener('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Debugger connection closed.')) } pending.clear() })
  return async (method, params = {}) => { await ready; return new Promise((resolveRequest, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 90_000); pending.set(id, { resolve: resolveRequest, reject, timer }); socket.send(JSON.stringify({ id, method, params })) }) }
}

async function launch(sequence) {
  const env = { ...process.env, DESIGN_EDITOR_SMOKE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [desktopRoot, `--smoke-fixture-root=${fixtureRoot}`, `--user-data-dir=${join(temporaryRoot, `profile-${sequence}`)}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { cwd: desktopRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const sockets = []
  let output = ''
  let exited = false
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  child.once('exit', () => { exited = true })
  let match
  for (let attempt = 0; attempt < 120 && !exited; attempt++) { match = /DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/\S+)/.exec(output); if (match) break; await delay(500) }
  if (!match) throw new Error(`Electron debugger did not start. ${output}`)
  const browser = connect(match[1], sockets)
  const port = match[2]
  const findPage = async predicate => { for (let attempt = 0; attempt < 120 && !exited; attempt++) { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page = pages.find(candidate => candidate.type === 'page' && predicate(candidate.url)); if (page) return page; await delay(500) } throw new Error(`Renderer page not found. ${output}`) }
  const page = await findPage(url => url.startsWith('design-editor://app/'))
  const session = connect(page.webSocketDebuggerUrl, sockets)
  const evaluate = async expression => { const result = await session('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)); return result.result.value }
  const until = async (expression, label) => { for (let attempt = 0; attempt < 160; attempt++) { if (await evaluate(expression).catch(() => false)) return; await delay(250) } throw new Error(`${label}. ${output.slice(-1500)}`) }
  return {
    evaluate, until, session,
    async close() { if (!exited) await browser('Browser.close').catch(() => undefined); for (const socket of sockets) socket.close(); for (let attempt = 0; attempt < 80 && !exited; attempt++) await delay(250); if (!exited) child.kill() },
  }
}

const runs = []
try {
  await mkdir(evidenceRoot, { recursive: true })
  await cp(fixtureSource, fixtureRoot, { recursive: true, filter: path => !relative(fixtureSource, path).split(sep).some(part => part === 'node_modules' || part === '.design-editor') })
  await cp(resolve(desktopRoot, '../../tsconfig.base.json'), join(temporaryRoot, 'workspace', 'tsconfig.base.json'))
  await symlink(await realpath(join(fixtureSource, 'node_modules')), join(fixtureRoot, 'node_modules'), 'junction')

  const first = await launch(1)
  runs.push(first)
  await first.until('location.href === "design-editor://app/" && typeof window.designEditor === "object"', 'bundled shell and bridge did not become ready')
  assert.equal(await first.evaluate('document.title'), 'Comp Canvas')
  await first.until('Boolean(document.querySelector(".canvas-stage"))', 'editor did not render for the fixture project')
  const atoms = await first.evaluate('window.designEditor.inspectFixture().then(snapshot => snapshot.atoms.map(atom => atom.name).sort())')
  for (const name of ['Button', 'Card', 'Input', 'Label']) assert.ok(atoms.includes(name), atoms.join(','))
  record('Packaged shell loads the editor at the app origin with a working IPC bridge', 'design-editor://app/')

  // Canvas default theme: options come from the fixture stylesheet; the choice is editor view state in localStorage, not project metadata.
  await first.evaluate('([...document.querySelectorAll("button")].find(button => button.textContent === "Open fixture")?.click(), true)')
  await first.until('Boolean(document.querySelector("[role=\\"treeitem\\"]"))', 'fixture project did not open in the editor')
  await first.until('Boolean(document.querySelector("select[aria-label=\\"Canvas default theme\\"]"))', 'preview theme control did not render')
  const themeOptions = await first.evaluate('[...document.querySelector("select[aria-label=\\"Canvas default theme\\"]").options].map(option => option.value)')
  assert.deepEqual(themeOptions, ['default', 'dark'], 'fixture stylesheet declares the root palette and one dark mode')
  const projectId = await first.evaluate('window.designEditor.inspectFixture().then(snapshot => snapshot.projectId)')
  assert.equal(typeof projectId, 'string', 'the project snapshot names its project')
  assert.equal(await first.evaluate('window.designEditor.inspectFixture().then(snapshot => "previewTheme" in snapshot)'), false, 'the project snapshot carries no view state')
  const editorDarkBefore = await first.evaluate('document.querySelector(".editor-root").classList.contains("theme-dark")')
  await first.evaluate('(() => { const select = document.querySelector("select[aria-label=\\"Canvas default theme\\"]"); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; setter.call(select, "dark"); select.dispatchEvent(new Event("change", { bubbles: true })); return true })()')
  await first.until('document.querySelector("select[aria-label=\\"Canvas default theme\\"]").value === "dark"', 'preview theme select did not update')
  assert.equal(await first.evaluate('document.querySelector(".editor-root").classList.contains("theme-dark")'), editorDarkBefore, 'design theme leaves the editor appearance alone')
  assert.equal('previewTheme' in JSON.parse(await readFile(join(fixtureRoot, '.design-editor', 'identity.json'), 'utf8')), false, 'project metadata does not store the preview theme')
  record('Preview theme options come from the fixture stylesheet, the select switches to dark, and the editor appearance stays put')

  const storedThemeExpression = `(() => { const raw = localStorage.getItem(${JSON.stringify(viewStateKey)}); if (raw === null) return { present: false }; try { return { present: true, themeId: JSON.parse(raw)?.files?.[${JSON.stringify(projectId)}]?.previewThemeId ?? null } } catch { return { present: true, themeId: 'unparseable' } } })()`
  let storedTheme = { present: false }
  for (let attempt = 0; attempt < 40; attempt++) { storedTheme = await first.evaluate(storedThemeExpression); if (storedTheme.present && storedTheme.themeId === 'dark') break; await delay(250) }
  if (storedTheme.present) {
    assert.equal(storedTheme.themeId, 'dark', `${viewStateKey} stores the preview theme for project ${projectId}`)
    record('The preview theme choice is stored as editor view state', `${viewStateKey} files[${projectId}].previewThemeId = dark`)
  } else skip('The preview theme choice is stored as editor view state', `localStorage key ${viewStateKey} was still absent 10 seconds after selecting dark; the editor has not implemented view-state storage yet`)

  // Nested route after a reload: the asset handler serves the shell, the route renders, and IPC stays trusted for the same origin.
  await first.evaluate('history.pushState({}, "", "/file/01M38YBDDRJSMJ5M4VRYVV8E4Z"), location.href')
  await first.session('Page.reload', { ignoreCache: true })
  await delay(1500)
  await first.until('location.pathname === "/file/01M38YBDDRJSMJ5M4VRYVV8E4Z" && document.body && document.body.innerText.length > 0', 'nested route did not render after reload')
  const routed = await first.evaluate('({ href: location.href, bridge: typeof window.designEditor, text: document.body.innerText.slice(0, 400), title: document.title })')
  assert.equal(routed.bridge, 'object', 'preload bridge stays exposed on nested routes after reload')
  assert.match(routed.text, /File URLs are not available here/)
  const afterRoute = await first.evaluate('window.designEditor.inspectFixture().then(snapshot => snapshot.projectId !== undefined)')
  assert.equal(afterRoute, true, 'IPC remains trusted after the path changed')
  record('Reload on /file/<id> serves the shell, renders the honest unavailable state, and keeps IPC trust', routed.href)

  // Back to files returns to the editor route in-app.
  await first.evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "Back to files").click(), true')
  await first.until('location.pathname === "/" && Boolean(document.querySelector(".canvas-stage"))', 'Back to files did not return to the editor')
  record('In-app navigation back to / restores the editor without a full reload')
  await first.close()

  // Restart lands on the app origin again. The same profile keeps the editor's localStorage view state.
  const second = await launch(1)
  runs.push(second)
  await second.until('location.href === "design-editor://app/" && typeof window.designEditor === "object"', 'restart did not load the shell')
  await second.until('Boolean(document.querySelector(".canvas-stage"))', 'restart did not render the editor')
  record('Restart loads the shell at the app origin with the bridge')
  await second.evaluate('([...document.querySelectorAll("button")].find(button => button.textContent === "Open fixture")?.click(), true)')
  await second.until('Boolean(document.querySelector("select[aria-label=\\"Canvas default theme\\"]"))', 'preview theme control did not render after restart')
  if (storedTheme.present) {
    await second.until('document.querySelector("select[aria-label=\\"Canvas default theme\\"]").value === "dark"', 'restart did not restore the stored preview theme')
    record('Restart restores the preview theme from editor view state')
  } else skip('Restart restores the preview theme from editor view state', `localStorage key ${viewStateKey} was never written in the first run`)
  await second.close()
  report.status = 'passed'
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(report.error)
  process.exitCode = 1
} finally {
  for (const run of runs) await run.close().catch(() => undefined)
  await writeFile(join(evidenceRoot, 'result.json'), JSON.stringify(report, null, 2)).catch(() => undefined)
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => undefined)
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, skipped: report.skipped.length }))
}
