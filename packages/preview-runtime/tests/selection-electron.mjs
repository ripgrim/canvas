import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
// Protocol v3: every document node carries its effective theme; the plain light fallback is not explicit.
const lightTheme = { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false }

// A 2x1 PNG, red then green, built here so the expected pixels are known independently of the runtime.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]) }
const pngHeader = Buffer.alloc(13); pngHeader.writeUInt32BE(2, 0); pngHeader.writeUInt32BE(1, 4); pngHeader[8] = 8; pngHeader[9] = 2
const swatchPng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', pngHeader), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0]))), chunk('IEND', Buffer.alloc(0))]).toString('base64')
const linear = (angle, interpolation, stops) => ({ type: 'gradient', shape: 'linear', angle, center: { x: 0.5, y: 0.5 }, length: 1, interpolation, stops })
const close = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 3)

const editorUrl = app.commandLine.getSwitchValue('selection-editor-url')
const previewUrl = app.commandLine.getSwitchValue('selection-preview-url')
const generationText = app.commandLine.getSwitchValue('selection-generation')
const userData = app.commandLine.getSwitchValue('user-data-dir')
let window
let debuggerAttached = false
const waitFor = async (read, predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Native preview observation timed out')
}

app.setPath('userData', userData)
app.whenReady().then(async () => {
try {
  process.stderr.write('selection phase: ready\n')
  window = new BrowserWindow({ show: false, width: 900, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadURL(editorUrl)
  process.stderr.write('selection phase: parent loaded\n')
  const frame = await waitFor(async () => window.webContents.mainFrame.frames.find(frame => frame.url === previewUrl), value => Boolean(value))
  process.stderr.write('selection phase: preview frame found\n')
  await waitFor(() => frame.executeJavaScript("Boolean(document.querySelector('.fixture-input'))"), value => value)
  process.stderr.write('selection phase: preview DOM ready\n')
  const generation = Number(generationText)
  const send = async payload => {
    const command = { channel: 'design-editor-preview', version: 3, generation, ...payload }
    await window.webContents.executeJavaScript(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify(command)},${JSON.stringify(new URL(previewUrl).origin)})`)
  }
  const observe = () => frame.executeJavaScript(`(() => {
    const input = document.querySelector('input[data-preview-instance="input-1"][data-preview-component="atom-input"]')
    return { count: document.querySelectorAll('[data-preview-selected]').length, tag: input?.tagName, outlineColor: input && getComputedStyle(input).outlineColor, outlineWidth: input && getComputedStyle(input).outlineWidth, pointerEvents: input && getComputedStyle(input).pointerEvents, width: input?.getBoundingClientRect().width, value: input?.value }
  })()`)
  await send({ type: 'set-selection', nodeIds: ['input-1'], color: '#009ff0' })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal((await observe()).count, 0)
  const document = {
    version: 1, revision: 1, rootIds: ['card-1', 'button-1'], nodes: {
      'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', theme: lightTheme, props: { heading: 'Sign in' }, children: { children: ['input-1'] } },
      'input-1': { id: 'input-1', componentId: 'atom-input', exportName: 'Input', theme: lightTheme, props: { id: 'native-email', type: 'email' }, children: {} },
      'button-1': { id: 'button-1', componentId: 'atom-button', exportName: 'Button', theme: lightTheme, props: { children: 'Go', type: 'button' }, children: {} },
    }, frame: { width: 480, height: 640, direction: 'column', gap: 16, padding: 24, clip: false },
    canvas: { elements: [
      { id: 'hero', kind: 'frame', name: 'Hero', x: 2000, y: 2000, width: 320, height: 200, rotation: 0, appearance: { fills: [linear(135, 'srgb', [{ color: '#9b4dff', position: 0 }, { color: '#000000', position: 1 }])] }, parentId: null, clip: false },
      { id: 'hero-glow', kind: 'shader', name: 'Glow', x: 16, y: 24, width: 80, height: 80, rotation: 0, appearance: { fills: [linear(90, 'srgb', [{ color: 'oklch(0.7 0.1 120)', position: 0 }, { color: '#ffffff', position: 0.5 }])] }, parentId: 'hero' },
      { id: 'hero-title', kind: 'text', name: 'Title', x: 16, y: 120, width: 200, height: 20, rotation: 0, appearance: { fills: [linear(90, 'oklab', [{ color: '#ff0000', position: 0 }, { color: '#0000ff', position: 1 }])] }, text: 'Welcome', parentId: 'hero' },
      { id: 'hero-caption', kind: 'text', name: 'Caption', x: 16, y: 150, width: 200, height: 20, rotation: 0, appearance: { fills: [{ type: 'solid', color: '#64748b' }] }, text: 'Caption', parentId: 'hero' },
      { id: 'panel', kind: 'rectangle', name: 'Panel', x: 320, y: -300, width: 60, height: 40, rotation: 0, appearance: { fills: [{ type: 'solid', color: '#0000ff' }, { type: 'solid', color: '#ff000080' }] }, parentId: null },
      { id: 'photo', kind: 'rectangle', name: 'Photo', x: 320, y: -240, width: 40, height: 20, rotation: 0, appearance: { fills: [{ type: 'image', assetId: 'swatch', fit: 'stretch' }] }, parentId: null },
    ] },
    assets: { swatch: { mime: 'image/png', data: swatchPng } },
  }
  const observeCanvas = () => frame.executeJavaScript(`(() => {
    const read = id => { const node = document.querySelector('[data-preview-canvas="' + id + '"]'); const style = node && getComputedStyle(node); return node && { kind: node.dataset.previewKind, parent: node.parentElement?.dataset.previewCanvas ?? null, backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, backgroundClip: style.backgroundClip, backgroundSize: style.backgroundSize, backgroundRepeat: style.backgroundRepeat, color: style.color, overflow: style.overflow, text: node.textContent } }
    return { hero: read('hero'), glow: read('hero-glow'), title: read('hero-title'), caption: read('hero-caption'), panel: read('panel'), photo: read('photo') }
  })()`)
  await send({ type: 'set-document', document, theme: { attribute: null, colorScheme: 'light' } })
  await waitFor(observe, value => value.tag === 'INPUT')
  const canvas = await waitFor(observeCanvas, value => Boolean(value.hero))
  assert.equal(canvas.hero.kind, 'frame')
  assert.equal(canvas.hero.parent, null)
  assert.equal(canvas.hero.backgroundImage, 'linear-gradient(135deg, rgb(155, 77, 255) 0%, rgb(0, 0, 0) 100%)')
  assert.equal(canvas.hero.overflow, 'visible')
  assert.equal(canvas.glow.kind, 'shader')
  assert.equal(canvas.glow.parent, 'hero')
  assert.equal(canvas.glow.backgroundImage, 'linear-gradient(90deg, oklch(0.7 0.1 120) 0%, rgb(255, 255, 255) 50%)')
  assert.equal(canvas.title.parent, 'hero')
  assert.equal(canvas.title.color, 'rgba(0, 0, 0, 0)')
  assert.equal(canvas.title.backgroundClip, 'text')
  assert.equal(canvas.title.backgroundImage, 'linear-gradient(90deg in oklab, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)')
  assert.equal(canvas.title.text, 'Welcome')
  assert.equal(canvas.caption.color, 'rgb(100, 116, 139)')
  assert.equal(canvas.caption.backgroundImage, 'none')
  assert.equal(canvas.panel.backgroundColor, 'rgb(0, 0, 255)')
  assert.equal(canvas.panel.backgroundImage, 'linear-gradient(rgba(255, 0, 0, 0.5), rgba(255, 0, 0, 0.5))')
  assert.equal(canvas.photo.backgroundColor, 'rgba(0, 0, 0, 0)')
  assert.equal(canvas.hero.backgroundColor, 'rgba(0, 0, 0, 0)')
  assert.equal(canvas.photo.backgroundImage, `url("data:image/png;base64,${swatchPng}")`)
  assert.equal(canvas.photo.backgroundSize, '100% 100%')
  assert.equal(canvas.photo.backgroundRepeat, 'no-repeat')
  await send({ type: 'set-selection', nodeIds: ['input-1'], color: '#009ff0' })
  const selected = await waitFor(observe, value => value.count === 1)
  assert.equal(selected.outlineColor, 'rgb(0, 159, 240)')
  assert.equal(selected.outlineWidth, '2px')
  assert.equal(selected.pointerEvents, 'auto')
  await send({ type: 'set-selection', nodeIds: ['unknown'], color: '#ff0000' })
  await send({ type: 'set-selection', nodeIds: ['card-1'], color: '#ff0000', generation: generation - 1 })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal((await observe()).outlineColor, 'rgb(0, 159, 240)')
  await send({ type: 'set-interaction-mode', mode: 'interact' })
  await frame.executeJavaScript(`(() => {
    window.previousInput = document.querySelector('#native-email')
    window.previousInput.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })()`)
  await waitFor(() => frame.executeJavaScript("document.querySelector('#native-email') !== window.previousInput && document.querySelector('#native-email').getAttribute('data-preview-selected') === 'true'"), value => value)
  assert.equal(await frame.executeJavaScript("window.previousInput.hasAttribute('data-preview-selected')"), false)
  await frame.executeJavaScript(`(() => {
    const foreign = document.querySelector('#native-email').cloneNode()
    foreign.id = 'foreign-binding'
    foreign.setAttribute('data-preview-component', 'wrong-source')
    foreign.removeAttribute('data-preview-selected')
    document.body.append(foreign)
  })()`)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(await frame.executeJavaScript("document.querySelector('#foreign-binding').hasAttribute('data-preview-selected')"), false)
  window.show()
  window.focus()
  window.webContents.focus()
  window.webContents.debugger.attach('1.3')
  debuggerAttached = true
  await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false })
  const { targetInfos } = await window.webContents.debugger.sendCommand('Target.getTargets')
  const previewTargets = targetInfos.filter(target => target.type === 'iframe' && target.url === previewUrl)
  assert.ok(previewTargets.length <= 1, 'The preview must have one unambiguous debugging target')
  let sessionId
  if (previewTargets.length === 1) {
    const attached = await window.webContents.debugger.sendCommand('Target.attachToTarget', { targetId: previewTargets[0].targetId, flatten: true })
    sessionId = attached.sessionId
    const location = await window.webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)
    assert.equal(location.result.value, previewUrl)
  }
  const inputBounds = await frame.executeJavaScript(`(() => {
    const input = document.querySelector('#native-email')
    input.addEventListener('input', event => { window.nativeInputWasTrusted = event.isTrusted }, { once: true })
    document.addEventListener('pointerdown', event => { window.nativePointer = { target: event.target.id, x: event.clientX, y: event.clientY, trusted: event.isTrusted } }, { once: true })
    const bounds = input.getBoundingClientRect()
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  })()`)
  const frameOffset = await window.webContents.executeJavaScript(`(() => {
    const iframe = document.querySelector('iframe')
    const bounds = iframe.getBoundingClientRect()
    return { x: bounds.x, y: bounds.y, scale: bounds.width / iframe.clientWidth }
  })()`)
  const point = { x: inputBounds.x * frameOffset.scale + frameOffset.x, y: inputBounds.y * frameOffset.scale + frameOffset.y, button: 'left', clickCount: 1 }
  assert.equal(await window.webContents.executeJavaScript(`document.elementFromPoint(${point.x},${point.y})?.tagName`), 'IFRAME')
  assert.equal(await frame.executeJavaScript(`document.elementFromPoint(${inputBounds.x},${inputBounds.y})?.id`), 'native-email')
  await window.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point })
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point })
  await new Promise(resolve => setTimeout(resolve, 40))
  const nativeFocus = await frame.executeJavaScript("({ active: document.activeElement?.id, pointer: window.nativePointer })")
  assert.equal(nativeFocus.active, 'native-email', JSON.stringify({ nativeFocus, point, sessionId, previewTargets }))
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ', text: 'q', unmodifiedText: 'q', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81 })
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81 })
  await waitFor(observe, value => value.value === 'q')
  assert.equal(await frame.executeJavaScript('window.nativeInputWasTrusted'), true)
  document.revision = 2
  document.frame.width = 640
  await send({ type: 'set-document', document, theme: { attribute: 'dark', colorScheme: 'dark' } })
  const resized = await waitFor(observe, value => value.width > selected.width)
  assert.equal(resized.width, selected.width + 160)
  assert.equal(resized.count, 1)
  assert.equal(resized.outlineColor, 'rgb(0, 159, 240)')
  assert.equal(await frame.executeJavaScript('document.documentElement.dataset.theme'), 'dark')

  // Primitive appearance pixels: the top fill composites over the bottom fill, reordering changes pixels, and the
  // image layer is the asset from the trusted map.
  const sample = async (id, fx, fy) => {
    const rect = await frame.executeJavaScript(`(() => { const r = document.querySelector('[data-preview-canvas="${id}"]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    const x = Math.round((rect.x + rect.width * fx) * frameOffset.scale + frameOffset.x)
    const y = Math.round((rect.y + rect.height * fy) * frameOffset.scale + frameOffset.y)
    const image = await window.webContents.capturePage({ x: x - 1, y: y - 1, width: 3, height: 3 })
    const { width, height } = image.getSize()
    const bitmap = image.toBitmap()
    const index = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
    return [bitmap[index + 2], bitmap[index + 1], bitmap[index]]
  }
  const blended = await waitFor(() => sample('panel', 0.5, 0.5), value => close(value, [128, 0, 127]))
  assert.ok(close(blended, [128, 0, 127]), JSON.stringify(blended))
  assert.ok(close(await sample('photo', 0.1, 0.5), [255, 0, 0]))
  assert.ok(close(await sample('photo', 0.9, 0.5), [0, 255, 0]))
  const reordered = structuredClone(document)
  reordered.canvas.elements.find(element => element.id === 'panel').appearance.fills.reverse()
  await send({ type: 'set-document', document: reordered })
  assert.ok(close(await waitFor(() => sample('panel', 0.5, 0.5), value => close(value, [0, 0, 255])), [0, 0, 255]))
  const reorderedPanel = (await observeCanvas()).panel
  assert.equal(reorderedPanel.backgroundColor, 'rgba(255, 0, 0, 0.5)')
  assert.equal(reorderedPanel.backgroundImage, 'linear-gradient(rgb(0, 0, 255), rgb(0, 0, 255))')
  await send({ type: 'set-document', document })
  await waitFor(() => sample('panel', 0.5, 0.5), value => close(value, [128, 0, 127]))

  // Component appearance is an inline layer on the existing root: no wrapper, same element, prior inline styles restored.
  const observeButton = () => frame.executeJavaScript(`(() => {
    const button = document.querySelector('button[data-preview-instance="button-1"][data-preview-component="atom-button"]')
    if (!button) return null
    const style = getComputedStyle(button)
    const side = name => style['border' + name + 'Width'] + ' ' + style['border' + name + 'Style'] + ' ' + style['border' + name + 'Color']
    return { attribute: button.getAttribute('style'), same: window.appearanceButton === button, host: button.parentElement?.hasAttribute('data-preview-host') ?? false, count: document.querySelectorAll('[data-preview-instance="button-1"]').length, backgroundImage: style.backgroundImage, backgroundColor: style.backgroundColor, top: side('Top'), right: side('Right'), bottom: side('Bottom'), left: side('Left'), outline: style.outlineWidth + ' ' + style.outlineStyle + ' ' + style.outlineColor, outlineOffset: style.outlineOffset, opacity: style.opacity, mixBlendMode: style.mixBlendMode, visibility: style.visibility, width: button.getBoundingClientRect().width, text: button.textContent }
  })()`)
  const original = await waitFor(observeButton, value => value !== null)
  await frame.executeJavaScript(`window.appearanceButton = document.querySelector('button[data-preview-instance="button-1"]')`)
  assert.equal(original.backgroundColor, 'rgb(18, 52, 86)')
  assert.equal(original.top, '3px solid rgb(1, 2, 3)')
  assert.equal(original.left, '3px solid rgb(1, 2, 3)')
  assert.equal(original.opacity, '1')
  assert.match(original.attribute, /background/)
  document.nodes['button-1'].appearance = { opacity: 0.5, blendMode: 'multiply', fills: [{ type: 'solid', color: '#ff00ff' }, { type: 'solid', color: '#00ff0080' }], outline: { color: '#0000ff', width: 2, style: 'dotted', offset: 4 }, borders: { left: { color: '#00ff00', width: 5, style: 'dashed' } } }
  await send({ type: 'set-document', document })
  const overridden = await waitFor(observeButton, value => value?.opacity === '0.5')
  assert.equal(overridden.same, true)
  assert.equal(overridden.host, true)
  assert.equal(overridden.count, 1)
  assert.equal(overridden.text, 'Go')
  assert.equal(overridden.backgroundColor, 'rgb(255, 0, 255)')
  assert.equal(overridden.backgroundImage, 'linear-gradient(rgba(0, 255, 0, 0.5), rgba(0, 255, 0, 0.5))')
  assert.equal(overridden.left, '5px dashed rgb(0, 255, 0)')
  for (const side of ['top', 'right', 'bottom']) assert.match(overridden[side], /^0px none /)
  assert.equal(overridden.outline, '2px dotted rgb(0, 0, 255)')
  assert.equal(overridden.outlineOffset, '4px')
  assert.equal(overridden.mixBlendMode, 'multiply')
  // Layout and appearance are separate layers: a layout update keeps the override.
  await send({ type: 'set-layout', layoutGeneration: 0, items: [{ nodeId: 'button-1', mode: 'flow', x: 0, y: 0, order: 1, width: 200 }] })
  const laidOut = await waitFor(observeButton, value => value?.width === 200)
  assert.equal(laidOut.backgroundImage, overridden.backgroundImage)
  assert.equal(laidOut.left, overridden.left)
  // Removing the override while layout is active restores each controlled property.
  delete document.nodes['button-1'].appearance
  await send({ type: 'set-document', document })
  const partly = await waitFor(observeButton, value => value?.opacity === '1')
  assert.equal(partly.backgroundColor, 'rgb(18, 52, 86)')
  assert.equal(partly.backgroundImage, 'none')
  assert.equal(partly.top, '3px solid rgb(1, 2, 3)')
  assert.equal(partly.left, '3px solid rgb(1, 2, 3)')
  assert.equal(partly.outline.split(' ')[1], 'none')
  assert.equal(partly.mixBlendMode, 'normal')
  assert.equal(partly.width, 200)
  await send({ type: 'set-layout', items: [], layoutGeneration: 0 })
  const unlaid = await waitFor(observeButton, value => value?.width !== 200)
  assert.equal(unlaid.attribute, original.attribute)
  // Visibility override and its removal restore the inline style byte for byte.
  document.nodes['button-1'].appearance = { visible: false, opacity: 0.25, fills: [{ type: 'image', assetId: 'swatch', fit: 'cover' }] }
  await send({ type: 'set-document', document })
  const hidden = await waitFor(observeButton, value => value?.visibility === 'hidden')
  assert.equal(hidden.opacity, '0.25')
  assert.equal(hidden.backgroundImage, `url("data:image/png;base64,${swatchPng}")`)
  assert.equal(hidden.backgroundColor, 'rgba(0, 0, 0, 0)')
  delete document.nodes['button-1'].appearance
  await send({ type: 'set-document', document })
  const restored = await waitFor(observeButton, value => value?.visibility === 'visible')
  assert.equal(restored.attribute, original.attribute)
  assert.equal(restored.same, true)
  // When the component rewrites a controlled property, the override is reapplied and the new value is what restores.
  document.nodes['button-1'].appearance = { fills: [{ type: 'solid', color: '#ff00ff' }] }
  await send({ type: 'set-document', document })
  await waitFor(observeButton, value => value?.backgroundColor === 'rgb(255, 0, 255)')
  await frame.executeJavaScript(`window.appearanceButton.style.background = 'rgb(9, 9, 9)'`)
  const reapplied = await waitFor(observeButton, value => value?.backgroundColor === 'rgb(255, 0, 255)')
  assert.equal(reapplied.backgroundImage, 'none')
  delete document.nodes['button-1'].appearance
  await send({ type: 'set-document', document })
  const drifted = await waitFor(observeButton, value => value?.backgroundColor === 'rgb(9, 9, 9)')
  assert.equal(drifted.backgroundImage, 'none')
  assert.equal(drifted.top, '3px solid rgb(1, 2, 3)')

  const hostile = structuredClone(document)
  hostile.revision = 3
  hostile.canvas.elements[0].appearance = { fills: [{ type: 'solid', color: 'url(https://attacker.example/x.png)' }] }
  await send({ type: 'set-document', document: hostile })
  const missingAsset = structuredClone(document)
  missingAsset.canvas.elements[0].appearance = { fills: [{ type: 'image', assetId: 'not-in-map', fit: 'cover' }] }
  await send({ type: 'set-document', document: missingAsset })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal((await observeCanvas()).hero.backgroundImage, 'linear-gradient(135deg, rgb(155, 77, 255) 0%, rgb(0, 0, 0) 100%)')
  document.revision = 3
  document.nodes['card-1'].children.children = []
  delete document.nodes['input-1']
  await send({ type: 'set-document', document })
  await waitFor(observe, value => value.tag === undefined)
  assert.equal((await observe()).count, 0)
  await send({ type: 'dispose' })
  await waitFor(() => frame.executeJavaScript("document.querySelectorAll('[data-preview-selection-style]').length"), value => value === 0)
  writeFileSync(join(userData, 'selection-result.json'), JSON.stringify({ ok: true, originalMode: true, nativeInput: true, exactColor: true, staleRejection: true, replacement: true, foreignBinding: true, resize: true, canvasFill: true, appearancePixels: true, componentAppearance: true, componentRestore: true, componentDrift: true, hostileFill: true, deletion: true, disposal: true }))
} catch (error) {
  writeFileSync(join(userData, 'selection-error.txt'), String(error?.stack ?? error))
  process.exitCode = 1
} finally {
  if (debuggerAttached && window && !window.isDestroyed()) window.webContents.debugger.detach()
  window?.destroy()
  app.exit(process.exitCode ?? 0)
}
})
