import { useState, useSyncExternalStore } from 'react'
import { nodeChildDisplay } from '@canvas/repo-engine/file-document'
import type { ComponentNode, FileCommand, FileDocument, PrimitiveNode } from '@canvas/repo-engine/file-document'
import { itemAlignments, maxGridTracks, sizingModes, spacingSides } from '@canvas/repo-engine/layout'
import type { CrossAlignment, DisplayMode, FlexContainer, GridContainer, GridItem, InsetLength, ItemAlignment, LayoutContainer, LayoutGap, LayoutLength, MainDistribution, MarginSide, NodeLayout, NodeSpacing, SizingMode, SpacingSides } from '@canvas/repo-engine/layout'
import { parseGridTemplate, tracksToCss } from '@canvas/repo-engine/grid-tracks'
import type { GridTrack } from '@canvas/repo-engine/grid-tracks'
import { InspectorAlert, InspectorAnchorGrid, InspectorCheck, InspectorFixedSlot, InspectorFlexDirection, InspectorFlexEntryAction, InspectorFlexOverflow, InspectorFlexPaddingToggle, InspectorFlexPanel, InspectorFlexWrap, InspectorGroup, InspectorIconButton, InspectorNote, InspectorRadioGroup, InspectorRow, InspectorRowSpacer, InspectorScrubField, InspectorSection, InspectorSpacingHeading, InspectorSpacingMode, InspectorTextButton, InspectorTextField, InspectorTrackRow, InspectorTransformActions } from '../../design-system/inspector-atoms'
import type { InspectorFlexMatrixMode, InspectorFlexOverflowAction } from '../../design-system/inspector-atoms'
import type { InspectorAnchorCell, InspectorNumericToken, InspectorScrubSession } from '../../design-system/inspector-atoms'
import { AppearanceSelect } from '../../design-system/appearance-atoms'
import { Icon } from '../../design-system/atoms'
import { editorToast } from '../../design-system/toast-atoms'
import { SizingField } from '../../design-system/sizing-field'
import { documentStore } from './document-store'
import { inspectorCopy as copy } from './inspector-copy'
import { flipTransform, positionAbsolute, rotateTransformQuarter, setAxisLength, setInset, setSpacing, setTransformRotation, setZIndex, sizingModeOf } from './layout-commands'
import type { Axis } from './layout-commands'
import type { GridAxis } from './layout-grid-commands'
import { isRootChild, layoutOf, layoutReport, localPoint, measuredChildren, measuredGrid, parentDirection, sizingTargets } from './layout-measure'
import type { LayoutGeometry } from './layout-measure'
import type { PreviewLayoutReport } from '@canvas/preview-runtime/protocol'
import { sceneGeometry } from './scene-geometry'
import { editorStore } from './store'
import { canvasGestures } from './canvas-gestures'
import { executePaperFlexAction, paperFlexActionCandidates, paperFlexActionCopy } from './layout-flex-actions'
import type { PaperFlexAction } from './layout-flex-actions'
import { redirectFlex } from './layout-flex-commands'

export type FrameNode = PrimitiveNode & { type: 'frame' }
type LayoutNode = ComponentNode | FrameNode
type ContextBase<N extends LayoutNode> = { file: FileDocument; nodes: readonly N[]; ids: string[]; geometry: LayoutGeometry; disabled: boolean; numericTokens: readonly InspectorNumericToken[] }
type ComponentContext = ContextBase<ComponentNode> & { kind: 'component' }
type FrameContext = ContextBase<FrameNode> & { kind: 'frame' }
type ContainerContext = ComponentContext | FrameContext
type Agreement<T> = { mixed: boolean; value: T | undefined }

const limit = 1_000_000
const defaultOption = '#default'
const noSourceTokens: readonly { name: string; value: string }[] = []
const layout = () => documentStore.commands.layout
const grid = () => documentStore.commands.layout.grid
const px = (value: number): InsetLength => ({ kind: 'px', value })
const json = (value: unknown) => JSON.stringify(value ?? null)

/** One shared value across the selection, or `mixed` when any node differs (structural comparison). */
function agree<T>(values: readonly T[]): Agreement<T> {
  if (!values.length) return { mixed: false, value: undefined }
  const first = json(values[0])
  return values.every(value => json(value) === first) ? { mixed: false, value: values[0] } : { mixed: true, value: undefined }
}
/** The number a field shows: null renders the placeholder (Mixed, or empty when nothing is authored). */
const shown = (agreement: Agreement<number | undefined>): number | null => agreement.mixed ? null : agreement.value ?? null
const mixedPlaceholder = (agreement: Agreement<unknown>, fallback = '') => agreement.mixed ? copy.mixed : fallback
const pxOf = (length: LayoutLength | undefined): number | undefined => length?.kind === 'px' ? length.value : undefined

/** CSS pixel tokens are the only source values the current numeric layout model can represent without losing units. */
export function numericLayoutTokens(tokens: readonly { name: string; value: string }[], minimum = 0): InspectorNumericToken[] {
  return tokens.flatMap(token => {
    const match = /^(-?(?:\d+(?:\.\d*)?|\.\d+))px$/i.exec(token.value.trim())
    if (!match) return []
    const value = Number(match[1])
    return Number.isFinite(value) && value >= minimum ? [{ name: token.name, value, displayValue: token.value.trim() }] : []
  })
}

/** Paper calls intrinsic sizing Fit; every context-valid mode stays available and an invalid stored mode stays visible. */
export function sizingFieldState(available: readonly SizingMode[], current: SizingMode | undefined, mixed: boolean) {
  const currentLabel = mixed ? copy.mixed : current === 'hug' ? 'Fit' : copy.sizingModes[current ?? 'auto']
  const options = sizingModes
    .filter(mode => available.includes(mode) || mode === current)
    .map(mode => ({ value: mode === 'hug' ? 'fit' : mode, label: mode === 'hug' ? 'Fit' : copy.sizingModes[mode], selected: !mixed && current === mode, disabled: !available.includes(mode) }))
  return { currentLabel, options }
}

export function sizingModesForContext(flexContainer: boolean, flexItem: boolean): SizingMode[] {
  if (!flexContainer && !flexItem) return ['fixed']
  return ['fixed', 'hug', ...(flexItem ? ['fill' as const] : [])]
}

/**
 * Live layout preview for a scrub: every node starts from the layout it had when the scrub began, previews ride on
 * the protocol only, release commits one batch (one undo entry), and cancel writes nothing.
 */
function scrubSession(nodes: readonly LayoutNode[], update: (layout: NodeLayout | undefined, value: number, node: LayoutNode) => NodeLayout | null): InspectorScrubSession {
  const gesture = layout().gesture
  const start = [...nodes]
  let preview: Record<string, NodeLayout> = {}
  gesture.begin()
  return {
    move: value => {
      preview = Object.fromEntries(start.flatMap(node => { const next = update(node.layout, value, node); return next ? [[node.id, next]] : [] }))
      gesture.preview(preview)
    },
    end: () => {
      gesture.cancel()
      const file = documentStore.getSnapshot().file
      if (!file) return
      const commands = Object.entries(preview).flatMap(([nodeId, next]): FileCommand[] => {
        const current = file.nodes[nodeId]
        return current && current.type !== 'root' && json(current.layout) !== json(next) ? [{ type: 'node.setLayout', nodeId, layout: next }] : []
      })
      if (commands.length) documentStore.commands.executeBatch(commands)
    },
    cancel: () => gesture.cancel(),
  }
}

