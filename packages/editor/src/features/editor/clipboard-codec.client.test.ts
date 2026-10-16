// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { clipboardTargetIsEditable, decodeInternalClipboardHtml, decodePaperTemporaryTreeHtml, encodeInternalClipboardPayload, prepareClipboardCandidate, resolveClipboardCandidate, sanitizeClipboardSvg, validateInternalClipboardPayload } from './clipboard-codec'
import type { ClipboardDataSource, InternalClipboardPayload } from './clipboard-codec'

const payload = (): InternalClipboardPayload => ({
  version: 1,
  source: { fileId: 'source-file', pageId: 'source-page', fileRevision: 7 },
  roots: ['frame'],
  nodes: {
    frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 120, height: 80 }, layout: { item: { position: { mode: 'freeform' } }, container: { display: 'freeform' } } },
    label: { id: 'label', type: 'rectangle', name: 'Label', styles: { relativeTransform: [1, 0, 0, 1, 8, 9], width: 60, height: 20 } },
  },
  relationships: { label: { parentId: 'frame', orderKey: 'a' } },
  tokens: {},
  componentModel: { definitions: {}, instances: {} },
})

const canvasPayload = (): InternalClipboardPayload => ({
  version: 1,
  source: { fileId: 'component-file', pageId: 'page', fileRevision: 4 },
  roots: ['master'],
  nodes: {
    master: { id: 'master', type: 'frame', name: 'Button', styles: { relativeTransform: [1, 0, 0, 1, 40, 40], width: 100, height: 40, overflow: 'visible' }, appearance: {} },
    face: { id: 'face', type: 'rectangle', name: 'Face', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 40 }, appearance: {} },
  },
  relationships: { face: { parentId: 'master', orderKey: 'A' } },
  tokens: {},
  componentModel: { definitions: { button: {
    id: 'button', name: 'Button', source: { kind: 'canvas', masterRootId: 'master' }, revision: 2,
    properties: [{ id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }], binding: { kind: 'variant', nodeId: 'face', appearances: { default: {}, hover: { opacity: 0.7 } } } }],
    materials: [], parts: [{ id: 'face-part', name: 'Face', nodeId: 'face' }], interactions: [],
    variantAppearances: { face: { 'state=default': {}, 'state=hover': { opacity: 0.7 } } },
  } }, instances: {} },
})

const source = (representations: Record<string, string>, files: File[] = []): ClipboardDataSource => ({
  types: [...Object.keys(representations), ...(files.length ? ['Files'] : [])],
  files,
  getData: type => representations[type] ?? '',
})

describe('PAPER-CLIP-003 internal clipboard payload', () => {
  it('round trips an exact versioned payload with useful fallback text', () => {
    const encoded = encodeInternalClipboardPayload(payload(), 'Frame “Hello”')
    expect(encoded.text).toBe('Frame “Hello”')
    expect(encoded.html).toContain('<!--design-editor-clipboard:v1:')
    const decoded = decodeInternalClipboardHtml(encoded.html)
    expect(decoded).toStrictEqual(payload())
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded?.nodes.frame)).toBe(true)
  })

  it.each([
    ['unknown payload field', (value: any) => { value.extra = true }],
    ['unknown source field', (value: any) => { value.source.extra = true }],
    ['unknown version', (value: any) => { value.version = 2 }],
    ['root with a stored parent', (value: any) => { value.relationships.frame = { parentId: 'outside', orderKey: 'a' } }],
    ['orphaned child', (value: any) => { delete value.relationships.label }],
    ['external parent', (value: any) => { value.relationships.label.parentId = 'outside' }],
    ['malformed geometry', (value: any) => { value.nodes.frame.styles.width = -1 }],
    ['missing token closure', (value: any) => { value.nodes.frame.appearance = { fills: [{ id: 'fill', type: 'solid', color: { kind: 'token', tokenId: 'missing' } }] } }],
    ['missing asset closure', (value: any) => { value.nodes.frame.appearance = { fills: [{ id: 'fill', type: 'image', assetId: 'missing', fit: 'cover' }] } }],
    ['private asset field', (value: any) => { value.nodes.frame.appearance = { fills: [{ id: 'fill', type: 'image', assetId: 'photo', fit: 'cover' }] }; value.assets = { photo: { id: 'photo', name: 'Photo', mime: 'image/png', extension: 'png', bytes: 4, width: 1, height: 1, sha256: 'a'.repeat(64), objectKey: 'secret' } } }],
    ['aggregate image bytes over the limit', (value: any) => {
      value.nodes.frame.appearance = { fills: ['one', 'two', 'three'].map((assetId: string) => ({ id: `fill-${assetId}`, type: 'image', assetId, fit: 'cover' })) }
      value.assets = Object.fromEntries(['one', 'two', 'three'].map((id: string) => [id, { id, name: id, mime: 'image/png', extension: 'png', bytes: 25 * 1024 * 1024, width: 1, height: 1, sha256: 'a'.repeat(64) }]))
    }],
  ])('rejects %s', (_label, mutate) => {
    const value = structuredClone(payload()) as any
    mutate(value)
    expect(() => validateInternalClipboardPayload(value)).toThrow()
  })

  it('rejects forbidden keys and duplicate internal markers', () => {
    const value = structuredClone(payload()) as any
    Object.defineProperty(value.nodes, '__proto__', { enumerable: true, configurable: true, value: { id: 'bad' } })
    expect(() => validateInternalClipboardPayload(value)).toThrow('forbidden key')
    const encoded = encodeInternalClipboardPayload(payload(), 'Frame')
    expect(() => decodeInternalClipboardHtml(`${encoded.html}${encoded.html}`)).toThrow('multiple internal payloads')
  })

  it('rejects cyclic caller data before serialization', () => {
    const value = structuredClone(payload()) as any
    value.nodes.frame.cycle = value
    expect(() => validateInternalClipboardPayload(value)).toThrow('cannot contain cycles')
  })

  it('[COMP-V2-UI-078] round trips a strict canvas-component closure and rejects semantic graph mutations', () => {
    const encoded = encodeInternalClipboardPayload(canvasPayload(), 'Button')
    expect(decodeInternalClipboardHtml(encoded.html)).toEqual(canvasPayload())
    const mutations = [
      (value: any) => { value.componentModel.definitions.button.properties[0].binding.nodeId = 'missing' },
      (value: any) => { delete value.componentModel.definitions.button.variantAppearances.face['state=hover'] },
      (value: any) => { value.componentModel.definitions.extra = { id: 'extra', name: 'Extra', source: { kind: 'canvas', masterRootId: 'elsewhere' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] } },
      (value: any) => { value.source.fileRevision = -1 },
      (value: any) => { value.source.pageId = '' },
    ]
    for (const mutate of mutations) {
      const value = structuredClone(canvasPayload()) as any
      mutate(value)
      expect(() => validateInternalClipboardPayload(value)).toThrow()
    }
  })
})

