import { useSyncExternalStore } from 'react'
import type { Appearance } from '@canvas/repo-engine/appearance'
import { colorToCss, colorToHex, hexColor } from '@canvas/repo-engine/color'
import { resolveColorValue } from '@canvas/repo-engine/file-document'
import type { ComponentNode, FileDocument, FileNode, PrimitiveNode, PrimitiveStylePatch } from '@canvas/repo-engine/file-document'
import { ColorPicker } from '../../design-system/color-picker'
import { InspectorCheck, InspectorHeading, InspectorNumberField, InspectorRow, InspectorSection, InspectorStack, InspectorTextField, InspectorTransformActions } from '../../design-system/inspector-atoms'
import { InspectorColorField } from '../../design-system/inspector-atoms'
import { TokenChooser } from '../../design-system/token-field-atoms'
import { SizingField } from '../../design-system/sizing-field'
import { AppearanceSections } from './AppearancePanels'
import { FrameContainerSections, LayoutSections, sizingFieldState, sizingModesForContext } from './LayoutPanels'
import type { FrameNode } from './LayoutPanels'
import { NodeThemeSection } from './NodeThemePanel'
import { RadiusSection } from './RadiusSection'
import { SelectionColorsPanel } from './SelectionColorsPanel'
import { inspectableTextNodes, TextInspector } from './TextInspector'
import type { StyledNode } from './appearance-adapters'
import { colorTokenOptions } from './appearance-adapters'
import { documentStore } from './document-store'
import { editorStore } from './store'
import { inspectorCopy as copy } from './inspector-copy'
import { sizingModeOf } from './layout-commands'
import { parentDirection } from './layout-measure'
import { sceneGeometry } from './scene-geometry'

type Mode = 'light' | 'dark'
type Overrides = Record<string, Appearance | null> | null

const same = <T,>(values: readonly T[]): T | null => values.every(value => value === values[0]) ? values[0]! : null
const isPrimitive = (node: FileNode): node is PrimitiveNode => node.type !== 'root' && node.type !== 'component'
const isStyled = (node: FileNode): node is StyledNode => node.type !== 'root'
const isComponent = (node: FileNode): node is ComponentNode => node.type === 'component'
const isFrame = (node: PrimitiveNode): node is FrameNode => node.type === 'frame'

/** Re-renders on appearance and preview theme changes; source tokens resolve against the preview theme. */
function useEditorMode(): Mode {
  useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().snapshot, () => editorStore.getSnapshot().snapshot)
  useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().previewThemeId, () => editorStore.getSnapshot().previewThemeId)
  return useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().mode, () => editorStore.getSnapshot().mode)
}

export function PageInspector() {
  const state = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const mode = useEditorMode()
  const page = state.file?.pages.find(candidate => candidate.id === state.pageId)
  if (!page || !state.file) return null
  const palette = documentStore.paletteFor(page.rootNodeId)
  const resolved = page.background ? resolveColorValue(state.file.theme, page.background, palette) : null
  const value = resolved ? colorToHex(resolved) : mode === 'dark' ? '#1f1f1f' : '#ffffff'
  const setLiteral = (hex: string) => documentStore.commands.setPageBackground(page.id, { kind: 'literal', color: hexColor(hex) })
  const tokens = colorTokenOptions(state.file).map(option => {
    const color = resolveColorValue(state.file!.theme, { kind: 'token', tokenId: option.value }, palette)
    return { ...option, ...(color ? { color: colorToCss(color) } : {}) }
  })
  return <InspectorStack>
    <InspectorSection id="page" title={copy.page}>
      <InspectorTextField key={page.id} id="page-name" label={copy.pageName} value={page.name} disabled={state.blocked} onCommit={name => { documentStore.commands.renamePage(page.id, name) }} />
      <InspectorRow>
        <InspectorColorField id="page-background" label={copy.pageBackground} opacityLabel={copy.pageBackgroundOpacity} value={value} disabled={state.blocked} swatch={<ColorPicker variant="swatch" label={copy.pageBackground} value={value} mode={mode} disabled={state.blocked} onChange={setLiteral} />} onCommit={setLiteral} />
        <TokenChooser id="page-background-token" label={copy.pageBackgroundToken} placeholder={copy.pageBackgroundToken} options={tokens} disabled={state.blocked} onChoose={tokenId => documentStore.commands.setPageBackground(page.id, { kind: 'token', tokenId })} />
      </InspectorRow>
    </InspectorSection>
  </InspectorStack>
}

