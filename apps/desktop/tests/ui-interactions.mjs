import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = resolve(desktopRoot, '../..')
const outputRoot = join(projectRoot, 'outputs')
const fixtureSource = join(projectRoot, 'fixtures/component-repo')
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'design-editor-ui-')))
const fixtureRoot = join(temporaryRoot, 'workspace/fixtures/component-repo')
const runs = []
const report = { status: 'pending', actualControls: [], readOnlyAssertions: [], screenshots: [], bridgeInvocations: [], rendererDiagnostics: [], limitations: ['Safe local fixture only.', 'Windows keyboard map exercised; macOS map requires a separate platform run.', 'Fonts use the configured fallback because licensed font files were not supplied.'] }
const recordControl = flow => {
  report.actualControls.push(flow)
  console.log(JSON.stringify({ event: 'ui-flow-passed', time: new Date().toISOString(), flow }))
}
const diagnosticText = value => String(value ?? '')
  .replace(/(?:https?|wss?|file|design-editor):\/\/[^\s)"'<>]+/g, value => {
    try {
      const url = new URL(value)
      if (url.protocol === 'design-editor:' && url.host === 'app' || ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return `${url.protocol}//${url.host}${url.pathname}`
    } catch {}
    return '[external URL]'
  })
  .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
  .replace(/\b(token|cookie|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
  .slice(0, 1400)

function rendererEvent(event) {
  if (report.rendererDiagnostics.length >= 40) return
  let diagnostic
  if (event.method === 'Runtime.exceptionThrown') {
    const detail = event.params.exceptionDetails
    diagnostic = { source: 'exception', level: 'error', message: diagnosticText(detail.exception?.description ?? detail.text), url: diagnosticText(detail.url), line: detail.lineNumber }
  } else if (event.method === 'Runtime.consoleAPICalled') {
    const messages = event.params.args.map(argument => ['string', 'number', 'boolean'].includes(argument.type) ? argument.value : argument.subtype === 'error' ? argument.description : `[${argument.type}]`)
    diagnostic = { source: 'console', level: event.params.type, message: diagnosticText(messages.join(' ')) }
  } else if (event.method === 'Log.entryAdded') {
    const entry = event.params.entry
    diagnostic = { source: entry.source, level: entry.level, message: diagnosticText(entry.text), url: diagnosticText(entry.url), line: entry.lineNumber }
  }
  if (!diagnostic || report.rendererDiagnostics.some(previous => previous.source === diagnostic.source && previous.message === diagnostic.message)) return
  report.rendererDiagnostics.push(diagnostic)
  console.log(JSON.stringify({ event: 'renderer-diagnostic', ...diagnostic }))
}

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

async function until(read, predicate, message, timeout = 90_000) {
  const deadline = Date.now() + timeout
  let latest
  while (Date.now() < deadline) {
    try { latest = await read(); if (predicate(latest)) return latest } catch (error) { latest = error.message }
    await delay(150)
  }
  throw new Error(`${message}. Last observation: ${JSON.stringify(latest)}`)
}

function connect(url, sockets, onEvent) {
  const socket = new WebSocket(url)
  sockets.push(socket)
  let sequence = 0
  const pending = new Map()
  const ready = new Promise((resolveReady, reject) => {
    socket.addEventListener('open', resolveReady, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', event => {
    const data = JSON.parse(String(event.data))
    if (data.method) { onEvent?.(data); return }
    const request = pending.get(data.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(data.id)
    data.error ? request.reject(new Error(JSON.stringify(data.error))) : request.resolve(data.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Debugger connection closed.')) }
    pending.clear()
  })
  return async (method, params = {}, sessionId) => {
    await ready
    return new Promise((resolveRequest, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 90_000)
      pending.set(id, { resolve: resolveRequest, reject, timer })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
}

async function launch() {
  const env = { ...process.env, DESIGN_EDITOR_SMOKE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [desktopRoot, `--smoke-fixture-root=${fixtureRoot}`, `--user-data-dir=${join(temporaryRoot, 'profile')}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const sockets = []
  let output = ''
  let exited = false
  let browser
  let closed = false
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  child.once('exit', () => { exited = true })
  child.once('error', error => { output += error.message; exited = true })
  const run = {
    async close() {
      if (closed) return
      closed = true
      if (browser && !exited) await browser('Browser.close').catch(() => undefined)
      for (const socket of sockets) socket.close()
      await until(() => exited, Boolean, 'Electron did not quit cleanly', 20_000).catch(error => { child.kill(); throw error })
    },
  }
  runs.push(run)
  const match = await until(() => /DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/\S+)/.exec(output), Boolean, 'Electron debugger did not start')
  browser = connect(match[1], sockets)
  await browser('Target.setDiscoverTargets', { discover: true })
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${match[2]}/json/list`)).json()).find(candidate => candidate.type === 'page' && candidate.url === 'design-editor://app/'), Boolean, 'Bundled editor did not load')
  const cdp = connect(page.webSocketDebuggerUrl, sockets, rendererEvent)
  run.cdp = cdp
  await Promise.all([cdp('Runtime.enable'), cdp('Log.enable'), cdp('Page.enable')])
  run.evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  run.locate = async (selector, label, index = 0, enabledOnly = false) => run.evaluate(`(() => {
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(element => {
      const bounds = element.getBoundingClientRect();
      const name = element.getAttribute('aria-label') || (element.labels?.length ? [...element.labels].map(label => (label.querySelector('span')?.textContent || label.textContent).trim()).join(' ') : element.textContent.trim());
      return bounds.width && bounds.height && (!${enabledOnly} || !(element.disabled || element.getAttribute('aria-disabled') === 'true')) && (${JSON.stringify(label)} === null || name === ${JSON.stringify(label)});
    });
    const element = matches[${index}];
    if (!element) return null;
    element.scrollIntoView({block:'center',inline:'nearest'});
    const bounds = element.getBoundingClientRect();
    return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2,disabled:element.disabled || element.getAttribute('aria-disabled') === 'true',value:element.value};
  })()`)
  run.click = async (selector, label = null, index = 0) => {
    const point = await until(() => run.locate(selector, label, index, true), value => value && !value.disabled, `Control unavailable: ${selector} ${label}`)
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  run.button = label => run.click('button', label)
  run.expand = async label => {
    const closed = await run.evaluate(`([...document.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent.trim() === ${JSON.stringify(label)}))?.open === false`)
    if (closed) await run.click('summary', label)
  }
  run.key = async (key, code, modifiers = 0, windowsVirtualKeyCode) => {
    const params = { key, code, modifiers, ...(windowsVirtualKeyCode ? { windowsVirtualKeyCode } : {}) }
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  run.input = async (label, value) => {
    await run.click('input', label)
    await run.key('a', 'KeyA', 2, 65)
    await cdp('Input.insertText', { text: String(value) })
    await run.key('Tab', 'Tab', 0, 9)
  }
  run.select = async (label, value) => {
    const options = await run.evaluate(`(() => { const element = [...document.querySelectorAll('select')].find(element => (element.getAttribute('aria-label') || element.labels?.[0]?.querySelector('span')?.textContent) === ${JSON.stringify(label)}); return element ? [...element.options].map(option => ({value:option.value,text:option.text,disabled:option.disabled})) : null })()`)
    assert.ok(options, `Select ${label} must exist`)
    const index = options.findIndex(option => option.value === value || option.text === value)
    assert.ok(index >= 0 && !options[index].disabled, `Select ${label} must expose ${value}`)
    await run.click('select', label)
    await run.key('Home', 'Home', 0, 36)
    for (let at = 0; at < index; at++) await run.key('ArrowDown', 'ArrowDown', 0, 40)
    await run.key('Enter', 'Enter', 0, 13)
    await run.key('Tab', 'Tab', 0, 9)
  }
  run.screenshot = async name => {
    const image = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const path = join(outputRoot, name)
    await writeFile(path, Buffer.from(image.data, 'base64'))
    report.screenshots.push(path)
  }
  const previewSessions = new Map()
  run.preview = async expression => {
    const source = await run.evaluate('document.querySelector("iframe")?.src')
    assert.ok(source?.startsWith('http://127.0.0.1:'), 'An isolated local preview URL must exist')
    const tree = await cdp('Page.getFrameTree')
    const preview = tree.frameTree.childFrames?.find(child => child.frame.url === source)
    let previewCdp = cdp
    let frameId = preview?.frame.id
    if (!frameId) {
      const targets = await browser('Target.getTargets')
      const target = targets.targetInfos.find(candidate => candidate.type === 'iframe' && candidate.url === source)
      report.previewDebugging = { parentChildren: tree.frameTree.childFrames?.map(child => ({ id: child.frame.id, url: child.frame.url })) ?? [], targets: targets.targetInfos.map(candidate => ({ type: candidate.type, url: candidate.url })), path: 'separate-iframe-target' }
      assert.ok(target, 'A separate preview iframe debugger target must match the rendered iframe URL')
      let sessionId = previewSessions.get(target.targetId)
      if (!sessionId) {
        const attached = await browser('Target.attachToTarget', { targetId: target.targetId, flatten: true })
        sessionId = attached.sessionId
        previewSessions.set(target.targetId, sessionId)
      }
      previewCdp = (method, params) => browser(method, params, sessionId)
      const previewTree = await previewCdp('Page.getFrameTree')
      assert.equal(previewTree.frameTree.frame.url, source)
      frameId = previewTree.frameTree.frame.id
    }
    const world = await previewCdp('Page.createIsolatedWorld', { frameId, worldName: 'ui-acceptance-observer' })
    const result = await previewCdp('Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  run.previewClick = async selector => {
    const point = await run.preview(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return null; const bounds = element.getBoundingClientRect(); return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2} })()`)
    assert.ok(point, `Preview element ${selector} must exist`)
    const frame = await run.evaluate('(() => { const element = document.querySelector("iframe"); const bounds = element.getBoundingClientRect(); return {x:bounds.x,y:bounds.y,scale:bounds.width/element.clientWidth} })()')
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: frame.x + point.x * frame.scale, y: frame.y + point.y * frame.scale, button: 'left', clickCount: 1 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: frame.x + point.x * frame.scale, y: frame.y + point.y * frame.scale, button: 'left', clickCount: 1 })
  }
  await until(() => run.evaluate('Boolean(document.querySelector(".editor-root"))'), Boolean, 'React editor did not mount')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  return run
}

const readDocument = async () => JSON.parse(await readFile(join(fixtureRoot, '.design-editor/document.json'), 'utf8'))
async function assertSelection(run, expectedIds) {
  const expected = [...expectedIds].sort()
  await until(() => run.preview(`Array.from(document.querySelectorAll('[data-preview-selected="true"]')).map(element => { const style = getComputedStyle(element); return {id:element.getAttribute('data-preview-instance'),color:style.outlineColor,style:style.outlineStyle,width:parseFloat(style.outlineWidth)} }).sort((left,right) => left.id.localeCompare(right.id))`), selected => JSON.stringify(selected.map(item => item.id)) === JSON.stringify(expected) && selected.every(item => item.color === 'rgb(0, 159, 240)' && item.style === 'solid' && item.width > 0), 'Selected instance outlines did not match exact IDs and the Wonder accent')
}
const checkedInBefore = await sourceBytes(fixtureSource)
try {
  await mkdir(outputRoot, { recursive: true })
  await cp(fixtureSource, fixtureRoot, { recursive: true, filter: path => !relative(fixtureSource, path).split(sep).some(part => part === 'node_modules' || part === '.design-editor') })
  await cp(join(projectRoot, 'tsconfig.base.json'), join(temporaryRoot, 'workspace/tsconfig.base.json'))
  await symlink(await realpath(join(fixtureSource, 'node_modules')), join(fixtureRoot, 'node_modules'), 'junction')
  const first = await launch()
  assert.deepEqual(await first.evaluate('({node:typeof window.require,process:typeof window.process})'), { node: 'undefined', process: 'undefined' })
  await first.button('Open fixture')
  await until(() => first.evaluate('Boolean(document.querySelector("iframe")) && !document.body.textContent.includes("Reading source")'), Boolean, 'Fixture did not open')
  recordControl('Clicked Open fixture in the bundled Electron renderer.')
  await first.input('Frame width', 480)
  const baseline = await until(readDocument, document => document.frame.width === 480, 'Frame width was not persisted')
  const originalIds = Object.keys(baseline.nodes)
  const originalCard = Object.values(baseline.nodes).find(node => node.exportName === 'Card')
  assert.ok(originalCard, 'The fixture document must contain its original Card')
  await first.click('[role="tab"]', 'Components')
  await first.button('Add Button')
  const inserted = await until(readDocument, document => Object.keys(document.nodes).length === originalIds.length + 1, 'Add Button did not persist a new atom instance')
  const insertedId = Object.keys(inserted.nodes).find(id => !originalIds.includes(id))
  assert.equal(inserted.nodes[insertedId].exportName, 'Button')
  assert.notEqual(inserted.nodes[insertedId].componentId, insertedId)
  assert.ok(Object.values(baseline.nodes).some(node => node.exportName === 'Button' && node.componentId === inserted.nodes[insertedId].componentId), 'Insertion must reuse the real Button component identity')
  await first.click('[role="radio"]', 'Instance')
  await first.input('children', 'Continue securely')
  await first.select('variant', 'quiet')
  await first.click('input[type="checkbox"]', 'disabled')
  await until(readDocument, document => document.nodes[insertedId].props.children === 'Continue securely' && document.nodes[insertedId].props.variant === 'quiet' && document.nodes[insertedId].props.disabled === true, 'Typed prop edits did not persist')
  await until(() => first.preview(`(() => { const node = document.querySelector('[data-preview-instance="${insertedId}"]'); return node ? {tag:node.tagName,text:node.textContent,disabled:node.disabled} : null })()`), value => value?.tag === 'BUTTON' && value.text === 'Continue securely' && value.disabled, 'Real Button preview did not reflect text and boolean props')
  recordControl('Added a real Button, edited children and variant, toggled disabled, and observed the semantic BUTTON in the isolated preview.')
  const inputId = originalIds.find(id => baseline.nodes[id].exportName === 'Input')
  assert.ok(inputId, 'Fixture must include a real Input')
  await first.button('Select')
  await first.previewClick(`[data-preview-instance="${inputId}"]`)
  await assertSelection(first, [inputId])
  assert.equal(await first.preview(`document.activeElement?.getAttribute('data-preview-instance') === ${JSON.stringify(inputId)}`), false, 'Select mode must not activate the imported input')
  await first.button('Interact')
  await first.previewClick(`[data-preview-instance="${inputId}"]`)
  await first.cdp('Input.insertText', { text: 'caleb@example.test' })
  await until(() => first.preview(`document.querySelector('[data-preview-instance="${inputId}"]')?.value`), value => value === 'caleb@example.test', 'Interact mode did not permit actual Input typing')
  await first.button('Select')
  recordControl('Select mode prevented native input activation; Interact mode allowed actual typing inside the imported Input.')
  await first.click('[role="tab"]', 'Layers')
  await first.click(`[role="treeitem"][data-instance-id="${insertedId}"]`)
  await first.button('Duplicate')
  const duplicated = await until(readDocument, document => Object.keys(document.nodes).length === originalIds.length + 2, 'Duplicate did not persist')
  const duplicateId = Object.keys(duplicated.nodes).find(id => !originalIds.includes(id) && id !== insertedId)
  assert.deepEqual(duplicated.nodes[duplicateId].props, duplicated.nodes[insertedId].props)
  assert.equal(duplicated.nodes[duplicateId].componentId, duplicated.nodes[insertedId].componentId)
  assert.notEqual(duplicateId, insertedId)
  await assertSelection(first, [duplicateId])
  await first.button('Move up')
  await until(readDocument, document => document.rootIds.indexOf(duplicateId) < document.rootIds.indexOf(insertedId), 'Move up did not reorder siblings')
  await first.button('Undo document edit')
  await until(readDocument, document => document.rootIds.indexOf(duplicateId) > document.rootIds.indexOf(insertedId), 'Document undo did not restore sibling order')
  await first.button('Redo document edit')
  await until(readDocument, document => document.rootIds.indexOf(duplicateId) < document.rootIds.indexOf(insertedId), 'Document redo did not restore reordered siblings')
  await first.select('Move to', `${originalCard.id}:footer`)
  await first.button('Move')
  await until(readDocument, document => document.nodes[originalCard.id].children.footer?.includes(duplicateId) && !document.rootIds.includes(duplicateId), 'Move to a verified footer slot did not persist')
  await first.button('Move to frame')
  await until(readDocument, document => document.rootIds.includes(duplicateId) && !document.nodes[originalCard.id].children.footer?.includes(duplicateId), 'Move to frame did not detach the slot child')
  recordControl('Selected by exact layer identity, duplicated with fresh instance identity, reordered, undid/redid order, nested in Card.footer, then moved back to the frame.')
  const additivePoint = await first.locate(`[role="treeitem"][data-instance-id="${insertedId}"]`, null)
  await first.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: additivePoint.x, y: additivePoint.y, button: 'left', clickCount: 1, modifiers: 2 })
  await first.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: additivePoint.x, y: additivePoint.y, button: 'left', clickCount: 1, modifiers: 2 })
  assert.equal(await first.evaluate('document.querySelectorAll("[role=treeitem][aria-selected=true]").length'), 2)
  assert.equal(await first.evaluate('document.body.textContent.includes("Multiple instances selected")'), true)
  await assertSelection(first, [insertedId, duplicateId])
  await first.click(`[role="treeitem"][data-instance-id="${duplicateId}"]`)
  await assertSelection(first, [duplicateId])
  assert.equal(await first.evaluate('[...document.querySelectorAll("#component-move-to option")].some(option => option.text.startsWith("Input /"))'), false, 'Input must not be offered as a slot parent')
  recordControl('Ctrl-click multi-selected two instances and showed the explicit multiple-selection inspector; invalid Input slot destinations were absent.')
  const beforeTyping = await readDocument()
  await first.click('input', 'children')
  await first.key('d', 'KeyD', 2, 68)
  await delay(300)
  assert.equal(Object.keys((await readDocument()).nodes).length, Object.keys(beforeTyping.nodes).length, 'Ctrl+D inside text input must not duplicate a canvas instance')
  await first.click(`[role="treeitem"][data-instance-id="${duplicateId}"]`)
  await first.key('d', 'KeyD', 2, 68)
  await until(readDocument, document => Object.keys(document.nodes).length === Object.keys(beforeTyping.nodes).length + 1, 'Ctrl+D on a layer did not duplicate')
  await first.key('z', 'KeyZ', 2, 90)
  await until(readDocument, document => Object.keys(document.nodes).length === Object.keys(beforeTyping.nodes).length, 'Ctrl+Z did not undo the keyboard duplication')
  await assertSelection(first, [duplicateId])
  recordControl('Ctrl+D duplicated from the layer tree and Ctrl+Z reversed it; focused text input prevented the global duplicate shortcut.')
  recordControl('Actual imported DOM elements showed solid nonzero Wonder-accent selection outlines for exact Input and duplicated Button identities; multiselect decorated exactly two instances and undo removed the transient duplicate decoration.')
  await first.input('Frame height', 640)
  await first.input('Gap', 20)
  await first.input('Padding', 32)
  await first.select('Direction', 'Row')
  await first.click('input[type="checkbox"]', 'Clip content')
  await until(readDocument, document => document.frame.height === 640 && document.frame.gap === 20 && document.frame.padding === 32 && document.frame.direction === 'row' && document.frame.clip === true, 'Frame layout controls did not persist')
  await first.click('button', 'Resize frame')
  await first.key('ArrowRight', 'ArrowRight', 8, 39)
  await until(readDocument, document => document.frame.width === 490, 'Shift+ArrowRight on resize handle did not add 10 pixels')
  await first.select('Direction', 'Column')
  const transformBefore = await first.evaluate('document.querySelector(".canvas-world").style.transform')
  await first.button('Zoom in')
  await until(() => first.evaluate('document.querySelector(".canvas-world").style.transform'), transform => transform !== transformBefore, 'Zoom control did not transform canvas')
  await first.button('Hand')
  const viewport = await first.locate('.canvas-viewport', 'Canvas')
  const panBefore = await first.evaluate('document.querySelector(".canvas-world").style.transform')
  await first.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: viewport.x, y: viewport.y, button: 'left', clickCount: 1 })
  await first.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: viewport.x + 45, y: viewport.y + 25, button: 'left', buttons: 1 })
  await first.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: viewport.x + 45, y: viewport.y + 25, button: 'left', clickCount: 1 })
  await until(() => first.evaluate('document.querySelector(".canvas-world").style.transform'), transform => transform !== panBefore, 'Pointer dragging with Hand did not pan')
  await first.button('Fit canvas')
  await first.button('Select')
  recordControl('Changed frame dimensions, gap, padding, direction and clipping; resized with keyboard; used Zoom in, Hand pointer drag, Fit canvas and Select.')
  assert.deepEqual(await sourceBytes(fixtureRoot), checkedInBefore, 'Document editing must not silently write repository source')
  report.readOnlyAssertions.push('Repository source bytes stayed unchanged throughout all composition edits.')
  await until(() => first.evaluate('document.body.textContent'), text => !text.includes('Saving document'), 'Document persistence did not settle before visual capture')
  await until(() => first.preview('document.documentElement.dataset.theme'), theme => theme === 'light', 'Live preview did not inherit the light theme')
  await first.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await first.screenshot('ui-light.png')
  await first.button('Switch to dark mode')
  assert.equal(await first.evaluate('Boolean(document.querySelector(".editor-root.theme-dark"))'), true)
  await until(() => first.preview('document.documentElement.dataset.theme'), theme => theme === 'dark', 'Live preview did not inherit the dark theme')
  await first.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await first.screenshot('ui-dark.png')
  await first.button('Switch to light mode')
  recordControl('Switched light and dark modes with the theme button and captured 1440 by 1000 Electron screenshots.')
  const labelId = originalIds.find(id => baseline.nodes[id].exportName === 'Label')
  assert.ok(labelId, 'Fixture must include a Label instance')
  await first.click(`[role="treeitem"][data-instance-id="${labelId}"]`)
  await first.click('[role="radio"]', 'Shared component')
  await first.input('Label padding', '12px 0')
  await first.click('.right-rail button', 'Review changes')
  await until(() => first.evaluate('document.querySelector(".review-panel")?.textContent'), text => text?.includes('src/atoms/Label.tsx') && text.includes('12px 0'), 'Label source review did not show the changed file and value')
  const labelPath = join(fixtureRoot, 'src/atoms/Label.tsx')
  const originalLabel = await readFile(labelPath, 'utf8')
  assert.ok(originalLabel.includes("padding: '4px 0'"))
  assert.equal((await first.locate('button', 'Save')).disabled, true, 'Save must remain disabled before review approval')
  await first.click('input[type="checkbox"]', 'I reviewed these source changes')
  await first.button('Save')
  const savedLabel = originalLabel.replace("padding: '4px 0'", "padding: '12px 0'")
  await until(() => readFile(labelPath, 'utf8'), bytes => bytes === savedLabel, 'Reviewed Label save did not create the exact minimal patch')
  assert.equal(await first.evaluate('Array.from(document.querySelectorAll(".right-rail summary")).some(element => element.textContent === "Source history")'), false)
  assert.equal(await first.evaluate('Array.from(document.querySelectorAll(".right-rail summary")).some(element => element.textContent === "Create component")'), false)
  assert.equal(await first.evaluate('Array.from(document.querySelectorAll(".right-rail summary")).some(element => element.textContent === "Repository")'), false)
  await writeFile(labelPath, originalLabel)
  await first.click('.file-bar button', 'Sync with source')
  await until(() => first.evaluate('document.body.textContent'), text => !text.includes('Checking source'), 'Sync with source did not reload the restored fixture')
  recordControl('Shared Label padding review and Save remained available while legacy Repository, Create component, and Source history inspector workflows stayed absent.')
  report.readOnlyAssertions.push('The reviewed source patch matched the independent expected literal; the obsolete source-history UI was absent.')
  await first.input('Frame height', 650)
  const persisted = await until(readDocument, document => document.frame.height === 650, 'Final frame change was not saved before reopening')
  await until(() => first.evaluate('document.body.textContent'), text => !text.includes('Saving document'), 'Document save acknowledgement did not finish before quitting')
  assert.equal(await first.evaluate('document.body.textContent.includes("undo history could not be saved")'), false)
  await first.close()
  const reopened = await launch()
  await reopened.button('Open fixture')
  await until(() => reopened.evaluate(`Boolean(document.querySelector('[role="treeitem"][data-instance-id="${insertedId}"]'))`), Boolean, 'Reopened editor did not restore inserted instance')
  assert.deepEqual(await readDocument(), persisted)
  recordControl('Quit Electron, relaunched with the same fixture, clicked Open fixture, and verified exact persisted document and instance identities.')
  await reopened.button('Undo document edit')
  await until(readDocument, document => document.frame.height === 640, 'Document undo history did not survive Electron restart')
  await reopened.button('Redo document edit')
  const redone = await until(readDocument, document => document.frame.height === 650, 'Document redo did not restore the reopened edit')
  assert.deepEqual(redone.nodes, persisted.nodes)
  assert.deepEqual(redone.rootIds, persisted.rootIds)
  recordControl('After reopening, Undo document edit restored frame height 640 and Redo document edit restored 650 with the same node identities and order.')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
  const latest = runs.at(-1)
  if (latest?.evaluate) {
    const startup = await latest.evaluate('({readyState:document.readyState,title:document.title,bodyChildren:document.body?.children.length,bodyTextLength:document.body?.textContent.length,scripts:Array.from(document.scripts).map(script => ({type:script.type,source:script.src || "inline"}))})').catch(error => ({ error: error.message }))
    report.rendererStateOnFailure = startup.error ? { error: diagnosticText(startup.error) } : { ...startup, title: diagnosticText(startup.title), scripts: startup.scripts.slice(0, 20).map(script => ({ type: script.type, source: diagnosticText(script.source) })) }
  }
  if (latest?.screenshot) await latest.screenshot('ui-failure.png').catch(() => undefined)
} finally {
  for (const run of runs) await run.close().catch(error => { report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1 })
  assert.deepEqual(await sourceBytes(fixtureSource), checkedInBefore)
  await unlink(join(fixtureRoot, 'node_modules')).catch(error => { if (error.code !== 'ENOENT') throw error })
  const safeTemporaryRoot = await realpath(temporaryRoot)
  const relativeTemporary = relative(await realpath(tmpdir()), safeTemporaryRoot)
  assert.equal(safeTemporaryRoot, temporaryRoot)
  assert.ok(relativeTemporary.startsWith('design-editor-ui-') && !relativeTemporary.includes(sep) && !isAbsolute(relativeTemporary))
  await rm(safeTemporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
  report.temporaryDataRemoved = true
  await writeFile(join(outputRoot, 'ui-interactions-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
}
