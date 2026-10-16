import { describe, expect, it } from 'vitest'
import { legacyTextProperties } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { DesignTheme } from '@canvas/repo-engine/design-themes'
import { createDocumentStore } from './document-store'
import type { Atom } from './types'

// Per-node theme modes through the document store. Every expected value is a hand-written literal; the editor store is
// never created here, so the editor appearance cannot reach any resolution below.
const atom = (name: string, componentId: string, extra: Atom['props'] = []): Atom => ({ name, kind: 'atom', componentId, path: `src/${name}.tsx`, exportName: name, fingerprint: 'f', sourceHash: 'h', status: 'bound', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }, ...extra] })
const atoms: Atom[] = [atom('Card', 'card-component', [{ name: 'heading', type: 'ReactNode', optional: true }]), atom('Label', 'label-component')]
const hex = (value: string) => ({ kind: 'hex' as const, hex: value })

/**
 * root > card (Card, padded, token-bound fill) > label (Label). root > box (rectangle bound to `surface`), caption (text).
 * The `surface` token reads the stylesheet's --surface; nothing stores a theme mode yet.
 */
const fixture = (): FileDocument => ({
  schemaVersion: 13, componentModel: { definitions: {}, instances: {} }, fileId: 'file-1', revision: 4,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    card: { id: 'card', type: 'component', name: 'Login card', componentId: 'card-component', exportName: 'Card', props: { heading: 'Welcome' }, layout: { item: { position: { mode: 'flow' } }, spacing: { padding: { top: 8, right: 8, bottom: 8, left: 8 } } }, appearance: { fills: [{ id: 'card-fill', type: 'solid', color: { kind: 'token', tokenId: 'surface' } }], opacity: 0.9 } },
    label: { id: 'label', type: 'component', componentId: 'label-component', exportName: 'Label', props: { children: 'Email' } },
    box: { id: 'box', type: 'rectangle', name: 'Box', styles: { relativeTransform: [0.965925826289, 0.258819045103, -0.258819045103, 0.965925826289, 606.028235244824, 394.211007346656], width: 50, height: 40 }, appearance: { fills: [{ id: 'box-fill', type: 'solid', color: { kind: 'token', tokenId: 'surface' } }] } },
    caption: { id: 'caption', type: 'text', name: 'Caption', text: 'Hello', styles: { relativeTransform: [1, 0, 0, 1, 10, 10], width: 120, height: 20 }, appearance: { fills: [{ id: 'caption-fill', type: 'solid', color: { kind: 'literal', color: hex('#202124') } }] }, ...legacyTextProperties() },
  },
  relationships: {
    card: { parentId: 'root-1', orderKey: 'V' },
    label: { parentId: 'card', orderKey: 'V', slot: 'children' },
    box: { parentId: 'root-1', orderKey: 'W' },
    caption: { parentId: 'root-1', orderKey: 'X' },
  },
  theme: { tokens: {
    surface: { id: 'surface', type: 'color', name: 'surface', orderKey: 'V', value: { kind: 'source', property: '--surface', fallback: hex('#000000') } },
    ink: { id: 'ink', type: 'color', name: 'ink', orderKey: 'W', value: { kind: 'literal', color: hex('#202124') } },
  } },
})

