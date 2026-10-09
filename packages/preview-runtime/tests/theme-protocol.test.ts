import { describe, expect, it } from 'vitest'
import { acceptPreviewCommand, acceptPreviewEvent, isPreviewDocument, isPreviewNodeTheme, type PreviewDocument, type PreviewNodeTheme } from '../src/protocol.js'

// CC-NT-015: protocol v3 theme negative controls through the real command and event boundaries. Every rejection
// starts from a value the same boundary accepts, so a rejection can only come from the single mutation under test.

const editorOrigin = 'http://127.0.0.1:4319'
const previewOrigin = 'http://127.0.0.1:4400'
const parent = {} as Window
const envelope = { channel: 'design-editor-preview', version: 3, generation: 7 } as const
const deliver = (data: unknown) => acceptPreviewCommand({ origin: editorOrigin, source: parent, data }, editorOrigin, parent, 7)
const receive = (data: unknown) => acceptPreviewEvent({ origin: previewOrigin, source: parent, data }, previewOrigin, parent, 7)

const darkTheme = () => ({ mode: 'dark', designThemeId: 'dark', attribute: 'dark', colorScheme: 'dark', explicit: true }) as Record<string, unknown>
const document = (cardTheme: unknown = darkTheme()): PreviewDocument => ({
  version: 1, revision: 1, rootIds: ['card-1'],
  nodes: {
    'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', props: {}, children: { children: ['button-1'] }, theme: cardTheme as PreviewNodeTheme },
    'button-1': { id: 'button-1', componentId: 'atom-button', exportName: 'Button', props: { children: 'Go' }, children: {}, theme: { mode: 'dark', designThemeId: 'dark', attribute: 'dark', colorScheme: 'dark', explicit: false } },
  },
  frame: { width: 480, height: 640, direction: 'column', gap: 16, padding: 24, clip: false },
})
const setDocument = (doc: unknown) => ({ ...envelope, type: 'set-document', document: doc })
const bounds = { x: 10, y: 20, width: 120, height: 40 }
const geometry = (extra: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({ ...envelope, type: 'geometry', items: [{ instanceId: 'card-1', componentId: 'atom-card', bounds, ...item }], root: null, ...extra })

describe('CC-NT-015 node theme on set-document', () => {
  it('accepts an explicit dark node, an inherited node, the light fallback and the 40 character bounds', () => {
    expect(deliver(setDocument(document()))).toEqual(setDocument(document()))
    expect(deliver(setDocument(document({ mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false })))).not.toBeNull()
    expect(deliver(setDocument(document({ ...darkTheme(), designThemeId: 'd'.repeat(40), attribute: 'a'.repeat(40) })))).not.toBeNull()
    expect(deliver(setDocument(document({ ...darkTheme(), designThemeId: 'Brand_dark-2', attribute: 'brand-dark_2' })))).not.toBeNull()
  })

  it('accepts a node without a theme (legacy source-binding baselines) but not an explicit undefined theme', () => {
    const doc = document()
    delete doc.nodes['card-1']!.theme
    expect(Object.hasOwn(doc.nodes['card-1']!, 'theme')).toBe(false)
    expect(deliver(setDocument(doc))).not.toBeNull()
    const explicitUndefined = document()
    Reflect.set(explicitUndefined.nodes['card-1']!, 'theme', undefined)
    expect(Object.hasOwn(explicitUndefined.nodes['card-1']!, 'theme')).toBe(true)
    expect(deliver(setDocument(explicitUndefined))).toBeNull()
  })

  it.each([
    ['an unknown key', { ...darkTheme(), source: 'tokens.css' }],
    ['a missing key', (({ explicit: _explicit, ...rest }) => rest)(darkTheme())],
    ['mode auto', { ...darkTheme(), mode: 'auto' }],
    ['mode system', { ...darkTheme(), mode: 'system' }],
    ['colorScheme auto', { ...darkTheme(), colorScheme: 'auto' }],
    ['colorScheme light dark', { ...darkTheme(), colorScheme: 'light dark' }],
    ['an attribute with spaces and punctuation', { ...darkTheme(), attribute: 'bad value!' }],
    ['an attribute selector injection', { ...darkTheme(), attribute: "dark'] body {" }],
    ['an empty attribute', { ...darkTheme(), attribute: '' }],
    ['a 41 character attribute', { ...darkTheme(), attribute: 'a'.repeat(41) }],
    ['a 41 character designThemeId', { ...darkTheme(), designThemeId: 'd'.repeat(41) }],
    ['an empty designThemeId', { ...darkTheme(), designThemeId: '' }],
    ['a designThemeId with a dot', { ...darkTheme(), designThemeId: 'dark.v2' }],
    ['a null designThemeId', { ...darkTheme(), designThemeId: null }],
    ['explicit yes', { ...darkTheme(), explicit: 'yes' }],
    ['explicit 1', { ...darkTheme(), explicit: 1 }],
    ['a theme string', 'dark'],
    ['a theme array', ['dark']],
    ['a null theme', null],
  ])('rejects a node theme with %s', (_, theme) => {
    expect(isPreviewNodeTheme(theme)).toBe(false)
    expect(isPreviewDocument(document(theme))).toBe(false)
    expect(deliver(setDocument(document(theme)))).toBeNull()
  })

  it('rejects a theme carrying a __proto__ own key from parsed JSON', () => {
    const polluted = JSON.parse(`{"__proto__":{"explicit":true},${JSON.stringify(darkTheme()).slice(1)}`)
    expect(Object.hasOwn(polluted, '__proto__')).toBe(true)
    expect(deliver(setDocument(document(polluted)))).toBeNull()
  })

  it('rejects one bad theme among good nodes', () => {
    const doc = document()
    doc.nodes['button-1']!.theme = { ...doc.nodes['button-1']!.theme!, mode: 'auto' as 'dark' }
    expect(deliver(setDocument(doc))).toBeNull()
  })
})

describe('CC-NT-015 theme reports on geometry events', () => {
  it.each([
    ['applied', 'applied'],
    ['unsupported-ambiguous-root', 'unsupported-ambiguous-root'],
    ['unsupported-no-root', 'unsupported-no-root'],
    ['conflicting-portal', 'conflicting-portal'],
  ])('accepts an item theme status of %s', (_, status) => {
    expect(receive(geometry({}, { theme: status }))).toEqual(geometry({}, { theme: status }))
  })

  it.each([
    ['an unknown status', 'stamped'],
    ['an upper case status', 'Applied'],
    ['a theme object', { mode: 'dark' }],
    ['null', null],
  ])('rejects an item theme status of %s', (_, status) => {
    expect(receive(geometry({}, { theme: status }))).toBeNull()
  })

  it('accepts unmeasured node statuses and an unowned portal count', () => {
    const data = geometry({ theme: { nodes: [{ instanceId: 'card-2', status: 'unsupported-ambiguous-root' }, { instanceId: 'card-3', status: 'conflicting-portal' }], unownedPortals: 2 } })
    expect(receive(data)).toEqual(data)
    expect(receive(geometry({ theme: { nodes: [], unownedPortals: 0 } }))).not.toBeNull()
  })

  it.each([
    ['an applied entry', { nodes: [{ instanceId: 'card-2', status: 'applied' }], unownedPortals: 0 }],
    ['an unknown status entry', { nodes: [{ instanceId: 'card-2', status: 'stamped' }], unownedPortals: 0 }],
    ['an entry with an extra key', { nodes: [{ instanceId: 'card-2', status: 'unsupported-no-root', attribute: 'dark' }], unownedPortals: 0 }],
    ['an entry with a selector id', { nodes: [{ instanceId: 'card-2"]', status: 'unsupported-no-root' }], unownedPortals: 0 }],
    ['an entry with a prototype id', { nodes: [{ instanceId: '__proto__', status: 'unsupported-no-root' }], unownedPortals: 0 }],
    ['a negative unowned count', { nodes: [], unownedPortals: -1 }],
    ['a fractional unowned count', { nodes: [], unownedPortals: 0.5 }],
    ['a string unowned count', { nodes: [], unownedPortals: '1' }],
    ['a missing unowned count', { nodes: [] }],
    ['a missing node list', { unownedPortals: 0 }],
    ['an extra report key', { nodes: [], unownedPortals: 0, claims: [] }],
    ['501 entries', { nodes: Array.from({ length: 501 }, (_, index) => ({ instanceId: `node-${index}`, status: 'unsupported-no-root' })), unownedPortals: 0 }],
  ])('rejects a theme report with %s', (_, theme) => {
    expect(receive(geometry({ theme }))).toBeNull()
  })

  it('accepts 500 report entries as the bound', () => {
    expect(receive(geometry({ theme: { nodes: Array.from({ length: 500 }, (_, index) => ({ instanceId: `node-${index}`, status: 'unsupported-no-root' })), unownedPortals: 0 } }))).not.toBeNull()
  })
})

describe('CC-NT-015 envelope version 3 in both directions', () => {
  const commands: [string, Record<string, unknown>][] = [
    ['set-document', setDocument(document())],
    ['set-theme', { ...envelope, type: 'set-theme', theme: { attribute: 'dark', colorScheme: 'dark' } }],
    ['ping', { ...envelope, type: 'ping' }],
  ]
  const events: [string, Record<string, unknown>][] = [
    ['geometry', geometry({ theme: { nodes: [], unownedPortals: 1 } }, { theme: 'applied' })],
    ['ready', { ...envelope, type: 'ready', componentId: 'fixture-login' }],
    ['diagnostic', { ...envelope, type: 'diagnostic', message: 'Preview failed' }],
  ]
  it.each(commands)('accepts a version 3 %s command and rejects versions 2, 4 and "3"', (_, data) => {
    expect(deliver(data)).toEqual(data)
    expect(deliver({ ...data, version: 2 })).toBeNull()
    expect(deliver({ ...data, version: 4 })).toBeNull()
    expect(deliver({ ...data, version: '3' })).toBeNull()
  })
  it.each(events)('accepts a version 3 %s event and rejects versions 2, 4 and "3"', (_, data) => {
    expect(receive(data)).toEqual(data)
    expect(receive({ ...data, version: 2 })).toBeNull()
    expect(receive({ ...data, version: 4 })).toBeNull()
    expect(receive({ ...data, version: '3' })).toBeNull()
  })
})