/** Every selected layout node receives its own exact result in one semantic batch. */
function writeEach<T>(nodes: readonly LayoutNode[], next: (node: LayoutNode) => T, record: (node: LayoutNode, value: T) => NodeLayout) {
  const values = nodes.map(node => ({ node, value: next(node) }))
  const commands = values.flatMap(({ node, value }): FileCommand[] => {
    const nextLayout = record(node, value)
    return json(node.layout) === json(nextLayout) ? [] : [{ type: 'node.setLayout', nodeId: node.id, layout: nextLayout }]
  })
  if (commands.length) documentStore.commands.executeBatch(commands)
}

export function LayoutSections({ nodes, file, disabled }: { nodes: readonly ComponentNode[]; file: FileDocument; disabled: boolean }) {
  const geometry = useSyncExternalStore(sceneGeometry.subscribe, sceneGeometry.getSnapshot, sceneGeometry.getSnapshot)
  const sourceTokens = useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().snapshot?.tokens ?? noSourceTokens, () => editorStore.getSnapshot().snapshot?.tokens ?? noSourceTokens)
  if (!nodes.length) return null
  const context: ComponentContext = { kind: 'component', file, nodes, ids: nodes.map(node => node.id), geometry, disabled, numericTokens: numericLayoutTokens(sourceTokens, -limit) }
  const flex = nodes.every(node => node.layout?.container?.display === 'flex')
  return <>
    <ComponentLayoutSection context={context} />
    <ContainerSection context={context} />
    <ItemSection context={context} />
    {!flex && <SpacingSection context={context} />}
  </>
}

/** Frames keep their native position and size controls, then share the Paper-style container controls with components. */
export function FrameContainerSections({ nodes, file, disabled }: { nodes: readonly FrameNode[]; file: FileDocument; disabled: boolean }) {
  const geometry = useSyncExternalStore(sceneGeometry.subscribe, sceneGeometry.getSnapshot, sceneGeometry.getSnapshot)
  const sourceTokens = useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().snapshot?.tokens ?? noSourceTokens, () => editorStore.getSnapshot().snapshot?.tokens ?? noSourceTokens)
  if (!nodes.length) return null
  const context: FrameContext = { kind: 'frame', file, nodes, ids: nodes.map(node => node.id), geometry, disabled, numericTokens: numericLayoutTokens(sourceTokens, -limit) }
  return <ContainerSection context={context} />
}

// Position ------------------------------------------------------------------------------------------------------------