const themes: DesignTheme[] = [
  { id: 'default', name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' },
  { id: 'dark', name: 'Dark', selector: "[data-theme='dark']", attribute: 'dark', colorScheme: 'dark' },
]
const palettes: Record<string, Record<string, ReturnType<typeof hex>>> = { default: { '--surface': hex('#ffffff') }, dark: { '--surface': hex('#242427') } }

/** A store whose only theme input is the file's canvas default theme id held in `view`. */
function loaded(view: { previewThemeId: string } = { previewThemeId: 'default' }) {
  const store = createDocumentStore(() => 'unused')
  store.configure({ themeContext: () => ({ themes, previewThemeId: view.previewThemeId, palette: theme => palettes[theme.id] ?? {} }) })
  store.load(fixture(), atoms)
  return store
}
type Store = ReturnType<typeof loaded>
const file = (store: Store) => store.getSnapshot().file!
const modeOf = (store: Store, id: string) => (file(store).nodes[id] as { themeMode?: string }).themeMode
/** The file as JSON with every stored theme mode and the revision removed, key order preserved. */
const withoutThemeModes = (document: FileDocument) => {
  const copy = structuredClone(document) as FileDocument & { nodes: Record<string, { themeMode?: string }> }
  for (const node of Object.values(copy.nodes)) delete node.themeMode
  return JSON.stringify({ ...copy, revision: 0 })
}

describe('CC-NT-006: a theme mode changes nothing else', () => {
  it('tokens, appearance, props, layout and relationships stay byte-equal after setting dark', () => {
    const store = loaded()
    const before = file(store)
    expect(store.commands.nodeTheme.set(['card'], 'dark')).toBe(true)
    const after = file(store)
    expect(modeOf(store, 'card')).toBe('dark')
    expect(after.revision).toBe(5)
    expect(withoutThemeModes(after)).toBe(withoutThemeModes(before))
    expect(JSON.stringify(after.theme)).toBe(JSON.stringify(fixture().theme))
    expect(JSON.stringify(after.relationships)).toBe(JSON.stringify(fixture().relationships))
    // Only the target gained the field.
    expect(Object.entries(after.nodes).filter(([, node]) => 'themeMode' in node).map(([id]) => id)).toEqual(['card'])
  })

  it('negative control: the comparison notices an unrelated change', () => {
    const store = loaded()
    const before = file(store)
    store.commands.nodeTheme.set(['card'], 'dark')
    store.commands.appearance.setBlending(['card'], { opacity: 0.5 })
    expect(withoutThemeModes(file(store))).not.toBe(withoutThemeModes(before))
  })
})

describe('CC-NT-007: one call, one revision, one undo step', () => {
  it('three nodes of different kinds change together; one undo restores all, redo reapplies', () => {
    const store = loaded()
    expect(store.commands.nodeTheme.set(['card', 'box', 'caption'], 'dark')).toBe(true)
    expect(file(store).revision).toBe(5)
    expect(['card', 'box', 'caption'].map(id => modeOf(store, id))).toEqual(['dark', 'dark', 'dark'])
    expect(modeOf(store, 'label')).toBeUndefined()
    // History entries restore content; the revision number belongs to persistence, so content is compared without it.
    const content = (document: FileDocument) => JSON.stringify({ ...document, revision: 0 })
    const applied = content(file(store))

    expect(store.undo()).toBe(true)
    expect(['card', 'box', 'caption'].map(id => modeOf(store, id))).toEqual([undefined, undefined, undefined])
    expect(content(file(store))).toBe(content(fixture()))
    expect(store.getSnapshot().canUndo).toBe(false)

    expect(store.redo()).toBe(true)
    expect(['card', 'box', 'caption'].map(id => modeOf(store, id))).toEqual(['dark', 'dark', 'dark'])
    expect(content(file(store))).toBe(applied)
    expect(store.getSnapshot().canRedo).toBe(false)
  })

  it('nodes already in the mode are skipped inside the same single step', () => {
    const store = loaded()
    store.commands.nodeTheme.set(['card'], 'light')
    expect(store.commands.nodeTheme.set(['card', 'box'], 'light')).toBe(true)
    expect(file(store).revision).toBe(6)
    store.undo()
    expect([modeOf(store, 'card'), modeOf(store, 'box')]).toEqual(['light', undefined])
  })

  it('a no-op returns false and writes no revision or history', () => {
    const store = loaded()
    expect(store.commands.nodeTheme.set(['card', 'box'], 'inherit')).toBe(false)
    expect(file(store).revision).toBe(4)
    expect(store.getSnapshot().canUndo).toBe(false)
    store.commands.nodeTheme.set(['box'], 'dark')
    expect(store.commands.nodeTheme.set(['box', 'box'], 'dark')).toBe(false)
    expect(file(store).revision).toBe(5)
    expect(store.commands.nodeTheme.set(['root-1', 'missing'], 'dark')).toBe(false)
    expect(file(store).revision).toBe(5)
  })
})

describe('CC-NT-008: effective theme follows the canvas default, never the editor chrome', () => {
  it('flipping only the canvas default theme flips an inheriting node and leaves the document alone', () => {
    const view = { previewThemeId: 'default' }
    const store = loaded(view)
    expect(store.nodeTheme('label')).toEqual({
      theme: { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false },
      palette: { '--surface': hex('#ffffff') },
      diagnostic: null,
      effective: { mode: 'light', source: { kind: 'fallback' } },
    })
    const document = JSON.stringify(file(store))

    view.previewThemeId = 'dark'
    expect(store.nodeTheme('label')).toEqual({
      theme: { mode: 'dark', designThemeId: 'dark', attribute: 'dark', colorScheme: 'dark', explicit: false },
      palette: { '--surface': hex('#242427') },
      diagnostic: null,
      effective: { mode: 'dark', source: { kind: 'fallback' } },
    })
    expect(JSON.stringify(file(store))).toBe(document)
  })

  it('an explicit ancestor wins over the canvas default in both directions', () => {
    const view = { previewThemeId: 'dark' }
    const store = loaded(view)
    store.commands.nodeTheme.set(['card'], 'light')
    expect(store.nodeTheme('label')!.effective).toEqual({ mode: 'light', source: { kind: 'ancestor', nodeId: 'card' } })
    expect(store.nodeTheme('label')!.theme.designThemeId).toBe('default')
    view.previewThemeId = 'default'
    store.commands.nodeTheme.set(['card'], 'dark')
    expect(store.nodeTheme('label')!.effective).toEqual({ mode: 'dark', source: { kind: 'ancestor', nodeId: 'card' } })
    expect(store.nodeTheme('label')!.palette).toEqual({ '--surface': hex('#242427') })
    expect(store.nodeTheme('box')!.effective).toEqual({ mode: 'light', source: { kind: 'fallback' } })
  })
})