describe('PAPER-CLIP-001 MIME precedence', () => {
  it('chooses sanitized SVG before image files', () => {
    const image = new File(['image'], 'photo.png', { type: 'image/png' })
    const candidate = resolveClipboardCandidate(source({ 'text/plain': '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>' }, [image]))
    expect(candidate).toMatchObject({ kind: 'svg', name: 'pasted.svg' })
  })

  it('chooses images before an internal HTML payload', () => {
    const encoded = encodeInternalClipboardPayload(payload(), 'Frame')
    const image = new File(['image'], 'photo.png', { type: 'image/png' })
    expect(resolveClipboardCandidate(source({ 'text/html': encoded.html, 'text/plain': encoded.text }, [image])).kind).toBe('image-files')
  })

  it('recognizes validated Paper trees, Paper HTML, and Figma HTML after the internal format', () => {
    const tree = { id: 'copy', fileId: 'paper-file', topLevelNodeIds: ['root'], nodes: { root: { id: 'root' }, child: { id: 'child' } }, images: {}, parentToChildrenIndex: { root: ['child'] }, oldIdToNewIdMap: { old: 'root' }, positions: { root: [10, 20] } }
    const paperTree = `<meta charset="utf-8"><!--<paper-paste-start data-embed="${JSON.stringify(tree)}"></paper-paste-start>-->`
    expect(resolveClipboardCandidate(source({ 'text/html': paperTree, 'text/plain': 'Paper nodes' }))).toMatchObject({ kind: 'paper-tree', fallbackText: 'Paper nodes' })
    expect(decodePaperTemporaryTreeHtml(paperTree)).toStrictEqual(tree)
    expect(resolveClipboardCandidate(source({ 'text/html': '<x-paper-html><div>Paper</div></x-paper-html>' }))).toStrictEqual({ kind: 'foreign-html', source: 'paper', html: '<div>Paper</div>' })
    expect(resolveClipboardCandidate(source({ 'text/html': '<meta charset="utf-8"><!--(figma)<div>Figma</div>' }))).toMatchObject({ kind: 'foreign-html', source: 'figma' })

    const encoded = encodeInternalClipboardPayload(payload(), 'Frame')
    expect(resolveClipboardCandidate(source({ 'text/html': `${encoded.html}${paperTree}`, 'text/plain': 'Frame' })).kind).toBe('internal')
  })

  it('rejects malformed Paper tree relationships instead of admitting a foreign graph', () => {
    const tree = { id: 'copy', fileId: 'paper-file', topLevelNodeIds: ['root'], nodes: { root: { id: 'root' }, child: { id: 'child' } }, images: {}, parentToChildrenIndex: {}, oldIdToNewIdMap: {}, positions: { root: [10, 20] } }
    const html = `<!--<paper-paste-start data-embed="${JSON.stringify(tree)}"></paper-paste-start>-->`
    expect(resolveClipboardCandidate(source({ 'text/html': html }))).toMatchObject({ kind: 'unsupported', diagnostic: 'Paper clipboard tree has an orphan' })
  })

  it('decodes internal HTML, admits supported plain HTML, and flattens ordinary rich HTML', () => {
    const encoded = encodeInternalClipboardPayload(payload(), 'Frame')
    expect(resolveClipboardCandidate(source({ 'text/html': encoded.html, 'text/plain': encoded.text }))).toMatchObject({ kind: 'internal', fallbackText: 'Frame' })
    expect(resolveClipboardCandidate(source({ 'text/plain': '<p>Hello <strong>there</strong></p>' }))).toStrictEqual({ kind: 'html', source: '<p>Hello <strong>there</strong></p>' })
    expect(resolveClipboardCandidate(source({ 'text/html': '<table><tr><td>Hello</td></tr></table>', 'text/plain': 'Hello' }))).toStrictEqual({ kind: 'text', text: 'Hello' })
  })

  it('fails closed when a representation is too large or cannot be read', () => {
    expect(resolveClipboardCandidate(source({ 'text/plain': 'x'.repeat(1_000_001) }))).toMatchObject({ kind: 'unsupported', diagnostic: 'Clipboard text exceeds the byte limit' })
    expect(resolveClipboardCandidate({ types: ['text/plain'], files: [], getData: () => { throw new Error('denied') } })).toStrictEqual({ kind: 'unsupported', diagnostic: 'Clipboard data could not be read' })
  })
})