function ComponentLayoutSection({ context }: { context: ComponentContext }) {
  const { file, nodes, ids, geometry, disabled } = context
  const positions = nodes.map(node => node.layout?.item.position ?? { mode: 'flow' as const })
  const roots = nodes.map(node => isRootChild(file, node.id))
  const mode = agree(positions.map(position => position.mode))
  const absolute = positions.every(position => position.mode === 'absolute')
  // A root child still in the host flow shows its measured world position; committing X or Y takes it out of the flow there.
  const editable = positions.every((position, index) => position.mode === 'absolute' || roots[index])
  const locked = positions.some((position, index) => position.mode === 'flow' && !roots[index])
  const coordinate = (side: 'left' | 'top') => agree(nodes.map((node, index) => {
    const position = positions[index]!
    if (position.mode === 'absolute') return pxOf(position[side])
    const point = localPoint(file, geometry, node.id)
    return point ? Math.round(side === 'left' ? point.x : point.y) : undefined
  }))
  const inset = (side: 'right' | 'bottom') => agree(positions.map(position => pxOf(position[side])))
  const zIndex = agree(positions.map(position => position.zIndex))
  const rotation = agree(nodes.map(node => node.layout?.item.transform?.rotate ?? 0))
  const scale = (node: ComponentNode) => { const value = node.layout?.item.transform?.scale; return typeof value === 'number' ? { x: value, y: value } : value ?? { x: 1, y: 1 } }
  const flipX = nodes.length > 0 && nodes.every(node => scale(node).x < 0)
  const flipY = nodes.length > 0 && nodes.every(node => scale(node).y < 0)
  const flexContainer = nodes.every(node => node.layout?.container?.display === 'flex')
  const flexItem = nodes.every(node => parentDirection(file, node.id) !== null)
  const flexSizing = flexContainer || flexItem
  const commitCoordinate = (side: 'left' | 'top', value: number) => {
    if (absolute) { layout().inset(side, px(value), ids); return }
    layout().setMany(Object.fromEntries(nodes.flatMap((node, index) => {
      if (positions[index]!.mode === 'absolute') { const next = setInset(node.layout, side, px(value)); return next ? [[node.id, next]] : [] }
      const rect = geometry.nodes[node.id]?.rect
      return rect ? [[node.id, positionAbsolute(node.layout, { x: side === 'left' ? value : rect.x, y: side === 'top' ? value : rect.y })]] : []
    })))
  }
  const changeMode = (next: 'flow' | 'absolute') => {
    layout().position(next, nodes.map(node => { const local = next === 'absolute' ? localPoint(file, geometry, node.id) : undefined; return { id: node.id, ...(local ? { local } : {}) } }))
  }
  const insetScrub = (side: 'left' | 'top' | 'right' | 'bottom') => absolute ? () => scrubSession(nodes, (current, value) => setInset(current, side, px(value))) : undefined
  const xValue = coordinate('left'), yValue = coordinate('top'), right = inset('right'), bottom = inset('bottom')
  const transform = (update: (node: ComponentNode) => NodeLayout) => { layout().setMany(Object.fromEntries(nodes.map(node => [node.id, update(node)]))) }
  const compactAxis = (axis: Axis) => {
    const sizing = agree(nodes.map(node => sizingModeOf(node.layout, axis)))
    const available = sizingModesForContext(flexContainer, flexItem)
    const relative = !sizing.mixed && sizing.value === 'relative'
    const editableSize = !sizing.mixed && (!flexSizing || sizing.value === 'fixed' || relative)
    const value = agree(nodes.map(node => { const length = node.layout?.item[axis]?.value; return length?.kind === 'px' || length?.kind === 'percent' ? length.value : undefined }))
    const measured = agree(nodes.map(node => geometry.nodes[node.id]?.rect[axis]))
    const label = axis === 'width' ? copy.width : copy.height
    const prefix = axis === 'width' ? copy.prefixes.width : copy.prefixes.height
    const effectiveSizing = !sizing.mixed && flexSizing && sizing.value === 'auto' ? 'hug' : sizing.value
    const sizingField = sizingFieldState(available, effectiveSizing, sizing.mixed)
    const toLength = (next: number): LayoutLength => relative ? { kind: 'percent', value: next } : { kind: 'px', value: next }
    const choose = (next: string) => {
      const mode: SizingMode = next === 'fit' ? 'hug' : next as SizingMode
      layout().sizing(axis, mode, sizingTargets(file, geometry, ids, axis))
    }
    const field = <InspectorScrubField id={`sizing-${axis}`} label={label} prefix={prefix} value={editableSize ? shown(value) ?? shown(measured) : null} placeholder={flexSizing ? sizingField.currentLabel : mixedPlaceholder(measured)} min={0} max={relative ? 99 : limit} {...(!relative && context.numericTokens.length ? { tokens: context.numericTokens, tokenLabel: copy.numericToken(label) } : {})} {...(relative ? { suffix: copy.percentSuffix } : {})} disabled={disabled || !editableSize} onCommit={next => { layout().length(axis, toLength(next), ids) }} onScrubStart={() => scrubSession(nodes, (before, next) => setAxisLength(before, axis, toLength(next)))} />
    return flexSizing ? <SizingField label={copy.sizingMode(label)} currentLabel={sizingField.currentLabel} options={sizingField.options} disabled={disabled} onChoose={choose} field={field} /> : field
  }
  return <InspectorSection id="layout" title={copy.layout}>
    <InspectorRow>
      <InspectorScrubField id="position-x" label={copy.x} prefix={copy.prefixes.x} value={shown(xValue)} placeholder={mixedPlaceholder(xValue)} min={-limit} max={limit} disabled={disabled || !editable} onCommit={value => commitCoordinate('left', value)} {...(absolute ? { onClear: () => { layout().inset('left', null, ids) } } : {})} {...withScrub(insetScrub('left'))} />
      <InspectorScrubField id="position-y" label={copy.y} prefix={copy.prefixes.y} value={shown(yValue)} placeholder={mixedPlaceholder(yValue)} min={-limit} max={limit} disabled={disabled || !editable} onCommit={value => commitCoordinate('top', value)} {...(absolute ? { onClear: () => { layout().inset('top', null, ids) } } : {})} {...withScrub(insetScrub('top'))} />
      <InspectorScrubField id="position-rotation" label={copy.rotation} prefix="R" suffix="°" value={shown(rotation)} placeholder={mixedPlaceholder(rotation)} min={-3600} max={3600} disabled={disabled} onCommit={value => { transform(node => setTransformRotation(node.layout, value)) }} onScrubStart={() => scrubSession(nodes, (current, value) => setTransformRotation(current, value))} />
    </InspectorRow>
    <InspectorRow>
      {compactAxis('width')}
      {compactAxis('height')}
      <InspectorTransformActions actionsLabel={copy.transformActions} rotateLabel={copy.rotate90} flipXLabel={copy.flipHorizontal} flipYLabel={copy.flipVertical} absoluteLabel={copy.absolute} flipXPressed={flipX} flipYPressed={flipY} absolutePressed={!mode.mixed && absolute} disabled={disabled} onRotate={() => transform(node => rotateTransformQuarter(node.layout))} onFlipX={() => transform(node => flipTransform(node.layout, 'width'))} onFlipY={() => transform(node => flipTransform(node.layout, 'height'))} onAbsolute={() => changeMode(absolute && !mode.mixed ? 'flow' : 'absolute')} />
    </InspectorRow>
    {absolute && <InspectorRow>
      <InspectorScrubField id="position-right" label={copy.rightInset} prefix={copy.prefixes.right} value={shown(right)} placeholder={mixedPlaceholder(right)} min={-limit} max={limit} disabled={disabled} onCommit={value => { layout().inset('right', px(value), ids) }} onClear={() => { layout().inset('right', null, ids) }} {...withScrub(insetScrub('right'))} />
      <InspectorScrubField id="position-bottom" label={copy.bottomInset} prefix={copy.prefixes.bottom} value={shown(bottom)} placeholder={mixedPlaceholder(bottom)} min={-limit} max={limit} disabled={disabled} onCommit={value => { layout().inset('bottom', px(value), ids) }} onClear={() => { layout().inset('bottom', null, ids) }} {...withScrub(insetScrub('bottom'))} />
    </InspectorRow>}
    {absolute && <InspectorRow>
      <InspectorScrubField id="position-z" label={copy.zIndex} prefix={copy.prefixes.z} value={shown(zIndex)} placeholder={mixedPlaceholder(zIndex)} min={-10_000} max={10_000} disabled={disabled} onCommit={value => { layout().zIndex(value, ids) }} onClear={() => { layout().zIndex(null, ids) }} onScrubStart={() => scrubSession(nodes, (current, value) => setZIndex(current, value))} />
      <InspectorRowSpacer />
    </InspectorRow>}
    {locked && <InspectorNote icon="lock">{copy.lockedToLayout}</InspectorNote>}
  </InspectorSection>
}
const withScrub = (start: (() => InspectorScrubSession) | undefined) => start ? { onScrubStart: start } : {}

// Container -----------------------------------------------------------------------------------------------------------

export type SelectedDisplayResult = Readonly<{ status: 'written' | 'unchanged' | 'ineligible' | 'unavailable'; note: string | null }>

export function runInspectorFlexAction(action: PaperFlexAction, report: (title: string, message: string) => void = editorToast.error) {
  const result = executePaperFlexAction(action)
  if (result.status === 'written') return result
  const title = action === 'add-flex-to-node' ? "Couldn't add flex" : action === 'wrap-in-flex' ? "Couldn't wrap in flex" : "Couldn't remove flex"
  report(title, result.status === 'unavailable' ? result.message ?? paperFlexActionCopy.changed : paperFlexActionCopy.changed)
  return result
}

/** Invocation-time display action shared by the inspector. It never retains render-time selection or geometry. */
export function setSelectedContainerDisplay(next: DisplayMode): SelectedDisplayResult {
  const snapshot = documentStore.getSnapshot()
  const currentFile = snapshot.file
  if (!currentFile) return { status: 'ineligible', note: null }
  const currentIds = [...snapshot.selection]
  const currentNodes = currentIds.map(id => currentFile.nodes[id])
  if (!currentIds.length || currentNodes.some(node => !node || (node.type !== 'component' && node.type !== 'frame'))) return { status: 'ineligible', note: null }
  const currentDisplays = currentNodes.map(node => nodeChildDisplay(node!))
  if (currentDisplays.every(display => display === next)) return { status: 'unchanged', note: null }
  if (next === 'flex') {
    const result = executePaperFlexAction('add-flex-to-node')
    return result.status === 'written' ? { status: 'written', note: null }
      : result.status === 'unavailable' ? { status: 'unavailable', note: result.message ?? null }
      : { status: 'ineligible', note: null }
  }
  const currentGeometry = sceneGeometry.getSnapshot()
  const measured = Object.fromEntries(currentIds.map(id => [id, {
    boxes: measuredChildren(currentFile, currentGeometry, id),
    flexInput: null,
  }]))
  // Exact measurement gaps stay visible beside the control instead of being approximated or silently ignored.
  const notes = [...new Set(currentIds.flatMap(id => { const unsupported = layout().displayConversion(next, id, measured[id] ?? null)?.unsupported; return unsupported ? [unsupported] : [] }))]
  return {
    status: layout().setDisplay(next, currentIds, measured) ? 'written' : notes.length ? 'unavailable' : 'unchanged',
    note: notes.length ? notes.join('. ') : null,
  }
}