type AppearanceProps = { file: FileDocument; overrides: Overrides; mode: Mode; disabled: boolean }

function PrimitiveInspector({ nodes, file, overrides, mode, disabled }: AppearanceProps & { nodes: readonly PrimitiveNode[] }) {
  const geometry = useSyncExternalStore(sceneGeometry.subscribe, sceneGeometry.getSnapshot, sceneGeometry.getSnapshot)
  type StylePatch = PrimitiveStylePatch
  const apply = (patch: StylePatch) => { documentStore.commands.setStylesMany(Object.fromEntries(nodes.map(node => [node.id, patch]))) }
  const value = (key: 'left' | 'top' | 'width' | 'height' | 'rotation') => same(nodes.map(node => key === 'rotation' ? node.styles.rotation ?? 0 : node.styles[key]))
  const single = nodes.length === 1 ? nodes[0]! : null
  const transform = (next: (node: PrimitiveNode) => StylePatch) => { documentStore.commands.setStylesMany(Object.fromEntries(nodes.map(node => [node.id, next(node)]))) }
  const rotated = (node: PrimitiveNode) => ({ rotation: (((node.styles.rotation ?? 0) + 90) % 360 + 360) % 360 })
  const flipX = nodes.length > 0 && nodes.every(node => node.styles.flipX === true)
  const flipY = nodes.length > 0 && nodes.every(node => node.styles.flipY === true)
  const textNodes = inspectableTextNodes(nodes)
  const frames = nodes.filter(isFrame)
  const frameSizing = frames.length === nodes.length
  const flexContainer = frameSizing && frames.every(node => node.layout?.container?.display === 'flex')
  const flexItem = frameSizing && frames.every(node => parentDirection(file, node.id) !== null)
  const sizingField = (axis: 'width' | 'height') => {
    const label = axis === 'width' ? copy.width : copy.height
    const prefix = axis === 'width' ? 'W' : 'H'
    if (!frameSizing) return <InspectorNumberField id={`layout-${axis}`} label={label} prefix={prefix} value={value(axis)} placeholder={copy.mixed} min={1} max={1000000} disabled={disabled} onCommit={next => apply({ [axis]: next })} />
    const sizing = same(frames.map(node => node.layout?.item[axis] ? sizingModeOf(node.layout, axis) : 'fixed'))
    const available = sizingModesForContext(flexContainer, flexItem)
    const state = sizingFieldState(available, sizing ?? undefined, sizing === null)
    const fixed = sizing === 'fixed'
    const field = <InspectorNumberField id={`layout-${axis}`} label={label} prefix={prefix} value={fixed ? value(axis) : null} placeholder={state.currentLabel} min={1} max={1000000} disabled={disabled || sizing === null} onCommit={next => {
      if (fixed) { apply({ [axis]: next }); return }
      documentStore.commands.layout.primitiveSizing(axis, 'fixed', frames.map(node => ({ id: node.id, measuredPx: next })))
    }} />
    if (!flexContainer && !flexItem) return field
    return <SizingField label={copy.sizingMode(label)} currentLabel={state.currentLabel} options={state.options} disabled={disabled} field={field} onChoose={next => {
      const sizingMode = next === 'fit' ? 'hug' : next
      if (sizingMode !== 'fixed' && sizingMode !== 'hug' && sizingMode !== 'fill') return
      documentStore.commands.layout.primitiveSizing(axis, sizingMode, frames.map(node => {
        const measuredPx = geometry.nodes[node.id]?.rect[axis]
        return { id: node.id, ...(measuredPx === undefined ? {} : { measuredPx }) }
      }))
    }} />
  }
  const clipControl = frames.length === nodes.length
    ? <InspectorCheck id="layout-clip" label={copy.clip} checked={nodes.every(node => node.styles.overflow !== 'visible')} disabled={disabled} onChange={clip => apply({ overflow: clip ? 'clip' : 'visible' })} />
    : null
  return <>
    {single && <InspectorSection id="name" title={copy.name}><InspectorTextField key={single.id} id="element-name" label={copy.name} value={single.name} disabled={disabled} onCommit={name => { documentStore.commands.rename(single.id, name) }} /></InspectorSection>}
    <InspectorSection id="layout" title={copy.layout}>
      <InspectorRow>
        <InspectorNumberField id="position-x" label={copy.x} prefix="X" value={value('left')} placeholder={copy.mixed} min={-1000000} max={1000000} disabled={disabled} onCommit={left => apply({ left })} />
        <InspectorNumberField id="position-y" label={copy.y} prefix="Y" value={value('top')} placeholder={copy.mixed} min={-1000000} max={1000000} disabled={disabled} onCommit={top => apply({ top })} />
        <InspectorNumberField id="position-rotation" label={copy.rotation} prefix="R" suffix="°" value={value('rotation')} placeholder={copy.mixed} min={-360} max={360} disabled={disabled} onCommit={rotation => apply({ rotation })} />
      </InspectorRow>
      <InspectorRow>
        {sizingField('width')}
        {sizingField('height')}
        <InspectorTransformActions actionsLabel={copy.transformActions} rotateLabel={copy.rotate90} flipXLabel={copy.flipHorizontal} flipYLabel={copy.flipVertical} flipXPressed={flipX} flipYPressed={flipY} disabled={disabled} onRotate={() => transform(rotated)} onFlipX={() => transform(node => ({ flipX: node.styles.flipX ? null : true }))} onFlipY={() => transform(node => ({ flipY: node.styles.flipY ? null : true }))} />
      </InspectorRow>
      {frames.length === nodes.length && <FrameContainerSections nodes={frames} file={file} disabled={disabled} />}
      {clipControl}
    </InspectorSection>
    <RadiusSection nodes={nodes} overrides={overrides} disabled={disabled} />
    <NodeThemeSection nodes={nodes} disabled={disabled} />
    <AppearanceSections file={file} nodes={nodes} overrides={overrides} mode={mode} disabled={disabled} afterFill={textNodes.length ? <TextInspector file={file} nodes={textNodes} disabled={disabled} /> : null} />
  </>
}

