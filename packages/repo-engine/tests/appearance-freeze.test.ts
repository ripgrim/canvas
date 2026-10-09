import { describe, expect, it } from 'vitest'
import { projectAppearance } from '../src/appearance.js'
import type { Appearance, ColorValue, GradientPaint, Stroke } from '../src/appearance.js'
import type { Color } from '../src/color.js'
import { isPreviewAppearance } from '../../preview-runtime/src/protocol.js'

// LAY-APP-001: frozen appearance v3 projections. Each expectation is written by hand from the rules documented on
// `projectAppearance`: colors resolve to CSS (hex lower case, oklch() for OKLCH), hidden fills and strokes drop,
// zero-width strokes drop, unresolvable colors and missing assets drop, stops sort by position and keep only a
// midpoint other than 0.5, `all` borders expand to four sides, and fills keep storage order (bottom to top).

const hex = (value: string): Color => ({ kind: 'hex', hex: value })
const lit = (value: string): ColorValue => ({ kind: 'literal', color: hex(value) })
const tok = (tokenId: string): ColorValue => ({ kind: 'token', tokenId })
const stroke = (color: string, width: number, style: Stroke['style']): Stroke => ({ color: lit(color), width, style })
const palette: Record<string, Color> = { brand: hex('#3366CC'), accent: { kind: 'oklch', l: 0.7, c: 0.1, h: 30, alpha: 0.5 } }
const resolve = (value: ColorValue): Color | null => value.kind === 'literal' ? value.color : palette[value.tokenId] ?? null
const assets = { photo: { mime: 'image/png', data: 'AAAA' } }
const hasAsset = (assetId: string) => Object.hasOwn(assets, assetId)
const project = (appearance: Appearance | undefined) => projectAppearance(appearance, resolve, hasAsset)

const gradient = (): GradientPaint => ({
  id: 'top', type: 'gradient', shape: 'linear', angle: 90, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', blendMode: 'overlay',
  stops: [{ id: 's-end', position: 1, midpoint: 0.5, color: tok('brand') }, { id: 's-start', position: 0, midpoint: 0.3, color: lit('#000000') }],
})
const projectedGradient = {
  type: 'gradient', shape: 'linear', angle: 90, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', blendMode: 'overlay',
  stops: [{ color: '#000000', position: 0, midpoint: 0.3 }, { color: '#3366cc', position: 1 }],
}