function ContainerSection({ context }: { context: ContainerContext }) {
  const { file, nodes, ids, geometry, disabled } = context
  const containers = nodes.map(node => node.layout?.container)
  const display = agree(containers.map(container => container?.display ?? (context.kind === 'frame' ? 'freeform' : null)))
  const current = display.mixed ? null : display.value ?? null
  const reports = ids.map(id => layoutReport(geometry, id)).filter((report): report is PreviewLayoutReport => report !== null)
  const statuses = [...new Set(reports.map(report => report.status).filter(status => status !== 'applied'))]
  const conflicts = [...new Set(reports.flatMap(report => report.conflicts))]
  const authored = containers.filter((container): container is LayoutContainer => container !== undefined)
  const store = documentStore.getSnapshot()
  const candidates = paperFlexActionCandidates({ file, selection: ids, readOnly: store.readOnly, pointerBusy: canvasGestures.active })
  const entry = candidates.find(candidate => candidate.action === 'add-flex-to-node' || candidate.action === 'wrap-in-flex')
  const remove = candidates.find(candidate => candidate.action === 'remove-flex')
  const entryControl = entry ? <InspectorFlexEntryAction label={entry.action === 'add-flex-to-node' ? 'Add flex' : 'Wrap in flex'} shortcut="Shift+A" disabled={disabled} onClick={() => runInspectorFlexAction(entry.action)} /> : null
  const flexNodes = nodes.filter(node => node.layout?.container?.display === 'flex' && node.layout.container.flex)
  const flexContext = { ...context, nodes: flexNodes, ids: flexNodes.map(node => node.id) }
  if (!flexNodes.length) {
    if (current === 'grid' && context.kind === 'component') return <>{entryControl}<InspectorSection id="container" title={copy.displays.grid}>
      <GridControls context={context} grids={authored.map(container => container.grid!)} />
      <GapControls context={context} />
      {authored.length === nodes.length && <OverflowControl context={context} containers={authored} />}
    </InspectorSection></>
    return entryControl
  }
  return <>{entryControl}<InspectorSection id="container" title={copy.flex} actions={remove ? <InspectorIconButton label="Remove flex" title="Remove flex · Shift+Alt+A" icon="trash" disabled={disabled} onClick={() => runInspectorFlexAction('remove-flex')} /> : null}>
    <FlexControls context={flexContext} />
    {statuses.map(status => <InspectorNote key={status} icon="alert">{copy.layoutStatuses[status]}</InspectorNote>)}
    {conflicts.length > 0 && <InspectorNote icon="alert">{copy.layoutConflicts(conflicts.join(', '))}</InspectorNote>}
  </InspectorSection>
  {context.kind === 'component' && authored.length === nodes.length && <InspectorSection id="container-overflow-section" title={copy.overflow}><OverflowControl context={context} containers={authored} /></InspectorSection>}
  </>
}

const anchorNames = ['start', 'center', 'end'] as const
type FlexContext = Omit<ContextBase<LayoutNode>, 'nodes'> & { nodes: readonly LayoutNode[] }
const flexOf = (node: LayoutNode) => node.layout?.container?.display === 'flex' ? node.layout.container.flex : undefined
const worldAxes = (flex: FlexContainer) => {
  const row = flex.direction.startsWith('row')
  const wrapping = flex.wrap !== 'nowrap'
  const cross = wrapping ? flex.alignContent ?? flex.align : flex.align
  return row ? { x: flex.justify, y: cross } : { x: cross, y: flex.justify }
}
const withFlex = (layoutValue: NodeLayout | undefined, flex: FlexContainer): NodeLayout => ({ ...(layoutValue ?? { item: { position: { mode: 'flow' } } }), container: { ...layoutValue?.container, display: 'flex', flex } })

/** Paper resets wrapping when the primary direction changes while preserving the visible world-axis alignment. */
export function paperFlexDirection(flex: FlexContainer, direction: 'row' | 'column'): FlexContainer {
  return { ...redirectFlex(flex, direction), wrap: 'nowrap' }
}

/** First and last baseline are distinct persisted values. Selecting either one also puts Flex in its valid row direction. */
export function paperFlexBaseline(flex: FlexContainer, baseline: Extract<CrossAlignment, 'baseline' | 'last baseline'>): FlexContainer {
  const row = redirectFlex(flex, 'row')
  return { ...row, align: row.align === baseline ? 'start' : baseline }
}

/** Double-clicking a matrix cell selects Paper's main-axis space-between mode without changing the cross axis. */
export function paperFlexMainSpaceBetween(flex: FlexContainer): FlexContainer {
  return { ...flex, justify: 'space-between' }
}

export function paperFlexOverflowLabels(axis: 'row' | 'column' | null): Readonly<{ main: string; cross: string }> {
  return axis === 'row' ? { main: 'Horizontally', cross: 'Vertically' }
    : axis === 'column' ? { main: 'Vertically', cross: 'Horizontally' }
      : { main: 'On the main axis', cross: 'On the cross axis' }
}