function ComponentInspector({ node, file, overrides, mode, disabled }: AppearanceProps & { node: ComponentNode }) {
  return <>
    <InspectorSection id="name" title={copy.name}><InspectorTextField key={node.id} id="node-name" label={copy.name} value={node.name ?? node.exportName} disabled={disabled} onCommit={name => { documentStore.commands.rename(node.id, name) }} /></InspectorSection>
    <LayoutSections key={node.id} nodes={[node]} file={file} disabled={disabled} />
    <RadiusSection nodes={[node]} overrides={overrides} disabled={disabled} />
    <NodeThemeSection nodes={[node]} disabled={disabled} />
    <AppearanceSections file={file} nodes={[node]} overrides={overrides} mode={mode} disabled={disabled} />
  </>
}

export function SelectionInspector() {
  const state = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const mode = useEditorMode()
  const file = state.file
  if (!file || state.selection.length === 0) return null
  const nodes = state.selection.map(id => file.nodes[id]).filter((node): node is FileNode => Boolean(node))
  const primitives = nodes.filter(isPrimitive)
  const shared = { file, overrides: state.appearanceOverrides, mode, disabled: state.blocked || state.readOnly }
  const heading = state.selection.length > 1 ? <InspectorHeading>{copy.selected(state.selection.length)}</InspectorHeading> : null
  const colors = <SelectionColorsPanel file={file} selection={state.selection} mode={mode} disabled={state.blocked} />
  if (primitives.length === state.selection.length) return <InspectorStack>{heading}<PrimitiveInspector nodes={primitives} {...shared} />{colors}</InspectorStack>
  const node = nodes[0]
  if (state.selection.length === 1 && node?.type === 'component') return <InspectorStack><ComponentInspector node={node} {...shared} />{colors}</InspectorStack>
  const components = nodes.filter(isComponent)
  if (components.length === state.selection.length) return <InspectorStack>{heading}<LayoutSections key={state.selection.join(' ')} nodes={components} file={file} disabled={shared.disabled} /><RadiusSection nodes={components} overrides={state.appearanceOverrides} disabled={shared.disabled} /><NodeThemeSection nodes={components} disabled={shared.disabled} /><AppearanceSections nodes={components} {...shared} />{colors}</InspectorStack>
  // Primitives and components together: only the theme and the shared appearance sections apply.
  const styled = nodes.filter(isStyled)
  return <InspectorStack>{heading}<RadiusSection nodes={styled} overrides={state.appearanceOverrides} disabled={shared.disabled} /><NodeThemeSection nodes={styled} disabled={shared.disabled} /><AppearanceSections nodes={styled} {...shared} />{colors}</InspectorStack>
}
