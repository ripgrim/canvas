/** Pure style derivation for primitive scene nodes and component roots rendered inside the preview. */

import { cornerRadiiStyle } from './appearance-styles.mjs'

/** Ink for text elements that predate appearance. The editor seeds an appearance on new nodes. */
export const legacyTextColor = '#202124'

/**
 * World origin of the legacy component host. Root component nodes without an explicit layout flow inside it,
 * which keeps documents authored against the fixed preview frame at the same world position.
 */
export function hostOrigin(frame) {
  return { x: -frame.width / 2 + frame.padding, y: -frame.height / 2 + frame.padding, width: frame.width - frame.padding * 2 }
}

// Four decimals keep CSS free of float noise (7.000000000000001%) and of exponent notation, which CSS lengths reject.
const number = value => String(Number(value.toFixed(4)))
const percent = value => `${number(value * 100)}%`
const imageSizes = { cover: 'cover', contain: 'contain', stretch: '100% 100%', tile: 'auto' }
const horizontalTextAlignment = { left: 'left', center: 'center', right: 'right', justify: 'justify' }
const verticalTextAlignment = { top: 'start', middle: 'center', bottom: 'end' }
const textTransform = { none: 'none', uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize' }

function lineHeightCss(value) {
  if (value.kind === 'normal') return 'normal'
  if (value.kind === 'source') return `var(${value.property}, ${lineHeightCss(value.fallback)})`
  if (value.kind === 'percent') return `${number(value.value)}%`
  if (value.kind === 'px') return `${number(value.value)}px`
  if (value.kind === 'em') return `${number(value.value)}em`
  return number(value.value)
}

const declarationProperty = name => name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
export function primitiveLayoutStyle(layout) {
  if (!layout) return {}
  const style = Object.fromEntries(Object.entries(layout.declarations).map(([name, value]) => [declarationProperty(name), value]))
  // Flow participants remain in layout while also establishing the containing block for an absolute primitive child.
  if (layout.mode === 'flow') style.position = 'relative'
  return style
}

/**
 * Freeform text has no layout-parent sizing context. Paper's strongest observable contract is intrinsic no-wrap for a
 * Fit width and intrinsic growth for a Fit height, so Fit maps to max-content here. Fill and Relative are retained for
 * frame children; the flex projection can replace this mapping once it supplies explicit parent-axis context.
 */
export function freeformTextAxisSize(axis, fallback) {
  if (axis.mode === 'fixed') return `${fallback}px`
  if (axis.mode === 'fit') return 'max-content'
  if (axis.mode === 'fill') return '100%'
  return `${number(axis.value)}%`
}

/** Stops as `color pos%`; a stop's midpoint other than 0.5 adds a color hint inside the segment that follows it. */
function stopList(stops) {
  const parts = []
  stops.forEach((stop, index) => {
    parts.push(`${stop.color} ${percent(stop.position)}`)
    const next = stops[index + 1]
    if (next && stop.midpoint !== undefined && stop.midpoint !== 0.5) parts.push(percent(stop.position + (next.position - stop.position) * stop.midpoint))
  })
  return parts.join(', ')
}

function gradientLayer(fill) {
  const space = fill.interpolation === 'srgb' ? '' : `in ${fill.interpolation} `
  const center = `at ${percent(fill.center.x)} ${percent(fill.center.y)}`
  const stops = stopList(fill.stops)
  if (fill.shape === 'radial') return `radial-gradient(${space}ellipse ${percent(fill.length)} ${percent(fill.length)} ${center}, ${stops})`
  if (fill.shape === 'conic') return `conic-gradient(${space}from ${number(fill.angle)}deg ${center}, ${stops})`
  return `linear-gradient(${space}${number(fill.angle)}deg, ${stops})`
}

/** Image URLs come only from the trusted asset map; a fill contributes nothing but the asset id used as a key. */
function fillLayer(fill, assets) {
  if (fill.type === 'solid') return { image: `linear-gradient(${fill.color}, ${fill.color})`, size: 'auto', repeat: 'no-repeat' }
  if (fill.type === 'gradient') return { image: gradientLayer(fill), size: 'auto', repeat: 'no-repeat' }
  const asset = assets && Object.hasOwn(assets, fill.assetId) ? assets[fill.assetId] : null
  if (!asset) return null
  return { image: `url("data:${asset.mime};base64,${asset.data}")`, size: fill.geometry ? `${number(fill.geometry.width)}px ${number(fill.geometry.height)}px` : imageSizes[fill.fit], position: fill.geometry ? `${number(fill.geometry.x)}px ${number(fill.geometry.y)}px` : 'center', repeat: fill.fit === 'tile' && !fill.geometry ? 'repeat' : 'no-repeat' }
}

function fillGeometry(fill, assets) {
  if (fill.type === 'solid' || fill.type === 'gradient') return { size: 'auto', position: 'center', repeat: 'no-repeat' }
  if (!assets || !Object.hasOwn(assets, fill.assetId)) return null
  return {
    size: fill.geometry ? `${number(fill.geometry.width)}px ${number(fill.geometry.height)}px` : imageSizes[fill.fit],
    position: fill.geometry ? `${number(fill.geometry.x)}px ${number(fill.geometry.y)}px` : 'center',
    repeat: fill.fit === 'tile' && !fill.geometry ? 'repeat' : 'no-repeat',
  }
}

/** CSS background layers, topmost first, with parallel size, repeat, position, and blend lists. */
export function fillLayers(fills, assets) {
  const layers = [...fills].reverse().map(fill => { const layer = fillLayer(fill, assets); return layer && { ...layer, blend: fill.blendMode ?? 'normal' } }).filter(Boolean)
  if (!layers.length) return null
  return {
    backgroundImage: layers.map(layer => layer.image).join(', '),
    backgroundSize: layers.map(layer => layer.size).join(', '),
    backgroundRepeat: layers.map(layer => layer.repeat).join(', '),
    backgroundPosition: layers.map(layer => layer.position ?? 'center').join(', '),
    backgroundBlendMode: layers.map(layer => layer.blend).join(', '),
  }
}

/** Geometry-only background declarations for live image resize. This never rebuilds or rewrites asset data URLs. */
export function fillGeometryStyle(fills, assets) {
  const layers = [...fills].reverse().map(fill => fillGeometry(fill, assets)).filter(Boolean)
  if (!layers.length) return null
  return {
    backgroundSize: layers.map(layer => layer.size).join(', '),
    backgroundPosition: layers.map(layer => layer.position).join(', '),
    backgroundRepeat: layers.map(layer => layer.repeat).join(', '),
  }
}

const stroke = value => `${number(value.width)}px ${value.style} ${value.color}`

/**
 * CSS properties for a node appearance. `kind` is a primitive kind or `component`. Components only receive the
 * properties their appearance sets, so a component keeps its own background when it has no fills.
 */
export function appearanceStyle(appearance, assets, kind) {
  if (!appearance) return kind === 'text' ? { color: legacyTextColor } : kind === 'component' ? {} : { backgroundColor: 'transparent' }
  const style = {}
  const fills = appearance.fills ?? []
  if (kind === 'text') {
    const only = fills.length === 1 ? fills[0] : null
    if (only?.type === 'solid' && (only.blendMode ?? 'normal') === 'normal') style.color = only.color
    else {
      style.color = 'transparent'
      const layers = fills.length ? fillLayers(fills, assets) : null
      if (layers) Object.assign(style, layers, { backgroundClip: 'text', WebkitBackgroundClip: 'text' })
    }
  } else if (fills.length || kind !== 'component') {
    // A plain bottom solid is the background color (as Paper renders it); everything above it is a background layer.
    const bottom = fills[0]
    const plainBottom = bottom?.type === 'solid' && (bottom.blendMode ?? 'normal') === 'normal'
    style.backgroundColor = plainBottom ? bottom.color : 'transparent'
    const layered = plainBottom ? fills.slice(1) : fills
    const layers = layered.length ? fillLayers(layered, assets) : null
    if (layers) Object.assign(style, layers)
    if (layers && appearance.borders) Object.assign(style, { backgroundOrigin: 'border-box', backgroundClip: 'border-box' })
  }
  if (appearance.opacity !== undefined) style.opacity = number(appearance.opacity)
  if (appearance.blendMode) style.mixBlendMode = appearance.blendMode
  if (appearance.visible === false) style.visibility = 'hidden'
  if (appearance.outline) { style.outline = stroke(appearance.outline); style.outlineOffset = `${number(appearance.outline.offset)}px` }
  if (appearance.borders) {
    for (const [side, property] of [['top', 'borderTop'], ['right', 'borderRight'], ['bottom', 'borderBottom'], ['left', 'borderLeft']]) {
      const value = appearance.borders[side]
      style[property] = value ? stroke(value) : '0'
    }
  }
  Object.assign(style, cornerRadiiStyle(appearance))
  return style
}

export function canvasElementStyle(element, assets = undefined, offset = { x: 0, y: 0 }) {
  const transforms = [...(element.rotation ? [`rotate(${element.rotation}deg)`] : []), ...(element.flipX || element.flipY ? [`scale(${element.flipX ? -1 : 1}, ${element.flipY ? -1 : 1})`] : [])]
  const mode = element.layout?.mode ?? 'freeform'
  const declarations = element.layout?.declarations ?? {}
  const rightAnchored = mode === 'absolute' && Object.hasOwn(declarations, 'right') && !Object.hasOwn(declarations, 'left')
  const bottomAnchored = mode === 'absolute' && Object.hasOwn(declarations, 'bottom') && !Object.hasOwn(declarations, 'top')
  const style = {
    position: mode === 'flow' ? 'relative' : 'absolute',
    left: mode === 'flow' || rightAnchored ? undefined : `${element.x - offset.x}px`,
    top: mode === 'flow' || bottomAnchored ? undefined : `${element.y - offset.y}px`,
    width: `${element.width}px`,
    height: `${element.height}px`,
    boxSizing: 'border-box',
    pointerEvents: 'none',
    margin: 0,
    transformOrigin: 'center',
    transform: transforms.length ? transforms.join(' ') : undefined,
    ...primitiveLayoutStyle(element.layout),
  }
  const appearance = appearanceStyle(element.appearance, assets, element.kind)
  if (element.kind === 'frame') return { ...style, ...appearance, overflow: element.clip === false ? 'visible' : 'hidden' }
  if (element.kind === 'rectangle' || element.kind === 'shader') return { ...style, ...appearance }
  if (element.kind === 'shape') return { ...style, ...appearance, borderRadius: '50%' }
  const text = element.textStyle
  const sizing = element.textSizing
  const widthFitsContent = sizing.width.mode === 'fit'
  const heightFitsContent = sizing.height.mode === 'fit'
  const authoredLeft = element.x - offset.x
  const authoredTextAnchor = mode === 'freeform'
  const anchorOffset = authoredTextAnchor && widthFitsContent && text.horizontalAlign === 'center'
    ? 'translateX(-50%)'
    : authoredTextAnchor && widthFitsContent && text.horizontalAlign === 'right'
      ? 'translateX(-100%)'
      : null
  const anchoredLeft = !authoredTextAnchor
    ? null
    : widthFitsContent && text.horizontalAlign === 'center'
    ? authoredLeft + element.width / 2
    : widthFitsContent && text.horizontalAlign === 'right'
      ? authoredLeft + element.width
      : authoredLeft
  const textTransforms = [...(anchorOffset ? [anchorOffset] : []), ...transforms]
  const semanticTextSize = (property, axis, fallback) => {
    if (axis.mode !== 'fill') return freeformTextAxisSize(axis, fallback)
    const projected = declarations[property]
    if (projected !== undefined) return projected
    if (declarations['align-self'] === 'stretch' || declarations['justify-self'] === 'stretch' || declarations['flex-grow'] !== undefined) return undefined
    return '100%'
  }
  return {
    ...style,
    ...appearance,
    ...(anchoredLeft === null ? {} : { left: `${number(anchoredLeft)}px` }),
    transform: textTransforms.length ? textTransforms.join(' ') : undefined,
    width: semanticTextSize('width', sizing.width, element.width),
    height: semanticTextSize('height', sizing.height, element.height),
    fontFamily: text.fontFamily,
    fontStyle: text.fontStyle,
    fontWeight: text.fontWeight,
    fontSize: `${number(text.fontSize)}px`,
    lineHeight: lineHeightCss(text.lineHeight),
    letterSpacing: `${number(text.fontSize) * number(text.letterSpacing) / 100}px`,
    textAlign: horizontalTextAlignment[text.horizontalAlign],
    alignContent: verticalTextAlignment[text.verticalAlign],
    textTransform: textTransform[text.case],
    whiteSpace: widthFitsContent ? 'pre' : 'pre-wrap',
    textWrap: widthFitsContent ? 'nowrap' : text.wrap === 'normal' ? 'wrap' : text.wrap,
    overflowWrap: text.keepWords ? 'normal' : 'anywhere',
    wordBreak: 'normal',
    overflow: heightFitsContent ? 'visible' : 'hidden',
    ...(text.maxLines !== undefined ? { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: String(text.maxLines), overflow: 'hidden' } : {}),
  }
}