function FlexControls({ context }: { context: FlexContext }) {
  const { nodes, ids, disabled } = context
  const flexes = nodes.flatMap(node => { const value = flexOf(node); return value ? [value] : [] })
  const direction = agree(flexes.map(flex => flex.direction))
  const wrap = agree(flexes.map(flex => flex.wrap))
  const justify = agree(flexes.map(flex => flex.justify))
  const align = agree(flexes.map(flex => flex.align))
  const alignContent = agree(flexes.map(flex => flex.alignContent ?? null))
  const axis = direction.mixed || !direction.value ? null : direction.value.startsWith('row') ? 'row' as const : 'column' as const
  const wrapping = !wrap.mixed && wrap.value !== 'nowrap'
  const axes = flexes.map(worldAxes)
  const x = agree(axes.map(value => value.x)), y = agree(axes.map(value => value.y))
  const baselineValue = !align.mixed && (align.value === 'baseline' || align.value === 'last baseline') ? align.value : null
  const mode: InspectorFlexMatrixMode = baselineValue ? 'baseline' : !x.mixed && x.value === 'space-between' ? 'space-horizontal' : !y.mixed && y.value === 'space-between' ? 'space-vertical' : 'normal'
  const worldIndex = (value: MainDistribution | CrossAlignment | null | undefined) => anchorNames.indexOf(value as typeof anchorNames[number])
  const visibleIndex = (value: MainDistribution | CrossAlignment | null | undefined) => {
    const index = worldIndex(value)
    return index < 0 ? 1 : index
  }
  // Space-between has no single anchor. Paper keeps the composite control active at its neutral center so another
  // keyboard or pointer choice can replace that axis without the matrix losing its tab-owned state.
  const selectedX = baselineValue ? justify.mixed ? -1 : visibleIndex(justify.value) : x.mixed ? -1 : visibleIndex(x.value)
  const selectedY = baselineValue ? 0 : y.mixed ? -1 : visibleIndex(y.value)
  const cells: InspectorAnchorCell[] = [0, 1, 2].flatMap(row => [0, 1, 2].map(column => ({ key: `${row}-${column}`, label: copy.anchors[row]![column]!, x: column, y: row, pressed: mode === 'space-horizontal' ? row === selectedY : mode === 'space-vertical' ? column === selectedX : mode === 'baseline' ? row === 0 && column === selectedX : row === selectedY && column === selectedX })))
  const writeFlex = (edit: (flex: FlexContainer) => FlexContainer) => writeEach(nodes, node => edit(flexOf(node)!), (node, next) => withFlex(node.layout, next))
  const alignedFlex = (flex: FlexContainer, worldX: typeof anchorNames[number], worldY: typeof anchorNames[number]) => {
    const row = flex.direction.startsWith('row')
    const cross = row ? worldY : worldX
    const main = row ? worldX : worldY
    return flex.wrap === 'nowrap' ? { ...flex, justify: main, align: cross } : { ...flex, justify: main, alignContent: cross }
  }
  const setWorld = (worldX: typeof anchorNames[number], worldY: typeof anchorNames[number]) => writeFlex(flex => alignedFlex(flex, worldX, worldY))
  const choose = (key: string) => {
    const cell = cells.find(candidate => candidate.key === key)
    if (!cell) return
    const worldX = anchorNames[cell.x]!, worldY = anchorNames[cell.y]!
    if (mode === 'baseline') { writeFlex(flex => ({ ...flex, direction: 'row', justify: worldX, align: baselineValue ?? 'baseline' })); return }
    if (mode === 'space-horizontal') { writeFlex(flex => { const next = alignedFlex(flex, 'start', worldY); return flex.direction.startsWith('row') ? { ...next, justify: 'space-between' } : { ...next, alignContent: 'space-between' } }); return }
    if (mode === 'space-vertical') { writeFlex(flex => { const next = alignedFlex(flex, worldX, 'start'); return flex.direction.startsWith('row') ? { ...next, alignContent: 'space-between' } : { ...next, justify: 'space-between' } }); return }
    setWorld(worldX, worldY)
  }
  const setMainSpace = () => writeFlex(paperFlexMainSpaceBetween)
  const changeDirection = (next: 'row' | 'column') => writeFlex(flex => paperFlexDirection(flex, next))
  const toggleBaseline = (value: Extract<CrossAlignment, 'baseline' | 'last baseline'>) => writeFlex(flex => paperFlexBaseline(flex, value))
  const overflow = (action: InspectorFlexOverflowAction) => {
    if (action === 'main-space-between') { layout().setAlignment({ justify: justify.value === 'space-between' ? 'start' : 'space-between' }, ids); return }
    if (action === 'cross-space-between') { layout().setAlignContent(alignContent.value === 'space-between' ? 'start' : 'space-between', ids); return }
    if (action === 'first-baseline') { toggleBaseline('baseline'); return }
    if (action === 'last-baseline') toggleBaseline('last baseline')
  }
  const overflowLabels = paperFlexOverflowLabels(axis)
  const gap = nodes.map(node => node.layout?.container?.gap)
  const mainGap = agree(gap.map((value, index) => { const current = flexes[index]!; const pair = typeof value === 'object' ? value : { x: value, y: value }; return current.direction.startsWith('row') ? pair.x : pair.y }))
  const crossGap = agree(gap.map((value, index) => { const current = flexes[index]!; const pair = typeof value === 'object' ? value : { x: value, y: value }; return current.direction.startsWith('row') ? pair.y : pair.x }))
  const gapTokens = context.numericTokens.filter(token => token.value >= 0)
  const setAxisGap = (kind: 'main' | 'cross', value: number) => writeEach(nodes, (node) => {
    const flex = flexOf(node)!
    const current = node.layout?.container?.gap
    const pair = typeof current === 'object' ? { ...current } : { x: current ?? 0, y: current ?? 0 }
    const key = flex.direction.startsWith('row') === (kind === 'main') ? 'x' : 'y'
    pair[key] = value
    return pair
  }, (node, next) => ({ ...node.layout!, container: { ...node.layout!.container!, gap: next } }))
  const matrix = <InspectorAnchorGrid label={copy.alignment} cells={cells} mode={mode} direction={axis ?? 'row'} disabled={disabled || axis === null || wrap.mixed} onSelect={choose} onSpaceBetween={setMainSpace} />
  const directionControl = <InspectorFlexDirection label={copy.direction} rowLabel={copy.directions.row} columnLabel={copy.directions.column} axis={axis} disabled={disabled || direction.mixed} onAxis={changeDirection} />
  const wrapControl = <InspectorFlexWrap label={copy.wrap} wrapped={wrapping} disabled={disabled || wrap.mixed} onChange={next => { layout().setWrap(next ? 'wrap' : 'nowrap', ids) }} />
  const mainGapControl = <InspectorScrubField id="container-gap-main" label={axis === 'row' ? 'Horizontal gap' : axis === 'column' ? 'Vertical gap' : copy.gap} prefix={<Icon name="flex-row" />} value={shown(mainGap)} placeholder={mixedPlaceholder(mainGap)} min={0} max={limit} tokens={gapTokens} tokenLabel={copy.numericToken(copy.gap)} disabled={disabled} onCommit={value => setAxisGap('main', value)} />
  const crossGapControl = wrapping ? <InspectorScrubField id="container-gap-cross" label={axis === 'row' ? 'Vertical gap' : axis === 'column' ? 'Horizontal gap' : copy.gap} prefix={<Icon name="flex-row" />} value={shown(crossGap)} placeholder={mixedPlaceholder(crossGap)} min={0} max={limit} tokens={gapTokens} tokenLabel={copy.numericToken(copy.gap)} disabled={disabled} onCommit={value => setAxisGap('cross', value)} /> : undefined
  const overflowControl = <InspectorFlexOverflow label="More flex alignment options" mainLabel={overflowLabels.main} crossLabel={overflowLabels.cross} showCross={wrapping} mainChecked={!justify.mixed && justify.value === 'space-between'} crossChecked={wrapping && !alignContent.mixed && alignContent.value === 'space-between'} firstBaselineChecked={baselineValue === 'baseline'} lastBaselineChecked={baselineValue === 'last baseline'} disabled={disabled} onAction={overflow} />
  return <InspectorFlexPanel alignment={matrix} direction={directionControl} wrap={wrapControl} gap={mainGapControl} overflow={overflowControl} crossGap={crossGapControl} padding={<PaperFlexPadding context={context} />} />
}

