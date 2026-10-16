/**
 * Projection of one page onto the preview wire format: component instances with slot children, primitives flattened
 * with parent-local positions, and every fill resolved to CSS against the file theme and the active design palette.
 */
import type { DocumentValue, DocumentNodeLayout } from './document.js'
import { containerDisplay, isLegacyOnlyLayout, legacyLayout, projectContainerStyle, projectItemStyle, projectSpacingStyle } from './layout.js'
import { fallbackScheme, nodeThemeMode, resolveEffectiveNodeTheme, resolveThemeForMode } from './node-theme.js'
import type { ColorScheme } from './node-theme.js'
import { defaultDesignThemeId, resolveDesignTheme } from './design-themes.js'
import type { DesignTheme } from './design-themes.js'
import { colorToCss } from './color.js'
import type { LayoutContainer, NodeLayout, ParentLayoutContext, PositionMode } from './layout.js'
import { assetReferences, childrenOf, flowHost, hostOrigin, nodeAppearance, nodeChildDisplay, pageRoot, projectAppearance, resolveColorValue } from './file-document.js'
import type { FileDocument, ImageAssetReference, PreviewAppearance, SourcePalette } from './file-document.js'
import type { TextSizing, TextStyle } from './text.js'
import { componentDefaultValues, resolveComponentInstanceValues, resolveVariantAppearance } from './component-model.js'
import type { Appearance } from './appearance.js'