describe('LAY-APP-001 appearance projection freeze', () => {
  it('projects a plain solid bottom fill to its lower case CSS color', () => {
    expect(project({ fills: [{ id: 'bottom', type: 'solid', color: lit('#11AA33') }] })).toStrictEqual({ fills: [{ type: 'solid', color: '#11aa33' }] })
  })

  it('projects a gradient top layer above a solid, with sorted stops, a resolved token, and only the non-default midpoint', () => {
    expect(project({ fills: [{ id: 'bottom', type: 'solid', color: lit('#FFFFFF') }, gradient()] })).toStrictEqual({
      fills: [{ type: 'solid', color: '#ffffff' }, projectedGradient],
    })
  })

  it('projects an image fill whose asset exists and drops one whose asset is missing', () => {
    expect(project({ fills: [
      { id: 'image', type: 'image', assetId: 'photo', fit: 'cover', blendMode: 'multiply' },
      { id: 'gone', type: 'image', assetId: 'missing', fit: 'tile' },
    ] })).toStrictEqual({ fills: [{ type: 'image', assetId: 'photo', fit: 'cover', blendMode: 'multiply' }] })
  })

  it('projects an outline with its offset, and drops a hidden or zero width outline', () => {
    expect(project({ outline: { ...stroke('#FF0000', 2.5, 'dashed'), offset: -3 } })).toStrictEqual({ outline: { color: '#ff0000', width: 2.5, style: 'dashed', offset: -3 } })
    expect(project({ outline: { ...stroke('#ff0000', 2, 'dashed'), offset: 1, visible: false } })).toBeUndefined()
    expect(project({ outline: { ...stroke('#ff0000', 0, 'dashed'), offset: 1 } })).toBeUndefined()
  })

  it('projects four individual borders side by side and expands an all record to four equal sides', () => {
    expect(project({ borders: { top: stroke('#111111', 1, 'solid'), right: stroke('#222222', 2, 'dashed'), bottom: stroke('#333333', 3, 'dotted'), left: stroke('#444444', 4, 'solid') } })).toStrictEqual({
      borders: {
        top: { color: '#111111', width: 1, style: 'solid' },
        right: { color: '#222222', width: 2, style: 'dashed' },
        bottom: { color: '#333333', width: 3, style: 'dotted' },
        left: { color: '#444444', width: 4, style: 'solid' },
      },
    })
    const side = { color: '#555555', width: 6, style: 'dotted' }
    expect(project({ borders: { all: stroke('#555555', 6, 'dotted') } })).toStrictEqual({ borders: { top: side, right: side, bottom: side, left: side } })
  })

  it('drops a hidden fill and keeps the visible one, and keeps an empty record when every authored fill is hidden', () => {
    expect(project({ fills: [{ id: 'hidden', type: 'solid', color: lit('#aaaaaa'), visible: false }, { id: 'shown', type: 'solid', color: lit('#bbbbbb') }] })).toStrictEqual({ fills: [{ type: 'solid', color: '#bbbbbb' }] })
    expect(project({ fills: [{ id: 'hidden', type: 'solid', color: lit('#aaaaaa'), visible: false }] })).toStrictEqual({})
  })

  it('projects opacity and node blend mode as authored, and node visibility as visible false', () => {
    expect(project({ opacity: 0.35, blendMode: 'multiply' })).toStrictEqual({ opacity: 0.35, blendMode: 'multiply' })
    expect(project({ visible: false, opacity: 0 })).toStrictEqual({ visible: false, opacity: 0 })
  })

  it('projects the whole fixture set on one node exactly', () => {
    const appearance: Appearance = {
      opacity: 0.5, blendMode: 'screen',
      fills: [
        { id: 'bottom', type: 'solid', color: lit('#FFFFFF') },
        { id: 'hidden', type: 'solid', color: lit('#ff0000'), visible: false },
        { id: 'image', type: 'image', assetId: 'photo', fit: 'tile' },
        { id: 'token', type: 'solid', color: tok('accent') },
        gradient(),
      ],
      outline: { ...stroke('#00FF00', 2, 'dotted'), offset: 4 },
      borders: { top: stroke('#111111', 1, 'solid'), right: stroke('#222222', 0, 'solid'), bottom: { ...stroke('#333333', 3, 'dotted'), visible: false }, left: stroke('#444444', 4, 'dashed') },
    }
    const projected = project(appearance)
    expect(projected).toStrictEqual({
      opacity: 0.5, blendMode: 'screen',
      fills: [
        { type: 'solid', color: '#ffffff' },
        { type: 'image', assetId: 'photo', fit: 'tile' },
        { type: 'solid', color: 'oklch(0.7 0.1 30 / 0.5)' },
        projectedGradient,
      ],
      outline: { color: '#00ff00', width: 2, style: 'dotted', offset: 4 },
      borders: { top: { color: '#111111', width: 1, style: 'solid' }, left: { color: '#444444', width: 4, style: 'dashed' } },
    })
    // The projection is exactly what the preview protocol accepts, so the two packages agree on the contract.
    expect(isPreviewAppearance(projected, assets, 'component')).toBe(true)
  })

  it('keeps storage order, so reordering fills changes the projection (negative control)', () => {
    const fills: Appearance['fills'] = [{ id: 'a', type: 'solid', color: lit('#000001') }, { id: 'b', type: 'solid', color: lit('#000002') }]
    expect(project({ fills })!.fills!.map(fill => (fill as { color: string }).color)).toEqual(['#000001', '#000002'])
    expect(project({ fills: [...fills].reverse() })!.fills!.map(fill => (fill as { color: string }).color)).toEqual(['#000002', '#000001'])
  })
})