function PaperFlexPadding({ context }: { context: FlexContext }) {
  const { nodes, disabled } = context
  const [individualDraft, setIndividualDraft] = useState(false)
  const values = nodes.map(node => node.layout?.spacing?.padding)
  const authoredIndividual = values.some(value => typeof value === 'object' && value !== null && 'top' in value)
  const unauthored = values.every(value => value === undefined)
  const individual = authoredIndividual || (unauthored && individualDraft)
  const sides = (node: LayoutNode): SpacingSides<number> => spacingSides(node.layout?.spacing?.padding ?? 0)
  const setPadding = (node: LayoutNode, padding: NonNullable<NodeSpacing['padding']>): NodeLayout => setSpacing(node.layout, { ...(node.layout?.spacing ?? {}), padding })
  const write = (next: (node: LayoutNode) => NonNullable<NodeSpacing['padding']>) => writeEach(nodes, next, setPadding)
  const changeMode = (next: boolean) => {
    setIndividualDraft(next)
    if (unauthored) return
    write(node => { const value = sides(node); return next ? value : { x: value.left, y: value.top } })
  }
  const field = (part: 'x' | 'y' | 'left' | 'top' | 'right' | 'bottom') => {
    const value = agree(nodes.map(node => { const value = sides(node); return part === 'x' || part === 'left' ? value.left : part === 'y' || part === 'top' ? value.top : value[part] }))
    const label = part === 'x' ? 'Horizontal padding' : part === 'y' ? 'Vertical padding' : `${part[0]!.toUpperCase()}${part.slice(1)} padding`
    const prefix = part === 'x' ? 'X' : part === 'y' ? 'Y' : part[0]!.toUpperCase()
    return <InspectorScrubField key={part} id={`flex-padding-${part}`} label={label} prefix={prefix} value={shown(value)} placeholder={mixedPlaceholder(value)} min={0} max={limit} tokens={context.numericTokens.filter(token => token.value >= 0)} tokenLabel={copy.numericToken(label)} disabled={disabled} onCommit={next => write(node => { const current = sides(node); if (part === 'x') return { x: next, y: current.top }; if (part === 'y') return { x: current.left, y: next }; return { ...current, [part]: next } })} />
  }
  const toggle = <InspectorFlexPaddingToggle label="Individual padding" individual={individual} disabled={disabled} onChange={changeMode} />
  return individual ? <>
    <InspectorRow>{field('left')}{field('top')}{toggle}</InspectorRow>
    <InspectorRow>{field('right')}{field('bottom')}<InspectorRowSpacer /></InspectorRow>
  </> : <InspectorRow>{field('x')}{field('y')}{toggle}</InspectorRow>
}

function GapControls({ context }: { context: ContainerContext }) {
  const { nodes, ids, disabled } = context
  const [splitDraft, setSplitDraft] = useState(false)
  const gaps = nodes.map(node => node.layout?.container?.gap)
  const split = gaps.some(gap => typeof gap === 'object') || (gaps.every(gap => gap === undefined) && splitDraft)
  const part = (key: 'x' | 'y') => agree(gaps.map(gap => typeof gap === 'object' ? gap[key] : gap))
  const columns = part('x'), rows = part('y')
  const tokens = context.numericTokens.filter(token => token.value >= 0)
  const withGap = (current: NodeLayout | undefined, gap: LayoutGap): NodeLayout | null => current?.container ? { ...current, container: { ...current.container, gap } } : null
  const own = (node: LayoutNode, key: 'x' | 'y') => { const gap = node.layout?.container?.gap; return typeof gap === 'object' ? gap[key] : gap ?? 0 }
  const writePart = (key: 'x' | 'y', value: number) => writeEach(nodes, node => ({ x: key === 'x' ? value : own(node, 'x'), y: key === 'y' ? value : own(node, 'y') }), (node, gap) => withGap(node.layout, gap) ?? node.layout!)
  const toggle = (next: boolean) => {
    if (gaps.every(gap => gap === undefined)) { setSplitDraft(next); return }
    setSplitDraft(next)
    if (next) writeEach(nodes, node => ({ x: own(node, 'x'), y: own(node, 'y') }), (node, gap) => withGap(node.layout, gap) ?? node.layout!)
    else writeEach(nodes, node => own(node, 'x'), (node, gap) => withGap(node.layout, gap) ?? node.layout!)
  }
  return <InspectorGroup label={copy.gap}>
    {split
      ? <InspectorRow>
        <InspectorScrubField id="container-gap-x" label={copy.columnGap} prefix={copy.prefixes.x} value={shown(columns)} placeholder={mixedPlaceholder(columns)} min={0} max={limit} tokens={tokens} tokenLabel={copy.numericToken(copy.columnGap)} disabled={disabled} onCommit={value => writePart('x', value)} onScrubStart={() => scrubSession(nodes, (current, value) => { const gap = current?.container?.gap; return withGap(current, { x: value, y: typeof gap === 'object' ? gap.y : gap ?? 0 }) })} />
        <InspectorScrubField id="container-gap-y" label={copy.rowGap} prefix={copy.prefixes.y} value={shown(rows)} placeholder={mixedPlaceholder(rows)} min={0} max={limit} tokens={tokens} tokenLabel={copy.numericToken(copy.rowGap)} disabled={disabled} onCommit={value => writePart('y', value)} onScrubStart={() => scrubSession(nodes, (current, value) => { const gap = current?.container?.gap; return withGap(current, { x: typeof gap === 'object' ? gap.x : gap ?? 0, y: value }) })} />
        <InspectorIconButton label={copy.joinGap} icon="block" disabled={disabled} onClick={() => toggle(false)} />
      </InspectorRow>
      : <InspectorRow>
        <InspectorScrubField id="container-gap" label={copy.gap} prefix={copy.prefixes.gap} value={shown(columns)} placeholder={mixedPlaceholder(columns)} min={0} max={limit} tokens={tokens} tokenLabel={copy.numericToken(copy.gap)} disabled={disabled} onCommit={value => { layout().setGap(value, ids) }} onClear={() => { layout().setGap(null, ids) }} onScrubStart={() => scrubSession(nodes, (current, value) => withGap(current, value))} />
        <InspectorIconButton label={copy.splitGap} icon="flex-row" disabled={disabled} onClick={() => toggle(true)} />
      </InspectorRow>}
  </InspectorGroup>
}

const overflowValues = ['visible', 'hidden', 'clip', 'auto', 'scroll'] as const
function OverflowControl({ context, containers }: { context: ComponentContext; containers: LayoutContainer[] }) {
  const overflow = agree(containers.map(container => container.overflow ?? null))
  return <InspectorGroup label={copy.overflow}><AppearanceSelect id="container-overflow" label={copy.overflow} value={overflow.mixed ? null : overflow.value ?? defaultOption} placeholder={copy.mixed} options={[{ value: defaultOption, label: copy.defaultValue }, ...overflowValues.map(value => ({ value, label: copy.overflows[value] }))]} disabled={context.disabled} onChange={value => { layout().setOverflow(value === defaultOption ? null : value as typeof overflowValues[number], context.ids) }} /></InspectorGroup>
}

