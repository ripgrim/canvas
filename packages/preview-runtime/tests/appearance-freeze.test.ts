import { describe, expect, it } from 'vitest'
import { appearanceStyle } from '../src/scene-styles.mjs'
import { projectAppearance } from '../../repo-engine/src/appearance.js'
import type { Appearance, ColorValue } from '../../repo-engine/src/appearance.js'
import type { Color } from '../../repo-engine/src/color.js'

// LAY-APP-001: frozen CSS for render-ready appearance v3. Each expectation is written by hand from the rules in
// scene-styles.mjs: a plain bottom solid is the background color and everything above it is a background layer
// listed topmost first; image URLs come only from the asset map; a component only receives the sections its
// appearance sets while primitives always get a background color; numbers keep at most four decimals; strokes are
// `width style color`; borders emit all four sides with `0` for absent ones; background layers under borders paint
// from the border box.

const assets = { photo: { mime: 'image/png', data: 'AAAA' } }
const component = (appearance: unknown) => appearanceStyle(appearance, assets, 'component')
const rectangle = (appearance: unknown) => appearanceStyle(appearance, assets, 'rectangle')
const text = (appearance: unknown) => appearanceStyle(appearance, assets, 'text')
const gradient = { type: 'gradient', shape: 'linear', angle: 90, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', blendMode: 'overlay', stops: [{ color: '#000000', position: 0, midpoint: 0.3 }, { color: '#3366cc', position: 1 }] }
// 0% + (100% - 0%) * 0.3 places the color hint at 30%.
const gradientCss = 'linear-gradient(in oklab 90deg, #000000 0%, 30%, #3366cc 100%)'
const photoCss = 'url("data:image/png;base64,AAAA")'

describe('LAY-APP-001 appearance style freeze', () => {
  it('paints a plain solid bottom fill as the background color, or as text color', () => {
    const appearance = { fills: [{ type: 'solid', color: '#11aa33' }] }
    expect(component(appearance)).toStrictEqual({ backgroundColor: '#11aa33' })
    expect(rectangle(appearance)).toStrictEqual({ backgroundColor: '#11aa33' })
    expect(text(appearance)).toStrictEqual({ color: '#11aa33' })
  })

  it('paints a gradient top layer over the solid bottom color, with its blend mode and color hint', () => {
    const appearance = { fills: [{ type: 'solid', color: '#ffffff' }, gradient] }
    expect(component(appearance)).toStrictEqual({
      backgroundColor: '#ffffff', backgroundImage: gradientCss, backgroundSize: 'auto', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', backgroundBlendMode: 'overlay',
    })
    expect(text(appearance)).toStrictEqual({
      color: 'transparent',
      backgroundImage: `${gradientCss}, linear-gradient(#ffffff, #ffffff)`, backgroundSize: 'auto, auto', backgroundRepeat: 'no-repeat, no-repeat', backgroundPosition: 'center, center', backgroundBlendMode: 'overlay, normal',
      backgroundClip: 'text', WebkitBackgroundClip: 'text',
    })
  })

  it('builds an image layer only from the asset map and paints nothing for a missing asset', () => {
    expect(component({ fills: [{ type: 'image', assetId: 'photo', fit: 'cover', blendMode: 'multiply' }] })).toStrictEqual({
      backgroundColor: 'transparent', backgroundImage: photoCss, backgroundSize: 'cover', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', backgroundBlendMode: 'multiply',
    })
    expect(component({ fills: [{ type: 'image', assetId: 'photo', fit: 'tile' }] })).toStrictEqual({
      backgroundColor: 'transparent', backgroundImage: photoCss, backgroundSize: 'auto', backgroundRepeat: 'repeat', backgroundPosition: 'center', backgroundBlendMode: 'normal',
    })
    expect(component({ fills: [{ type: 'image', assetId: 'missing', fit: 'cover' }] })).toStrictEqual({ backgroundColor: 'transparent' })
  })

  it('maps an outline to outline and outline offset, leaving a component background alone', () => {
    const appearance = { outline: { color: '#ff0000', width: 2.5, style: 'dashed', offset: -3 } }
    expect(component(appearance)).toStrictEqual({ outline: '2.5px dashed #ff0000', outlineOffset: '-3px' })
    expect(rectangle(appearance)).toStrictEqual({ backgroundColor: 'transparent', outline: '2.5px dashed #ff0000', outlineOffset: '-3px' })
  })

  it('maps four borders to four sides and zeroes the sides that are absent', () => {
    const four = { top: { color: '#111111', width: 1, style: 'solid' }, right: { color: '#222222', width: 2, style: 'dashed' }, bottom: { color: '#333333', width: 3, style: 'dotted' }, left: { color: '#444444', width: 4, style: 'solid' } }
    expect(component({ borders: four })).toStrictEqual({ borderTop: '1px solid #111111', borderRight: '2px dashed #222222', borderBottom: '3px dotted #333333', borderLeft: '4px solid #444444' })
    expect(component({ borders: { left: four.left } })).toStrictEqual({ borderTop: '0', borderRight: '0', borderBottom: '0', borderLeft: '4px solid #444444' })
  })

  it('paints what remains after hidden fills drop, and an empty record per kind when every fill was hidden', () => {
    expect(component({ fills: [{ type: 'solid', color: '#bbbbbb' }] })).toStrictEqual({ backgroundColor: '#bbbbbb' })
    expect(component({})).toStrictEqual({})
    expect(rectangle({})).toStrictEqual({ backgroundColor: 'transparent' })
    expect(text({})).toStrictEqual({ color: 'transparent' })
    expect(component({ visible: false })).toStrictEqual({ visibility: 'hidden' })
  })

  it('maps opacity to at most four decimals and the node blend mode to mix-blend-mode', () => {
    expect(component({ opacity: 0.35, blendMode: 'multiply' })).toStrictEqual({ opacity: '0.35', mixBlendMode: 'multiply' })
    expect(component({ opacity: 1 / 3 })).toStrictEqual({ opacity: '0.3333' })
    expect(component({ opacity: 0 })).toStrictEqual({ opacity: '0' })
  })

  const combined = {
    backgroundColor: '#ffffff',
    backgroundImage: `${gradientCss}, linear-gradient(oklch(0.7 0.1 30 / 0.5), oklch(0.7 0.1 30 / 0.5)), ${photoCss}`,
    backgroundSize: 'auto, auto, auto',
    backgroundRepeat: 'no-repeat, no-repeat, repeat',
    backgroundPosition: 'center, center, center',
    backgroundBlendMode: 'overlay, normal, normal',
    backgroundOrigin: 'border-box',
    backgroundClip: 'border-box',
    opacity: '0.5',
    mixBlendMode: 'screen',
    outline: '2px dotted #00ff00',
    outlineOffset: '4px',
    borderTop: '1px solid #111111',
    borderRight: '0',
    borderBottom: '0',
    borderLeft: '4px dashed #444444',
  }

  it('styles the whole render-ready fixture set on one component exactly', () => {
    expect(component({
      opacity: 0.5, blendMode: 'screen',
      fills: [{ type: 'solid', color: '#ffffff' }, { type: 'image', assetId: 'photo', fit: 'tile' }, { type: 'solid', color: 'oklch(0.7 0.1 30 / 0.5)' }, gradient],
      outline: { color: '#00ff00', width: 2, style: 'dotted', offset: 4 },
      borders: { top: { color: '#111111', width: 1, style: 'solid' }, left: { color: '#444444', width: 4, style: 'dashed' } },
    })).toStrictEqual(combined)
  })

  it('keeps the stored appearance to CSS chain equivalent through the engine projection', () => {
    const hex = (value: string): Color => ({ kind: 'hex', hex: value })
    const lit = (value: string): ColorValue => ({ kind: 'literal', color: hex(value) })
    const palette: Record<string, Color> = { brand: hex('#3366CC'), accent: { kind: 'oklch', l: 0.7, c: 0.1, h: 30, alpha: 0.5 } }
    const stored: Appearance = {
      opacity: 0.5, blendMode: 'screen',
      fills: [
        { id: 'bottom', type: 'solid', color: lit('#FFFFFF') },
        { id: 'hidden', type: 'solid', color: lit('#ff0000'), visible: false },
        { id: 'image', type: 'image', assetId: 'photo', fit: 'tile' },
        { id: 'token', type: 'solid', color: { kind: 'token', tokenId: 'accent' } },
        { id: 'top', type: 'gradient', shape: 'linear', angle: 90, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'oklab', blendMode: 'overlay', stops: [{ id: 'b', position: 1, midpoint: 0.5, color: { kind: 'token', tokenId: 'brand' } }, { id: 'a', position: 0, midpoint: 0.3, color: lit('#000000') }] },
      ],
      outline: { color: lit('#00FF00'), width: 2, style: 'dotted', offset: 4 },
      borders: { top: { color: lit('#111111'), width: 1, style: 'solid' }, right: { color: lit('#222222'), width: 0, style: 'solid' }, bottom: { color: lit('#333333'), width: 3, style: 'dotted', visible: false }, left: { color: lit('#444444'), width: 4, style: 'dashed' } },
    }
    const projected = projectAppearance(stored, value => value.kind === 'literal' ? value.color : palette[value.tokenId] ?? null, assetId => Object.hasOwn(assets, assetId))
    expect(component(projected)).toStrictEqual(combined)
  })

  it('is sensitive to fill order: swapping the bottom solid changes the painted CSS (negative control)', () => {
    expect(component({ fills: [{ type: 'solid', color: '#000001' }, { type: 'solid', color: '#000002' }] })).toMatchObject({ backgroundColor: '#000001', backgroundImage: 'linear-gradient(#000002, #000002)' })
    expect(component({ fills: [{ type: 'solid', color: '#000002' }, { type: 'solid', color: '#000001' }] })).toMatchObject({ backgroundColor: '#000002', backgroundImage: 'linear-gradient(#000001, #000001)' })
  })
})
