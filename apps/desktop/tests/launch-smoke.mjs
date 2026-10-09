import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureSource = resolve(desktopRoot, '../../fixtures/component-repo')
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'design-editor-smoke-')))
const fixtureRoot = join(temporaryRoot, 'workspace', 'fixtures', 'component-repo')
const runs = []

async function sourceBytes(root) {
  const entries = {}
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.design-editor') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) entries[relative(root, path).split(sep).join('/')] = (await readFile(path)).toString('base64')
    }
  }
  await visit(root)
  return entries
}

function connect(url, sockets) {
  const socket = new WebSocket(url)
  sockets.push(socket)
  let sequence = 0
  const pending = new Map()
  const ready = new Promise((resolveReady, reject) => {
    socket.addEventListener('open', resolveReady, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(String(event.data))
    const request = pending.get(data.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(data.id)
    if (data.error) request.reject(new Error(JSON.stringify(data.error)))
    else request.resolve(data.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Debugger connection closed.')) }
    pending.clear()
  })
  return async (method, params = {}) => {
    await ready
    return new Promise((resolveRequest, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 90_000)
      pending.set(id, { resolve: resolveRequest, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
}

async function launch(sequence) {
  const env = { ...process.env, DESIGN_EDITOR_SMOKE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [desktopRoot, `--smoke-fixture-root=${fixtureRoot}`, `--user-data-dir=${join(temporaryRoot, `profile-${sequence}`)}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const sockets = []
  let output = ''
  let exited = false
  let browser
  let closed = false
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  child.once('exit', () => { exited = true })
  child.once('error', (error) => { output += error.message; exited = true })
  const run = {
    async close() {
      if (closed) return
      closed = true
      if (browser && !exited) await browser('Browser.close').catch(() => undefined)
      for (const socket of sockets) socket.close()
      for (let attempt = 0; attempt < 80 && !exited; attempt++) await delay(250)
      if (!exited) { child.kill(); throw new Error('Electron did not quit cleanly.') }
    },
  }
  runs.push(run)
  let match
  for (let attempt = 0; attempt < 120 && !exited; attempt++) {
    match = /DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/\S+)/.exec(output)
    if (match) break
    await delay(500)
  }
  if (!match) throw new Error(`Electron debugger did not start. ${output}`)
  browser = connect(match[1], sockets)
  let page
  for (let attempt = 0; attempt < 120 && !exited; attempt++) {
    const pages = await (await fetch(`http://127.0.0.1:${match[2]}/json/list`)).json()
    page = pages.find((candidate) => candidate.type === 'page' && candidate.url === 'design-editor://app/')
    if (page) break
    await delay(500)
  }
  if (!page) throw new Error(`Bundled renderer did not load. ${output}`)
  const evaluate = connect(page.webSocketDebuggerUrl, sockets)
  run.evaluate = async (expression) => {
    const result = await evaluate('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  run.call = (method, ...args) => {
    assert.ok(['inspectFixture', 'prepareLabelPadding', 'prepareToken', 'preparePromotion', 'prepareUndo', 'prepareRedo', 'saveFile', 'savePrepared', 'refresh'].includes(method))
    return run.evaluate(`window.designEditor[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
  }
  let bridgeReady = false
  for (let attempt = 0; attempt < 120; attempt++) {
    bridgeReady = await run.evaluate('location.href === "design-editor://app/" && typeof window.designEditor === "object"').catch(() => false)
    if (bridgeReady) break
    await delay(250)
  }
  assert.equal(bridgeReady, true, `The bundled document and preload bridge did not become ready. ${output}`)
  return run
}

const checkedInBefore = await sourceBytes(fixtureSource)
const report = { status: 'pending', flows: [], undo: 'Source undo and redo control coverage is recorded by the separate ui-interactions runner.', visualCoverage: 'None. This smoke uses IPC and disk assertions without UI clicks.' }
try {
  await cp(fixtureSource, fixtureRoot, { recursive: true, filter: (path) => !relative(fixtureSource, path).split(sep).some((part) => part === 'node_modules' || part === '.design-editor') })
  await cp(resolve(desktopRoot, '../../tsconfig.base.json'), join(temporaryRoot, 'workspace', 'tsconfig.base.json'))
  await symlink(await realpath(join(fixtureSource, 'node_modules')), join(fixtureRoot, 'node_modules'), 'junction')
  const first = await launch(1)
  const boundary = await first.evaluate('({url:location.href,bridge:Object.keys(window.designEditor).sort(),node:typeof window.require,process:typeof window.process})')
  assert.equal(boundary.url, 'design-editor://app/')
  assert.equal(boundary.node, 'undefined')
  assert.equal(boundary.process, 'undefined')
  assert.deepEqual(boundary.bridge, ['inspectFixture', 'prepareLabelPadding', 'preparePromotion', 'prepareRedo', 'prepareToken', 'prepareUndo', 'refresh', 'saveFile', 'savePrepared'])
  await assert.rejects(first.call('preparePromotion', '../Outside'))
  const initial = await first.call('inspectFixture')
  assert.deepEqual(initial.atoms.map((atom) => atom.name).sort(), ['Button', 'Card', 'Input', 'Label'])
  assert.equal(initial.preview.status, 'ready', JSON.stringify(initial.preview))
  const identities = Object.fromEntries(initial.atoms.map((atom) => [atom.name, atom.componentId]))
  report.flows.push('Real renderer bridge inspected; malformed promotion denied; four atoms discovered.')

  const labelPath = join(fixtureRoot, 'src/atoms/Label.tsx')
  const originalLabel = await readFile(labelPath, 'utf8')
  assert.ok(originalLabel.includes("padding: '4px 0'"))
  const expectedLabel = originalLabel.replace("padding: '4px 0'", "padding: '12px 0'")
  const label = await first.call('prepareLabelPadding', '12px 0')
  assert.deepEqual(label.files.map((file) => file.path), ['src/atoms/Label.tsx'])
  assert.ok(label.validation.length > 0 && label.validation.every((check) => check.status === 'passed'))
  assert.equal(await readFile(labelPath, 'utf8'), originalLabel)
  const wrongDigest = `${label.approvalDigest[0] === '0' ? '1' : '0'}${label.approvalDigest.slice(1)}`
  await assert.rejects(first.call('savePrepared', label.id, wrongDigest))
  assert.equal(await readFile(labelPath, 'utf8'), originalLabel)
  const savedLabel = await first.call('savePrepared', label.id, label.approvalDigest)
  assert.equal(savedLabel.status, 'saved')
  assert.equal(await readFile(labelPath, 'utf8'), expectedLabel)
  await assert.rejects(first.call('savePrepared', label.id, label.approvalDigest))
  report.flows.push('Label preparation left bytes unchanged; altered digest denied; exact digest saved only 4px 0 -> 12px 0; approval replay denied.')

  const cssPath = join(fixtureRoot, 'src/globals.css')
  const originalCss = await readFile(cssPath, 'utf8')
  assert.ok(originalCss.includes('--accent: #685fff;'))
  const token = await first.call('prepareToken', '#123456')
  assert.deepEqual(token.files.map((file) => file.path), ['src/globals.css'])
  assert.equal((await first.call('savePrepared', token.id, token.approvalDigest)).status, 'saved')
  assert.equal(await readFile(cssPath, 'utf8'), originalCss.replace('--accent: #685fff;', '--accent: #123456;'))
  report.flows.push('Token Save patched only the canonical --accent declaration in globals.css.')

  const stale = await first.call('prepareLabelPadding', '20px 0')
  const externalLabel = expectedLabel.replace("padding: '12px 0'", "padding: '16px 0'")
  await writeFile(labelPath, externalLabel)
  const conflicted = await first.call('savePrepared', stale.id, stale.approvalDigest)
  assert.equal(conflicted.status, 'conflict')
  assert.equal(conflicted.snapshot.conflict.kind, 'external-change')
  assert.equal(await readFile(labelPath, 'utf8'), externalLabel)
  const refreshed = await first.call('refresh')
  assert.equal(refreshed.preview.status, 'ready')
  assert.equal(refreshed.atoms.find((atom) => atom.name === 'Label').componentId, identities.Label)
  report.flows.push('External 16px Label edit invalidated prior 20px approval, survived denied Save, and rebuilt through refresh.')

  const promotion = await first.call('preparePromotion', 'SmokeLogin')
  assert.deepEqual(promotion.files.map((file) => file.path).sort(), ['src/components/SmokeLogin.tsx', 'src/components/index.ts'])
  const promoted = await first.call('savePrepared', promotion.id, promotion.approvalDigest)
  assert.equal(promoted.status, 'saved')
  assert.equal(promoted.snapshot.preview.status, 'ready')
  const promotedBytes = await readFile(join(fixtureRoot, 'src/components/SmokeLogin.tsx'), 'utf8')
  assert.match(promotedBytes, /import\s*\{\s*Button,\s*Card,\s*Input,\s*Label\s*\}\s*from\s*['"]\.\.\/atoms['"]/)
  assert.match(promotedBytes, /export function SmokeLogin\(/)
  assert.match(promotedBytes, /createPortal/)
  assert.match(promotedBytes, /PreviewMessage/)
  assert.ok(promoted.snapshot.composition.componentId)
  const component = promoted.snapshot.atoms.find((atom) => atom.exportName === 'SmokeLogin')
  assert.equal(component.path, 'src/components/SmokeLogin.tsx')
  assert.equal(promoted.snapshot.composition.componentId, component.componentId)
  report.flows.push('Promotion saved real SmokeLogin TSX importing four existing atoms, retaining provider/portal source, and rebound composition to its component ID.')

  const persistedSource = await sourceBytes(fixtureRoot)
  const expectedCompositionId = promoted.snapshot.composition.componentId
  const expectedProjectId = promoted.snapshot.projectId
  await first.close()
  const second = await launch(2)
  const reopened = await second.call('inspectFixture')
  assert.equal(reopened.projectId, expectedProjectId)
  assert.equal(reopened.composition.componentId, expectedCompositionId)
  assert.equal(reopened.preview.status, 'ready')
  for (const [name, componentId] of Object.entries(identities)) assert.equal(reopened.atoms.find((atom) => atom.name === name).componentId, componentId)
  assert.deepEqual(await sourceBytes(fixtureRoot), persistedSource)
  await second.close()
  assert.deepEqual(await sourceBytes(fixtureSource), checkedInBefore)
  report.flows.push('Clean quit and reopen preserved project ID, all atom IDs, promoted binding, and exact saved source bytes; checked-in fixture bytes unchanged.')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  for (const run of runs) await run.close().catch((error) => { report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1 })
  await unlink(join(fixtureRoot, 'node_modules')).catch((error) => { if (error.code !== 'ENOENT') throw error })
  const safeTemporaryRoot = await realpath(temporaryRoot)
  assert.equal(safeTemporaryRoot, temporaryRoot)
  assert.ok(relative(await realpath(tmpdir()), safeTemporaryRoot).startsWith('design-editor-smoke-'))
  await rm(safeTemporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
  report.temporaryDataRemoved = true
  console.log(JSON.stringify(report, null, 2))
}