function GridControls({ context, grids }: { context: ComponentContext; grids: GridContainer[] }) {
  const { file, ids, geometry, disabled } = context
  const autoFlow = agree(grids.map(entry => entry.autoFlow))
  const justifyItems = agree(grids.map(entry => entry.justifyItems ?? null))
  const alignItems = agree(grids.map(entry => entry.alignItems ?? null))
  const manual = agree(ids.map(id => grid().isManual(id)))
  const alignmentOptions = [{ value: defaultOption, label: copy.defaultValue }, ...itemAlignments.map(value => ({ value, label: copy.itemAlignments[value] }))]
  const pick = (value: string) => value === defaultOption ? null : value as ItemAlignment
  const [note, setNote] = useState<string | null>(null)
  const setManual = (next: 'auto' | 'manual') => {
    const notes = ids.flatMap(id => {
      const measured = measuredGrid(file, geometry, id)
      const unplaced = next === 'manual' && measured ? grid().measureCells(id, measured).unsupported.length : 0
      const written = grid().setManual(id, next === 'manual', measured)
      return [...(unplaced ? [copy.unplacedChildren(unplaced)] : []), ...(!written && next === 'auto' ? [copy.autoPlacementUnavailable] : [])]
    })
    setNote(notes.length ? [...new Set(notes)].join(' ') : null)
  }
  return <>
    <TrackList context={context} axis="columns" grids={grids} />
    <TrackList context={context} axis="rows" grids={grids} />
    <InspectorGroup label={copy.autoFlow}>
      <AppearanceSelect id="grid-auto-flow" label={copy.autoFlow} value={autoFlow.mixed ? null : autoFlow.value ?? null} placeholder={copy.mixed} options={(['row', 'column'] as const).map(value => ({ value, label: copy.autoFlows[value] }))} disabled={disabled} onChange={value => { grid().setAutoFlow(value as 'row' | 'column', ids) }} />
    </InspectorGroup>
    <InspectorGroup label={copy.alignment}>
      <InspectorRow>
        <AppearanceSelect id="grid-justify-items" label={copy.justifyItems} value={justifyItems.mixed ? null : justifyItems.value ?? defaultOption} placeholder={copy.mixed} options={alignmentOptions} disabled={disabled} onChange={value => { grid().setAlignment({ justifyItems: pick(value) }, ids) }} />
        <AppearanceSelect id="grid-align-items" label={copy.alignItems} value={alignItems.mixed ? null : alignItems.value ?? defaultOption} placeholder={copy.mixed} options={alignmentOptions} disabled={disabled} onChange={value => { grid().setAlignment({ alignItems: pick(value) }, ids) }} />
      </InspectorRow>
    </InspectorGroup>
    <InspectorGroup label={copy.placement}>
      <InspectorRadioGroup label={copy.placement} value={manual.mixed ? null : manual.value ? 'manual' : 'auto'} disabled={disabled} options={[{ value: 'auto', label: copy.placements.auto }, { value: 'manual', label: copy.placements.manual }]} onChange={setManual} />
      {note !== null && <InspectorNote icon="alert">{note}</InspectorNote>}
    </InspectorGroup>
  </>
}

function TrackList({ context, axis, grids }: { context: ComponentContext; axis: GridAxis; grids: GridContainer[] }) {
  const { ids, disabled } = context
  const [error, setError] = useState<string | null>(null)
  const tracks = agree(grids.map(entry => entry[axis]))
  const minimum = Math.max(1, ...ids.map(id => grid().minimumTracks(id, axis)))
  const list = tracks.value ?? []
  const edit = (index: number, text: string) => {
    const parsed = parseGridTemplate(text)
    if (!parsed.ok) { setError(parsed.error); return }
    const next: GridTrack[] = [...list.slice(0, index), ...parsed.tracks, ...list.slice(index + 1)]
    if (next.length > maxGridTracks) { setError(copy.mixedTracks); return }
    setError(null)
    grid().setTracks(axis, next, ids)
  }
  return <InspectorGroup label={copy.gridAxes[axis]}>
    {tracks.mixed && <InspectorNote>{copy.mixedTracks}</InspectorNote>}
    {!tracks.mixed && list.map((track, index) => {
      const number = index + 1
      const text = tracksToCss([track])
      return <InspectorTrackRow key={`${number}-${text}`} label={copy.gridTrack(axis, number)} index={number} disabled={disabled}
        field={<InspectorTextField id={`grid-${axis}-${number}`} label={copy.gridTrack(axis, number)} value={text} disabled={disabled} onCommit={value => edit(index, value)} />}
        earlierLabel={copy.moveTrackEarlier(axis, number)} laterLabel={copy.moveTrackLater(axis, number)} removeLabel={copy.removeTrack(axis, number)}
        canEarlier={index > 0} canLater={index < list.length - 1} canRemove={list.length > minimum}
        onEarlier={() => { grid().moveTrack(axis, number, number - 1, ids) }} onLater={() => { grid().moveTrack(axis, number, number + 1, ids) }} onRemove={() => { grid().removeTrack(axis, number, ids) }} />
    })}
    {error !== null && <InspectorAlert id={`grid-${axis}-error`}>{error}</InspectorAlert>}
    <InspectorTextButton label={copy.addTrack(axis)} icon="plus" disabled={disabled || list.length >= maxGridTracks} onClick={() => { setError(null); grid().addTrack(axis, ids) }} />
  </InspectorGroup>
}

// Item in a Flex or Grid parent -----------------------------------------------------------------------------------------

function ItemSection({ context }: { context: ComponentContext }) {
  const { file, ids } = context
  const parents = agree(ids.map(id => { const parentId = file.relationships[id]?.parentId; return parentId ? layoutOf(file, parentId)?.container?.display ?? null : null }))
  if (parents.mixed) return null
  if (parents.value === 'flex') return null
  if (parents.value === 'grid') return <GridItemSection context={context} />
  return null
}

function GridItemSection({ context }: { context: ComponentContext }) {
  const { nodes, ids, disabled } = context
  const items = nodes.map(node => node.layout?.item.grid ?? {})
  const field = (key: 'columnStart' | 'columnSpan' | 'rowStart' | 'rowSpan') => agree(items.map(item => item[key]))
  const alignment = (key: 'justifySelf' | 'alignSelf') => agree(items.map(item => item[key] ?? null))
  const place = (patch: { [K in keyof GridItem]?: GridItem[K] | null }) => { grid().setPlacement(patch, ids) }
  const number = (key: 'columnStart' | 'columnSpan' | 'rowStart' | 'rowSpan', label: string, prefix: string) => {
    const value = field(key)
    return <InspectorScrubField id={`item-${key}`} label={label} prefix={prefix} value={shown(value)} placeholder={mixedPlaceholder(value)} min={1} max={1000} disabled={disabled} onCommit={next => place({ [key]: next })} onClear={() => place({ [key]: null })} />
  }
  const options = [{ value: defaultOption, label: copy.defaultValue }, ...itemAlignments.map(value => ({ value, label: copy.itemAlignments[value] }))]
  const select = (key: 'justifySelf' | 'alignSelf', label: string) => {
    const value = alignment(key)
    return <AppearanceSelect id={`item-${key}`} label={label} value={value.mixed ? null : value.value ?? defaultOption} placeholder={copy.mixed} options={options} disabled={disabled} onChange={next => place({ [key]: next === defaultOption ? null : next as ItemAlignment })} />
  }
  return <InspectorSection id="layout-item" title={copy.gridItem}>
    <InspectorRow>{number('columnStart', copy.columnStart, copy.prefixes.start)}{number('columnSpan', copy.columnSpan, copy.prefixes.span)}</InspectorRow>
    <InspectorRow>{number('rowStart', copy.rowStart, copy.prefixes.start)}{number('rowSpan', copy.rowSpan, copy.prefixes.span)}</InspectorRow>
    <InspectorRow>{select('justifySelf', copy.justifySelf)}{select('alignSelf', copy.alignSelf)}</InspectorRow>
  </InspectorSection>
}