describe('PAPER-CLIP-002 raster preparation', () => {
  it('rasterizes a sanitized SVG through the same verified image candidate path', async () => {
    const candidate = resolveClipboardCandidate(source({ 'text/plain': '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="20" /></svg>' }))
    const raster = new File(['raster'], 'pasted.webp', { type: 'image/webp' })
    const prepared = await prepareClipboardCandidate(candidate, {
      prepare: async file => { expect(file.type).toBe('image/svg+xml'); return raster },
      decode: async file => { expect(file).toBe(raster); return { width: 10, height: 20, close() {} } },
    })
    expect(prepared).toStrictEqual({ kind: 'images', files: [{ file: raster, width: 10, height: 20 }], failures: [] })
  })

  it('normalizes images concurrently, preserves successful order, and reports partial failures', async () => {
    const good = new File(['good'], 'good.png', { type: 'image/png' })
    const bad = new File(['bad'], 'bad.png', { type: 'image/png' })
    const next = new File(['next'], 'next.png', { type: 'image/png' })
    const close = vi.fn()
    const candidate = resolveClipboardCandidate(source({}, [good, bad, next]))
    const prepared = await prepareClipboardCandidate(candidate, {
      prepare: async file => { if (file === bad) throw new Error('Decode failed'); return file },
      decode: async file => ({ width: file === next ? 20 : 10, height: 10, close }),
    })
    expect(prepared).toMatchObject({ kind: 'images', files: [{ file: good, width: 10, height: 10 }, { file: next, width: 20, height: 10 }], failures: [{ name: 'bad.png', diagnostic: 'Decode failed' }] })
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('fails closed when every image fails or decoded dimensions exceed the model limit', async () => {
    const image = new File(['image'], 'huge.png', { type: 'image/png' })
    const candidate = resolveClipboardCandidate(source({}, [image]))
    const failed = await prepareClipboardCandidate(candidate, { prepare: async () => { throw new Error('No decoder') }, decode: vi.fn() })
    expect(failed).toStrictEqual({ kind: 'unsupported', diagnostic: 'No decoder' })

    const close = vi.fn()
    const oversized = await prepareClipboardCandidate(candidate, { prepare: async file => file, decode: async () => ({ width: 16_384, height: 16_384, close }) })
    expect(oversized).toStrictEqual({ kind: 'unsupported', diagnostic: 'Image dimensions exceed the import limit' })
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('PAPER-CLIP-002 SVG security', () => {
  it('remaps local ids and strips metadata', () => {
    const result = sanitizeClipboardSvg('<svg xmlns="http://www.w3.org/2000/svg"><metadata>private</metadata><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff" /></linearGradient></defs><rect id="shape" width="10" height="10" fill="url(#paint)" /></svg>', 'clip')
    expect(result).not.toContain('metadata')
    expect(result).toContain('id="clip-1"')
    expect(result).toContain('id="clip-2"')
    expect(result).toContain('fill="url(#clip-1)"')
  })

  it.each([
    ['script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['event handler', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['external href', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png" /></svg>'],
    ['external paint', '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.com/a.svg#x)" /></svg>'],
  ])('rejects %s', (_label, svg) => expect(() => sanitizeClipboardSvg(svg)).toThrow())
})

describe('PAPER-CLIP-003 editable target bypass', () => {
  it('recognizes native and contenteditable editors without claiming ordinary canvas targets', () => {
    const input = document.createElement('input')
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    const nested = document.createElement('span')
    editable.append(nested)
    expect(clipboardTargetIsEditable(input)).toBe(true)
    expect(clipboardTargetIsEditable(nested)).toBe(true)
    expect(clipboardTargetIsEditable(document.createElement('div'))).toBe(false)
  })
})
