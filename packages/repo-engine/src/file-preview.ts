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
import type { DisplayMode, NodeLayout, PositionMode } from './layout.js'
import { assetReferences, childrenOf, flowHost, hostOrigin, nodeAppearance, nodeChildDisplay, pageRoot, projectAppearance, resolveColorValue } from './file-document.js'
import type { FileDocument, ImageAssetReference, PreviewAppearance, SourcePalette } from './file-document.js'
import type { TextSizing, TextStyle } from './text.js'

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
export type PreviewPageElement = { id: string; kind: 'frame' | 'rectangle' | 'shape' | 'shader' | 'text'; name: string; x: number; y: number; width: number; height: number; rotation: number; flipX?: boolean; flipY?: boolean; text?: string; textStyle?: TextStyle; textSizing?: TextSizing; parentId: string | null; clip?: boolean; appearance?: PreviewAppearance; layout?: PreviewPrimitiveLayout }
export type PreviewPageAsset = Omit<ImageAssetReference, 'id'>
export type PreviewPageDocument = { version: 2; revision: number; rootIds: string[]; nodes: Record<string, PreviewPageNode>; frame: { name?: string; width: number; height: number; direction: 'column' | 'row'; gap: number; padding: number; clip: boolean }; canvas: { elements: PreviewPageElement[] }; background?: string; assets?: Record<string, PreviewPageAsset> }
export type PreviewLayoutEntry = { nodeId: string; mode: DocumentNodeLayout['mode']; x: number; y: number; order: number; width?: number; height?: number; declarations?: Record<string, string> }
const kebab = (name: string) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
/**
 * Layout longhands for one node as kebab-case declarations. Nodes that carry only the five-field placement send none,
 * so documents authored before schema v4 reach the runtime unchanged; px insets and px sizes travel in the placement
 * fields (the runtime positions roots against the host origin), everything else travels here.
 */
export function layoutDeclarations(layout: NodeLayout | undefined, parentDisplay: DisplayMode | null, origin: { x: number; y: number } | null = null): Record<string, string> | undefined {
  if (!layout || (isLegacyOnlyLayout(layout) && parentDisplay === null)) return undefined
  const projection = { ...projectContainerStyle(layout.container), ...projectItemStyle(layout.item, parentDisplay), ...projectSpacingStyle(layout.spacing) }
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
export function primitiveLayoutProjection(layout: NodeLayout | undefined, parentDisplay: DisplayMode | null): PreviewPrimitiveLayout | undefined {
  if (!layout) return undefined
  const projection = { ...projectContainerStyle(layout.container), ...projectItemStyle(layout.item, parentDisplay), ...projectSpacingStyle(layout.spacing) }
  const declarations = Object.fromEntries(Object.entries(projection).filter((entry): entry is [string, string] => entry[1] !== null).map(([name, value]) => [kebab(name), value]))
  return { mode: layout.item.position.mode, declarations }
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
  const appearanceOf = (id: string, sources: SourcePalette): { appearance: PreviewAppearance } | Record<string, never> => {
    const source = nodeAppearance(file.nodes[id])
    const projected = projectAppearance(source, value => resolveColorValue(file.theme, value, sources), hasAsset)
    if (source) for (const assetId of assetReferences(source)) {
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
    return projected ? { appearance: projected } : {}
  }
  const visitComponent = (id: string, order: number, parentDisplay: DisplayMode | null) => {
    const node = file.nodes[id]
    if (!node || node.type !== 'component') return
    const ownDisplay = containerDisplay(node.layout)
    const children: Record<string, string[]> = {}
    const slotOrders = new Map<string, number>()
    for (const childId of childrenOf(file, id)) {
      const slot = file.relationships[childId]?.slot
      if (!slot) continue
      ;(children[slot] ??= []).push(childId)
      const childOrder = slotOrders.get(slot) ?? 0
      slotOrders.set(slot, childOrder + 1)
      visitComponent(childId, childOrder, ownDisplay)
    }
    const themed = themeOf(id)
    nodes[id] = { id, componentId: node.componentId, exportName: node.exportName, props: structuredClone(node.props), children, ...(node.name !== undefined ? { name: node.name } : {}), ...appearanceOf(id, themed.palette), theme: themed.theme }
    const placement = legacyLayout(node.layout)
    const declarations = layoutDeclarations(node.layout, parentDisplay, parentDisplay === null && file.relationships[id]?.parentId === root ? hostOrigin(flowHost) : null)
    layout.push({ nodeId: id, mode: placement.mode, x: placement.x, y: placement.y, order, ...(placement.width !== undefined ? { width: placement.width } : {}), ...(placement.height !== undefined ? { height: placement.height } : {}), ...(declarations ? { declarations } : {}) })
  }
  const visitPrimitive = (id: string, parentId: string | null, parentDisplay: DisplayMode | null) => {
    const node = file.nodes[id]
    if (!node || node.type === 'root' || node.type === 'component') return
    const primitiveLayout = primitiveLayoutProjection(node.layout, parentDisplay)
    elements.push({
      id, kind: node.type, name: node.name, x: node.styles.left, y: node.styles.top, width: node.styles.width, height: node.styles.height, rotation: node.styles.rotation ?? 0,
      ...(node.styles.flipX ? { flipX: true } : {}), ...(node.styles.flipY ? { flipY: true } : {}),
      parentId, ...appearanceOf(id, themeOf(id).palette),
      ...(node.type === 'text' ? { text: node.text ?? '', textStyle: structuredClone(node.textStyle!), textSizing: structuredClone(node.textSizing!) } : {}),
      ...(node.type === 'frame' ? { clip: node.styles.overflow !== 'visible' } : {}),
      ...(primitiveLayout ? { layout: primitiveLayout } : {}),
    })
    const childDisplay = nodeChildDisplay(node)
    for (const childId of childrenOf(file, id)) visitPrimitive(childId, id, childDisplay)
  }
  const rootIds: string[] = []
  let componentOrder = 0
  for (const childId of childrenOf(file, root)) {
    const child = file.nodes[childId]
    if (child?.type === 'component') { rootIds.push(childId); visitComponent(childId, componentOrder++, null) }
    else visitPrimitive(childId, null, null)
  }
  return { document: { version: 2, revision: file.revision, rootIds, nodes, frame: { ...flowHost, name: page.name }, canvas: { elements }, ...(resolvedBackground ? { background: colorToCss(resolvedBackground) } : {}), ...(Object.keys(assets).length ? { assets } : {}) }, layout, themeDiagnostics }
}