// Spacing -------------------------------------------------------------------------------------------------------------

type SpacingKind = 'padding' | 'margin'
type SpacingMode = 'all' | 'axes' | 'sides'
type SpacingPart = 'all' | 'x' | 'y' | 'top' | 'right' | 'bottom' | 'left'
type Side = number | 'auto'
const partsOf: Record<SpacingMode, readonly SpacingPart[]> = { all: ['all'], axes: ['x', 'y'], sides: ['top', 'right', 'bottom', 'left'] }
const shapeOf = (value: unknown): SpacingMode | undefined => value === undefined ? undefined : typeof value === 'object' && value !== null ? ('x' in value ? 'axes' : 'sides') : 'all'
/** Reads one part of a stored value as the shape `mode` would present it (axes read left/top, all reads top). */
function partOf(sides: SpacingSides<Side>, part: SpacingPart): Side {
  switch (part) {
    case 'all': case 'y': case 'top': return sides.top
    case 'x': case 'left': return sides.left
    case 'right': return sides.right
    case 'bottom': return sides.bottom
  }
}
/** The stored form of four sides in a mode, with one part replaced. */
function shaped(sides: SpacingSides<Side>, mode: SpacingMode, part?: SpacingPart, value?: Side): Side | { x: Side; y: Side } | SpacingSides<Side> {
  if (mode === 'all') return part ? value! : sides.top
  if (mode === 'axes') { const next = { x: sides.left, y: sides.top }; if (part === 'x' || part === 'y') next[part] = value!; return next }
  const next = { ...sides }
  if (part === 'top' || part === 'right' || part === 'bottom' || part === 'left') next[part] = value!
  return next
}

function SpacingSection({ context }: { context: ComponentContext }) {
  return <InspectorSection id="spacing" title={copy.spacing}>
    <SpacingGroup context={context} kind="padding" />
    <SpacingGroup context={context} kind="margin" />
  </InspectorSection>
}

function SpacingGroup({ context, kind }: { context: ContainerContext; kind: SpacingKind }) {
  const { nodes, ids, geometry, disabled } = context
  const [modeDraft, setModeDraft] = useState<SpacingMode>('all')
  const values = nodes.map(node => node.layout?.spacing?.[kind])
  const shapes = agree(values.map(shapeOf))
  const unauthored = values.every(value => value === undefined)
  const mode: SpacingMode | null = unauthored ? modeDraft : shapes.mixed ? null : shapes.value ?? modeDraft
  const kindLabel = kind === 'padding' ? copy.padding : copy.margin
  // Unauthored padding starts from what the component renders, so editing one side keeps the others where they are.
  const baseSides = (node: LayoutNode): SpacingSides<Side> => {
    const value = node.layout?.spacing?.[kind]
    if (value !== undefined) return spacingSides<MarginSide>(value as MarginSide | { x: MarginSide; y: MarginSide } | SpacingSides<MarginSide>)
    const measured = kind === 'padding' ? geometry.nodes[node.id]?.box?.padding : undefined
    return measured ? { top: Math.round(measured.top), right: Math.round(measured.right), bottom: Math.round(measured.bottom), left: Math.round(measured.left) } : { top: 0, right: 0, bottom: 0, left: 0 }
  }
  const spacingWith = (node: LayoutNode, value: unknown): NodeSpacing => {
    const current = node.layout?.spacing ?? {}
    const next: NodeSpacing = { ...current }
    if (value === undefined) delete next[kind]
    else if (kind === 'padding') next.padding = value as NonNullable<NodeSpacing['padding']>
    else next.margin = value as NonNullable<NodeSpacing['margin']>
    return next
  }
  const write = (next: (node: LayoutNode) => NodeSpacing) => writeEach(nodes, next, (node, spacing) => setSpacing(node.layout, spacing))
  const changeMode = (next: SpacingMode) => {
    setModeDraft(next)
    if (unauthored) return
    write(node => spacingWith(node, shaped(baseSides(node), next)))
  }
  const writePart = (part: SpacingPart, value: Side) => write(node => spacingWith(node, shaped(baseSides(node), mode ?? 'all', part, value)))
  const clear = () => write(node => spacingWith(node, undefined))
  const field = (part: SpacingPart) => {
    const raw = agree(nodes.map(node => node.layout?.spacing?.[kind] === undefined ? undefined : partOf(baseSides(node), part)))
    const auto = !raw.mixed && raw.value === 'auto'
    const number: Agreement<number | undefined> = raw.mixed ? { mixed: true, value: undefined } : { mixed: false, value: typeof raw.value === 'number' ? raw.value : undefined }
    const label = copy.spacingField(kindLabel, copy.spacingParts[part])
    const prefix = part === 'all' ? copy.prefixes.all : part === 'x' ? copy.prefixes.x : part === 'y' ? copy.prefixes.y : part === 'top' ? copy.prefixes.top : part === 'right' ? copy.prefixes.right : part === 'bottom' ? copy.prefixes.bottom : copy.prefixes.left
    const tokens = context.numericTokens.filter(token => kind === 'margin' || token.value >= 0)
    const input = <InspectorScrubField key={part} id={`spacing-${kind}-${part}`} label={label} prefix={prefix} value={shown(number)} placeholder={auto ? copy.autoValue : mixedPlaceholder(number)} min={kind === 'margin' ? -limit : 0} max={limit} tokens={tokens} tokenLabel={copy.numericToken(label)} disabled={disabled || auto} onCommit={value => writePart(part, value)} {...(part === 'all' ? { onClear: clear } : {})} onScrubStart={() => scrubSession(nodes, (current, value, node) => setSpacing(current, spacingWith(node, shaped(baseSides(node), mode ?? 'all', part, value))))} />
    if (kind === 'padding') return input
    return <InspectorRow key={part} lead>{input}<InspectorCheck id={`spacing-margin-${part}-auto`} label={copy.marginAuto(copy.spacingParts[part])} checked={auto} disabled={disabled} onChange={checked => writePart(part, checked ? 'auto' : 0)} /></InspectorRow>
  }
  const parts = mode ? partsOf[mode] : []
  const pairs = [parts.slice(0, 2), parts.slice(2, 4)].filter(pair => pair.length > 0)
  return <InspectorGroup>
    <InspectorSpacingHeading label={kindLabel} control={<InspectorSpacingMode label={copy.spacingMode(kindLabel)} value={mode} labels={copy.spacingModes} disabled={disabled} onChange={changeMode} />} />
    {kind === 'padding'
      ? pairs.map(pair => <InspectorRow key={pair.join('-')}>{pair.map(field)}{pair.length === 1 && <InspectorRowSpacer />}</InspectorRow>)
      : parts.map(field)}
  </InspectorGroup>
}