/** The effective design theme of one component instance; `explicit` marks the root where the runtime stamps the attribute. */
export type PreviewNodeTheme = { mode: ColorScheme; designThemeId: string; attribute: string | null; colorScheme: ColorScheme; explicit: boolean }
export type PreviewPageNode = { id: string; componentId: string; exportName: string; name?: string; props: Record<string, DocumentValue>; children: Record<string, string[]>; appearance?: PreviewAppearance; theme: PreviewNodeTheme }
/** Design themes, the file's preview choice, and a palette per concrete theme; the projection resolves every node against its own effective theme. */
export type ThemeProjectionContext = { themes: readonly DesignTheme[]; previewThemeId: string | null; palette: (theme: DesignTheme) => SourcePalette }
/** `base-theme-inside-attribute`: the override maps to the base theme (no attribute), but it sits inside an attributed theme whose custom properties keep inheriting; the stylesheet has no selector that resets them. */
export type ThemeDiagnostic = { nodeId: string; reason: 'missing-theme' | 'ambiguous-theme' | 'cycle' | 'missing-node' | 'base-theme-inside-attribute'; candidates?: string[] }
const isThemeContext = (value: SourcePalette | ThemeProjectionContext): value is ThemeProjectionContext => typeof (value as ThemeProjectionContext).palette === 'function' && Array.isArray((value as ThemeProjectionContext).themes)
const baseTheme: DesignTheme = { id: defaultDesignThemeId, name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' }
export type PreviewPrimitiveLayout = { mode: PositionMode; declarations: Record<string, string> }
export type PreviewPageInteraction = { trigger: 'pointer-hover' | 'pointer-press'; targetId: string; appearance: PreviewAppearance; transition?: { type: 'instant' | 'smart-animate'; durationMs?: number; easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' } }
export type PreviewPageElement = { id: string; kind: 'frame' | 'rectangle' | 'shape' | 'shader' | 'text'; name: string; relativeTransform: readonly [number, number, number, number, number, number]; width: number; height: number; text?: string; textStyle?: TextStyle; textSizing?: TextSizing; parentId: string | null; clip?: boolean; appearance?: PreviewAppearance; interactions?: PreviewPageInteraction[]; layout?: PreviewPrimitiveLayout }
export type PreviewPageAsset = Omit<ImageAssetReference, 'id'>
export type PreviewPageDocument = { version: 3; revision: number; rootIds: string[]; nodes: Record<string, PreviewPageNode>; frame: { name?: string; width: number; height: number; direction: 'column' | 'row'; gap: number; padding: number; clip: boolean }; canvas: { elements: PreviewPageElement[] }; background?: string; assets?: Record<string, PreviewPageAsset> }
export type PreviewLayoutEntry = { nodeId: string; mode: DocumentNodeLayout['mode']; x: number; y: number; order: number; width?: number; height?: number; declarations?: Record<string, string> }
const kebab = (name: string) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
const componentProps = (file: FileDocument, nodeId: string, stored: Record<string, DocumentValue>): Record<string, DocumentValue> => {
  const instance = file.componentModel.instances[nodeId]
  const definition = instance ? file.componentModel.definitions[instance.componentId] : undefined
  if (!instance || !definition) return structuredClone(stored)
  const resolved = resolveComponentInstanceValues(definition, instance.values)
  const projected = { ...stored }
  for (const property of definition.properties) {
    if (property.type === 'slot' || property.type === 'instance-swap') continue
    projected[property.name] = resolved[property.id]!
  }
  return projected
}
/**
 * Layout longhands for one node as kebab-case declarations. Nodes that carry only the five-field placement send none,
 * so documents authored before schema v4 reach the runtime unchanged; px insets and px sizes travel in the placement
 * fields (the runtime positions roots against the host origin), everything else travels here.
 */
const parentContext = (container: LayoutContainer | null): ParentLayoutContext | null => {
  if (!container) return null
  if (container.display !== 'flex') return { display: container.display }
  return {
    display: container.display,
    ...(container.flex?.direction ? { flexDirection: container.flex.direction } : {}),
    ...(container.flex?.alignContent ? { flexAlignContent: container.flex.alignContent } : {}),
  }
}

export function layoutDeclarations(layout: NodeLayout | undefined, parentContainer: LayoutContainer | null, origin: { x: number; y: number } | null = null): Record<string, string> | undefined {
  if (!layout || (isLegacyOnlyLayout(layout) && parentContainer === null)) return undefined
  const projection = { ...projectContainerStyle(layout.container), ...projectItemStyle(layout.item, parentContext(parentContainer)), ...projectSpacingStyle(layout.spacing) }
  const { position } = layout.item
  if (position.mode === 'absolute') {
    projection.position = null
    // Root children author world coordinates; the host sits at the frame origin, so px insets shift by it (the runtime does the same for the five-field placement).
    if (origin && position.left?.kind === 'px') projection.left = `${position.left.value - origin.x}px`
    if (origin && position.top?.kind === 'px') projection.top = `${position.top.value - origin.y}px`
  }
  if (layout.item.width?.value.kind === 'px') projection.width = null
  if (layout.item.height?.value.kind === 'px') projection.height = null
  const declarations = Object.fromEntries(Object.entries(projection).filter((entry): entry is [string, string] => entry[1] !== null).map(([name, value]) => [kebab(name), value]))
  return Object.keys(declarations).length ? declarations : undefined
}

/**
 * Projected primitive layout is self-contained on the primitive DOM node. Unlike imported component placement, it
 * does not strip absolute position because there is no separate layout layer owning those declarations. The numeric
 * element width/height remain the measured fixed fallback; when a primitive authors a semantic non-px axis here,
 * these declarations are applied after that fallback and therefore own the rendered axis. Missing layout stays absent
 * so v8 freeform documents retain their exact legacy absolute rendering path.
 */
export function primitiveLayoutProjection(layout: NodeLayout | undefined, parentContainer: LayoutContainer | null, textSizing?: TextSizing): PreviewPrimitiveLayout | undefined {
  if (!layout && !textSizing) return undefined
  if (!layout && textSizing && textSizing.width.mode !== 'fill' && textSizing.width.mode !== 'relative' && textSizing.height.mode !== 'fill' && textSizing.height.mode !== 'relative') return undefined
  const source = layout ?? { item: { position: { mode: 'freeform' as const } } }
  const item = structuredClone(source.item)
  if (textSizing) for (const axis of ['width', 'height'] as const) {
    const sizing = textSizing[axis]
    if (sizing.mode === 'fill') item[axis] = { value: { kind: 'percent', value: 100 } }
    else if (sizing.mode === 'relative') item[axis] = { value: { kind: 'percent', value: sizing.value } }
  }
  const projection = { ...projectContainerStyle(source.container), ...projectItemStyle(item, parentContext(parentContainer)), ...projectSpacingStyle(source.spacing) }
  const declarations = Object.fromEntries(Object.entries(projection).filter((entry): entry is [string, string] => entry[1] !== null).map(([name, value]) => [kebab(name), value]))
  if (!layout && Object.keys(declarations).length === 0) return undefined
  return { mode: source.item.position.mode, declarations }
}
export type PreviewProjection = { document: PreviewPageDocument; layout: PreviewLayoutEntry[]; themeDiagnostics: ThemeDiagnostic[] }

/**
 * Effective theme of one node for projection: the concrete design theme its scheme maps to (or the file fallback with a
 * diagnostic when the scheme is missing or ambiguous) and the palette that resolves its source-backed tokens.
 */
export function nodeThemeProjection(file: FileDocument, nodeId: string, context: SourcePalette | ThemeProjectionContext): { theme: PreviewNodeTheme; palette: SourcePalette; diagnostic: ThemeDiagnostic | null } {
  if (!isThemeContext(context)) {
    const node = file.nodes[nodeId]
    const effective = resolveEffectiveNodeTheme(file, nodeId, 'light')
    return { theme: { mode: effective.mode, designThemeId: defaultDesignThemeId, attribute: null, colorScheme: effective.mode, explicit: effective.source.kind === 'self' && nodeThemeMode(node) !== 'inherit' }, palette: context, diagnostic: effective.diagnostic ? { nodeId, reason: effective.diagnostic } : null }
  }
  const fallbackTheme = context.themes.length ? resolveDesignTheme(context.themes, context.previewThemeId) : baseTheme
  const effective = resolveEffectiveNodeTheme(file, nodeId, fallbackScheme(context.themes, context.previewThemeId))
  let theme = fallbackTheme
  let diagnostic: ThemeDiagnostic | null = effective.diagnostic ? { nodeId, reason: effective.diagnostic } : null
  if (effective.source.kind !== 'fallback') {
    const resolved = resolveThemeForMode(context.themes, context.previewThemeId, effective.mode)
    if (resolved.status === 'resolved') theme = resolved.theme
    else diagnostic = resolved.status === 'missing' ? { nodeId, reason: 'missing-theme' } : { nodeId, reason: 'ambiguous-theme', candidates: resolved.candidates }
  }
  if (!diagnostic && effective.source.kind === 'self' && theme.attribute === null) {
    // The nearest explicit ancestor (or the file fallback) decides which attribute the DOM subtree already carries.
    const parentId = file.relationships[nodeId]?.parentId
    const above = parentId === undefined ? null : resolveEffectiveNodeTheme(file, parentId, fallbackScheme(context.themes, context.previewThemeId))
    const aboveTheme = above && above.source.kind !== 'fallback' ? resolveThemeForMode(context.themes, context.previewThemeId, above.mode) : null
    const inherited = aboveTheme ? (aboveTheme.status === 'resolved' ? aboveTheme.theme : null) : fallbackTheme
    if (inherited && inherited.attribute !== null) diagnostic = { nodeId, reason: 'base-theme-inside-attribute' }
  }
  return { theme: { mode: theme.colorScheme, designThemeId: theme.id, attribute: theme.attribute, colorScheme: theme.colorScheme, explicit: effective.source.kind === 'self' }, palette: context.palette(theme), diagnostic }
}

export function projectPreviewPage(file: FileDocument, pageId: string, context: SourcePalette | ThemeProjectionContext = {}): PreviewProjection | null {
  const root = pageRoot(file, pageId)
  const page = file.pages.find(candidate => candidate.id === pageId)
  if (!root || !page) return null
  const themeDiagnostics: ThemeDiagnostic[] = []
  const themeOf = (id: string) => { const projected = nodeThemeProjection(file, id, context); if (projected.diagnostic) themeDiagnostics.push(projected.diagnostic); return projected }
  const nodes: Record<string, PreviewPageNode> = {}
  const elements: PreviewPageElement[] = []
  const layout: PreviewLayoutEntry[] = []
  const assets: Record<string, PreviewPageAsset> = {}
  const pagePalette = isThemeContext(context)
    ? context.palette(context.themes.length ? resolveDesignTheme(context.themes, context.previewThemeId) : baseTheme)
    : context
  const resolvedBackground = page.background ? resolveColorValue(file.theme, page.background, pagePalette) : null
  const hasAsset = (assetId: string) => Boolean(file.assets?.[assetId])
  const registerAppearanceAssets = (source: Appearance | undefined) => {
    if (!source) return
    for (const assetId of assetReferences(source)) {
      const asset = file.assets?.[assetId]
      if (asset) {
        assets[assetId] = {
          name: asset.name,
          mime: asset.mime,
          extension: asset.extension,
          bytes: asset.bytes,
          width: asset.width,
          height: asset.height,
          sha256: asset.sha256,
        }
      }
    }
  }
  const projectedAppearance = (source: Appearance | undefined, sources: SourcePalette): PreviewAppearance | undefined => {
    const projected = projectAppearance(source, value => resolveColorValue(file.theme, value, sources), hasAsset)
    registerAppearanceAssets(source)
    return projected
  }
  const authoredAppearances = new Map<string, Appearance>()
  const appearanceOf = (id: string, sources: SourcePalette): { appearance: PreviewAppearance } | Record<string, never> => {
    const projected = projectedAppearance(authoredAppearances.get(id) ?? nodeAppearance(file.nodes[id]), sources)
    return projected ? { appearance: projected } : {}
  }
  type AuthoredInteraction = Readonly<{ trigger: 'pointer-hover' | 'pointer-press'; targetId: string; appearance: Appearance; transition?: { type: 'instant' | 'smart-animate'; durationMs?: number; easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' } }>
  const authoredInteractions = new Map<string, AuthoredInteraction[]>()
  const addDefinitionProjection = (definition: FileDocument['componentModel']['definitions'][string], masterRootId: string, instanceRootId: string, values: Readonly<Record<string, string | boolean>>) => {
    const nodeMap = new Map<string, string>()
    const swapByNode = new Map(definition.properties.flatMap(property => property.type === 'instance-swap' ? [[property.binding.nodeId, property] as const] : []))
    const visit = (masterId: string, instanceId: string): boolean => {
      const master = file.nodes[masterId]
      const instance = file.nodes[instanceId]
      if (!master || !instance) return false
      const swap = swapByNode.get(masterId)
      const swapValue = swap && typeof values[swap.id] === 'string' ? values[swap.id] : swap?.defaultValue
      if (swap && swapValue !== swap.defaultValue) return file.componentModel.instances[instanceId]?.componentId === swapValue
      if (master.type !== instance.type) return false
      nodeMap.set(masterId, instanceId)
      const masterChildren = childrenOf(file, masterId).filter(nodeId => file.relationships[nodeId]?.slot === undefined)
      const instanceChildren = childrenOf(file, instanceId).filter(nodeId => file.relationships[nodeId]?.slot === undefined)
      if (masterChildren.length !== instanceChildren.length) return false
      return masterChildren.every((masterChild, index) => file.relationships[masterChild]?.slot === file.relationships[instanceChildren[index]!]?.slot && visit(masterChild, instanceChildren[index]!))
    }
    if (!visit(masterRootId, instanceRootId)) return
    const targetNodeIds = new Set(definition.properties.flatMap(property => property.type === 'variant' && property.binding ? [property.binding.nodeId] : []))
    for (const targetNodeId of targetNodeIds) {
      const nodeId = nodeMap.get(targetNodeId)
      const appearance = resolveVariantAppearance(definition, values, targetNodeId)
      if (nodeId && appearance) authoredAppearances.set(nodeId, appearance)
    }
    for (const interaction of definition.interactions) {
      const property = definition.properties.find(candidate => candidate.id === interaction.propertyId)
      if (property?.type !== 'variant' || !property.binding) continue
      const nodeId = nodeMap.get(property.binding.nodeId)
      const appearance = resolveVariantAppearance(definition, { ...values, [property.id]: interaction.valueId }, property.binding.nodeId)
      if (!nodeId || !appearance) continue
      const existing = authoredInteractions.get(instanceRootId) ?? []
      const authored: AuthoredInteraction = { trigger: interaction.trigger, targetId: nodeId, appearance, ...(interaction.transition ? { transition: interaction.transition } : {}) }
      authoredInteractions.set(instanceRootId, [...existing.filter(candidate => candidate.trigger !== authored.trigger), authored])
    }
  }
  for (const definition of Object.values(file.componentModel.definitions)) {
    if (definition.source.kind !== 'canvas') continue
    const masterValues = { ...componentDefaultValues(definition) }
    for (const property of definition.properties) if (property.type === 'variant' && property.currentValueId !== undefined) masterValues[property.id] = property.currentValueId
    addDefinitionProjection(definition, definition.source.masterRootId, definition.source.masterRootId, masterValues)
    for (const instance of Object.values(file.componentModel.instances)) if (instance.componentId === definition.id) addDefinitionProjection(definition, definition.source.masterRootId, instance.id, resolveComponentInstanceValues(definition, instance.values))
  }
  const interactionsOf = (id: string, sources: SourcePalette): { interactions: PreviewPageInteraction[] } | Record<string, never> => {
    const interactions = authoredInteractions.get(id)?.map(interaction => ({
      trigger: interaction.trigger,
      targetId: interaction.targetId,
      appearance: projectedAppearance(interaction.appearance, sources) ?? {},
      ...(interaction.transition ? { transition: interaction.transition } : {}),
    }))
    return interactions?.length ? { interactions } : {}
  }
  const visitComponent = (id: string, order: number, parentContainer: LayoutContainer | null) => {
    const node = file.nodes[id]
    if (!node || node.type !== 'component') return
    const ownContainer = node.layout?.container ?? null
    const children: Record<string, string[]> = {}
    const slotOrders = new Map<string, number>()
    for (const childId of childrenOf(file, id)) {
      const slot = file.relationships[childId]?.slot
      if (!slot) continue
      ;(children[slot] ??= []).push(childId)
      const childOrder = slotOrders.get(slot) ?? 0
      slotOrders.set(slot, childOrder + 1)
      visitComponent(childId, childOrder, ownContainer)
    }
    const themed = themeOf(id)
    nodes[id] = { id, componentId: node.componentId, exportName: node.exportName, props: componentProps(file, id, node.props), children, ...(node.name !== undefined ? { name: node.name } : {}), ...appearanceOf(id, themed.palette), theme: themed.theme }
    const placement = legacyLayout(node.layout)
    const declarations = layoutDeclarations(node.layout, parentContainer, parentContainer === null && file.relationships[id]?.parentId === root ? hostOrigin(flowHost) : null)
    layout.push({ nodeId: id, mode: placement.mode, x: placement.x, y: placement.y, order, ...(placement.width !== undefined ? { width: placement.width } : {}), ...(placement.height !== undefined ? { height: placement.height } : {}), ...(declarations ? { declarations } : {}) })
  }
  const visitPrimitive = (id: string, parentId: string | null, parentContainer: LayoutContainer | null) => {
    const node = file.nodes[id]
    if (!node || node.type === 'root' || node.type === 'component') return
    const primitiveLayout = primitiveLayoutProjection(node.layout, parentContainer, node.type === 'text' ? node.textSizing : undefined)
    const themed = themeOf(id)
    elements.push({
      id, kind: node.type, name: node.name, relativeTransform: node.styles.relativeTransform, width: node.styles.width, height: node.styles.height,
      parentId, ...appearanceOf(id, themed.palette), ...interactionsOf(id, themed.palette),
      ...(node.type === 'text' ? { text: node.text ?? '', textStyle: structuredClone(node.textStyle!), textSizing: structuredClone(node.textSizing!) } : {}),
      ...(node.type === 'frame' ? { clip: node.styles.overflow !== 'visible' } : {}),
      ...(primitiveLayout ? { layout: primitiveLayout } : {}),
    })
    const childContainer = node.layout?.container ?? (node.type === 'frame' ? { display: nodeChildDisplay(node) } as LayoutContainer : null)
    for (const childId of childrenOf(file, id)) visitPrimitive(childId, id, childContainer)
  }
  const rootIds: string[] = []
  let componentOrder = 0
  for (const childId of childrenOf(file, root)) {
    const child = file.nodes[childId]
    if (child?.type === 'component') { rootIds.push(childId); visitComponent(childId, componentOrder++, null) }
    else visitPrimitive(childId, null, null)
  }
  return { document: { version: 3, revision: file.revision, rootIds, nodes, frame: { ...flowHost, name: page.name }, canvas: { elements }, ...(resolvedBackground ? { background: colorToCss(resolvedBackground) } : {}), ...(Object.keys(assets).length ? { assets } : {}) }, layout, themeDiagnostics }
}
