import { useSyncExternalStore } from 'react'
import type { FileDocument, FileNode } from '@canvas/repo-engine/file-document'
import { nodeThemeMode, nodeThemeModes, resolveThemeForMode } from '@canvas/repo-engine/node-theme'
import type { ColorScheme, EffectiveNodeTheme, NodeThemeMode } from '@canvas/repo-engine/node-theme'
import type { IconName } from '../../design-system/atoms'
import { InspectorNote, InspectorRadioGroup, InspectorSection } from '../../design-system/inspector-atoms'
import type { InspectorOption } from '../../design-system/inspector-atoms'
import { displayName } from './canvas-scene'
import { documentStore } from './document-store'
import { sceneGeometry } from './scene-geometry'
import { editorStore } from './store'
import { inspectorCopy as copy } from './inspector-copy'

type ThemedNode = Exclude<FileNode, { type: 'root' }>
const icons: Partial<Record<NodeThemeMode, IconName>> = { light: 'sun', dark: 'moon' }
const schemes: readonly ColorScheme[] = ['light', 'dark']
const sourceKey = (effective: EffectiveNodeTheme) => effective.source.kind === 'ancestor' ? `ancestor:${effective.source.nodeId}` : effective.source.kind

/** The secondary line for a selection whose stored modes all read `inherit`: where the effective scheme comes from. */
function inheritedLine(file: FileDocument, effective: readonly EffectiveNodeTheme[]): string | undefined {
  const first = effective[0]
  if (!first) return undefined
  if (effective.some(entry => entry.mode !== first.mode)) return copy.effectiveMixed
  const mode = copy.themeModes[first.mode]
  if (effective.some(entry => sourceKey(entry) !== sourceKey(first))) return copy.inheritedMode(mode)
  return first.source.kind === 'ancestor' ? copy.inheritedFrom(mode, displayName(file, first.source.nodeId)) : copy.inheritedFromCanvas(mode)
}

/**
 * Stored theme mode of one or many selected layers. Every read goes through the document relationships and the file's
 * canvas default theme; the editor appearance is never consulted. Choosing a segment writes one batch for all layers.
 */
export function NodeThemeSection({ nodes, disabled }: { nodes: readonly ThemedNode[]; disabled: boolean }) {
  const state = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const geometry = useSyncExternalStore(sceneGeometry.subscribe, sceneGeometry.getSnapshot, sceneGeometry.getSnapshot)
  // The canvas default theme and the declared design themes decide inheritance and which segments are available.
  useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().previewThemeId, () => editorStore.getSnapshot().previewThemeId)
  useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().snapshot, () => editorStore.getSnapshot().snapshot)
  const file = state.file
  if (!file || !nodes.length) return null

  const context = documentStore.themeContext()
  const unavailable = new Map<NodeThemeMode, string>()
  for (const scheme of schemes) {
    const resolved = resolveThemeForMode(context.themes, context.previewThemeId, scheme)
    if (resolved.status === 'missing') unavailable.set(scheme, copy.themeMissing(copy.themeModes[scheme]))
    else if (resolved.status === 'ambiguous') unavailable.set(scheme, copy.themeAmbiguous(copy.themeModes[scheme], resolved.candidates.length))
  }

  const stored = nodes.map(node => nodeThemeMode(node))
  const value = stored.every(mode => mode === stored[0]) ? stored[0]! : null
  const themes = nodes.flatMap(node => { const theme = documentStore.nodeTheme(node.id); return theme ? [theme] : [] })
  const description = value === 'inherit' ? inheritedLine(file, themes.map(theme => theme.effective)) : undefined

  const notes = new Set<string>(unavailable.values())
  for (const theme of themes) {
    if (theme.diagnostic?.reason === 'cycle') notes.add(copy.themeLoop)
    if (theme.diagnostic?.reason === 'missing-node') notes.add(copy.themeMissingParent)
    if (theme.diagnostic?.reason === 'base-theme-inside-attribute') notes.add(copy.themeBaseInsideAttribute)
  }
  for (const node of nodes) {
    if (node.type !== 'component') continue
    const status = geometry.nodes[node.id]?.theme ?? geometry.themeUnsupported[node.id]
    if (status && status !== 'applied') notes.add(copy.themeLimited[status])
  }
  if (geometry.unownedPortals > 0 && nodes.some(node => node.type === 'component')) notes.add(copy.unownedPortals)

  const options = nodeThemeModes.map((mode): InspectorOption<NodeThemeMode> => {
    const icon = icons[mode]
    const reason = unavailable.get(mode)
    return { value: mode, label: copy.themeModes[mode], ...(icon ? { icon } : {}), ...(reason ? { disabled: true, reason } : {}) }
  })
  const ids = nodes.map(node => node.id)
  return <InspectorSection id="theme" title={copy.theme}>
    <InspectorRadioGroup label={copy.theme} value={value} options={options} disabled={disabled} showLabels mixedLabel={copy.mixedThemeModes} {...(description ? { description } : {})} onChange={mode => { documentStore.commands.nodeTheme.set(ids, mode) }} />
    {[...notes].map(note => <InspectorNote key={note} icon="alert">{note}</InspectorNote>)}
  </InspectorSection>
}
