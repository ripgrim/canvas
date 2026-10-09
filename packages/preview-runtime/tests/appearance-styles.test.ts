import { describe, expect, it } from 'vitest'
import { appearanceStyle, canvasElementStyle, fillLayers } from '../src/scene-styles.mjs'

const assets = { photo: { mime: 'image/png', data: 'AAAA' }, tile: { mime: 'image/webp', data: 'QUJD' } }
const linear = (interpolation: string, extra: Record<string, unknown> = {}) => ({ type: 'gradient', shape: 'linear', angle: 90, center: { x: 0.5, y: 0.5 }, length: 1, interpolation, stops: [{ color: '#ff0000', position: 0 }, { color: '#0000ff', position: 1 }], ...extra })
const box = (appearance: unknown) => appearanceStyle(appearance, assets, 'rectangle')

describe('AT-APP-003 appearance styles', () => {
  it('paints a plain bottom solid as the background color and lists the fills above it topmost first', () => {
    expect(box({ fills: [{ type: 'solid', color: '#111111' }, { type: 'solid', color: 'oklch(0.5 0.1 120 / 0.5)' }] })).toEqual({
      backgroundColor: '#111111',
      backgroundImage: 'linear-gradient(oklch(0.5 0.1 120 / 0.5), oklch(0.5 0.1 120 / 0.5))',
      backgroundSize: 'auto',
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'center',
      backgroundBlendMode: 'normal',
    })
    expect(box({ fills: [{ type: 'solid', color: '#111111' }, { type: 'solid', color: '#222222' }, { type: 'solid', color: '#333333', blendMode: 'overlay' }] })).toEqual({
      backgroundColor: '#111111',
      backgroundImage: 'linear-gradient(#333333, #333333), linear-gradient(#222222, #222222)',
      backgroundSize: 'auto, auto',
      backgroundRepeat: 'no-repeat, no-repeat',
      backgroundPosition: 'center, center',
      backgroundBlendMode: 'overlay, normal',
    })
    expect(box({ fills: [{ type: 'solid', color: '#111111', blendMode: 'normal' }] })).toEqual({ backgroundColor: '#111111' })
  })

  it('keeps a bottom solid with a blend mode, or a bottom gradient, as a layer over a transparent color', () => {
    expect(box({ fills: [{ type: 'solid', color: '#111111', blendMode: 'multiply' }, { type: 'solid', color: '#222222' }] })).toEqual({
      backgroundColor: 'transparent',
      backgroundImage: 'linear-gradient(#222222, #222222), linear-gradient(#111111, #111111)',
      backgroundSize: 'auto, auto',
      backgroundRepeat: 'no-repeat, no-repeat',
      backgroundPosition: 'center, center',
      backgroundBlendMode: 'normal, multiply',
    })
    expect(box({ fills: [linear('srgb'), { type: 'solid', color: '#222222' }] })).toEqual({
      backgroundColor: 'transparent',
      backgroundImage: 'linear-gradient(#222222, #222222), linear-gradient(90deg, #ff0000 0%, #0000ff 100%)',
      backgroundSize: 'auto, auto',
      backgroundRepeat: 'no-repeat, no-repeat',
      backgroundPosition: 'center, center',
      backgroundBlendMode: 'normal, normal',
    })
  })

  it('renders a single remaining fill when the editor has already dropped a hidden fill', () => {
    expect(box({ fills: [{ type: 'solid', color: '#abcdef' }] })).toEqual({ backgroundColor: '#abcdef' })
    expect(box({ fills: [{ type: 'solid', color: '#abcdef', blendMode: 'screen' }] })).toEqual({ backgroundColor: 'transparent', backgroundImage: 'linear-gradient(#abcdef, #abcdef)', backgroundSize: 'auto', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', backgroundBlendMode: 'screen' })
  })

  it.each([
    ['linear oklab', linear('oklab'), 'linear-gradient(in oklab 90deg, #ff0000 0%, #0000ff 100%)'],
    ['linear oklch', linear('oklch', { angle: -45.5 }), 'linear-gradient(in oklch -45.5deg, #ff0000 0%, #0000ff 100%)'],
    ['linear srgb', linear('srgb', { angle: 0 }), 'linear-gradient(0deg, #ff0000 0%, #0000ff 100%)'],
    ['radial oklab', linear('oklab', { shape: 'radial', center: { x: 0.25, y: 0.75 }, length: 1.5 }), 'radial-gradient(in oklab ellipse 150% 150% at 25% 75%, #ff0000 0%, #0000ff 100%)'],
    ['radial oklch', linear('oklch', { shape: 'radial', center: { x: -1, y: 2.5 }, length: 0.5 }), 'radial-gradient(in oklch ellipse 50% 50% at -100% 250%, #ff0000 0%, #0000ff 100%)'],
    ['radial srgb', linear('srgb', { shape: 'radial', length: 0.07 }), 'radial-gradient(ellipse 7% 7% at 50% 50%, #ff0000 0%, #0000ff 100%)'],
    ['conic oklab', linear('oklab', { shape: 'conic', angle: 30, center: { x: 0.1, y: 0.2 } }), 'conic-gradient(in oklab from 30deg at 10% 20%, #ff0000 0%, #0000ff 100%)'],
    ['conic oklch', linear('oklch', { shape: 'conic', angle: -90 }), 'conic-gradient(in oklch from -90deg at 50% 50%, #ff0000 0%, #0000ff 100%)'],
    ['conic srgb', linear('srgb', { shape: 'conic', angle: 360 }), 'conic-gradient(from 360deg at 50% 50%, #ff0000 0%, #0000ff 100%)'],
  ])('emits %s', (_, fill, image) => {
    expect(box({ fills: [fill] }).backgroundImage).toBe(image)
  })

  it('adds a color hint inside the segment after a stop whose midpoint is not 0.5', () => {
    const stops = [{ color: '#000000', position: 0, midpoint: 0.25 }, { color: '#808080', position: 0.4, midpoint: 0.5 }, { color: '#ffffff', position: 0.9, midpoint: 0.8 }, { color: '#ff0000', position: 1, midpoint: 0.1 }]
    // 0 + 0.4 * 0.25 = 10%; 0.5 adds nothing; 0.9 + 0.1 * 0.8 = 98%; the last stop has no following segment.
    expect(box({ fills: [linear('srgb', { stops })] }).backgroundImage).toBe('linear-gradient(90deg, #000000 0%, 10%, #808080 40%, #ffffff 90%, 98%, #ff0000 100%)')
  })

  it.each([
    ['cover', 'cover', 'no-repeat'],
    ['contain', 'contain', 'no-repeat'],
    ['stretch', '100% 100%', 'no-repeat'],
    ['tile', 'auto', 'repeat'],
  ])('builds an image layer with fit %s only from the trusted asset map', (fit, size, repeat) => {
    expect(box({ fills: [{ type: 'image', assetId: 'photo', fit }] })).toMatchObject({ backgroundImage: 'url("data:image/png;base64,AAAA")', backgroundSize: size, backgroundRepeat: repeat, backgroundPosition: 'center' })
  })

  it('drops an image layer whose asset is missing instead of building a url from fill data', () => {
    expect(box({ fills: [{ type: 'image', assetId: 'https://attacker.example/x.png', fit: 'cover' }] })).toEqual({ backgroundColor: 'transparent' })
    expect(fillLayers([{ type: 'image', assetId: 'missing', fit: 'cover' }], assets)).toBeNull()
  })

  it('keeps per-fill blend modes aligned with their layers', () => {
    const style = box({ fills: [
      { type: 'image', assetId: 'tile', fit: 'tile', blendMode: 'multiply' },
      linear('oklab'),
      { type: 'solid', color: '#00ff00', blendMode: 'screen' },
    ] })
    expect(style).toEqual({
      backgroundColor: 'transparent',
      backgroundImage: 'linear-gradient(#00ff00, #00ff00), linear-gradient(in oklab 90deg, #ff0000 0%, #0000ff 100%), url("data:image/webp;base64,QUJD")',
      backgroundSize: 'auto, auto, auto',
      backgroundRepeat: 'no-repeat, no-repeat, repeat',
      backgroundPosition: 'center, center, center',
      backgroundBlendMode: 'screen, normal, multiply',
    })
  })

  it('maps the outline to outline and offset', () => {
    expect(box({ outline: { color: '#00ff00', width: 2.5, style: 'dashed', offset: -3 } })).toEqual({ backgroundColor: 'transparent', outline: '2.5px dashed #00ff00', outlineOffset: '-3px' })
  })

  it.each([
    ['top', { borderTop: '3px solid #111111', borderRight: '0', borderBottom: '0', borderLeft: '0' }],
    ['right', { borderTop: '0', borderRight: '3px solid #111111', borderBottom: '0', borderLeft: '0' }],
    ['bottom', { borderTop: '0', borderRight: '0', borderBottom: '3px solid #111111', borderLeft: '0' }],
    ['left', { borderTop: '0', borderRight: '0', borderBottom: '0', borderLeft: '3px solid #111111' }],
  ])('renders only the %s border side', (side, expected) => {
    expect(box({ borders: { [side]: { color: '#111111', width: 3, style: 'solid' } } })).toEqual({ backgroundColor: 'transparent', ...expected })
  })

  it('paints fill layers under borders from the border box', () => {
    const borders = { top: { color: '#000000', width: 1, style: 'dotted' }, left: { color: '#ff0000', width: 4, style: 'dashed' } }
    expect(box({ fills: [linear('srgb')], borders })).toMatchObject({ backgroundColor: 'transparent', backgroundOrigin: 'border-box', backgroundClip: 'border-box', borderTop: '1px dotted #000000', borderLeft: '4px dashed #ff0000', borderRight: '0', borderBottom: '0' })
    expect(box({ fills: [linear('srgb')] }).backgroundOrigin).toBeUndefined()
    // A background color alone already paints the border box, so no origin or clip is emitted.
    expect(box({ fills: [{ type: 'solid', color: '#ffffff' }], borders })).toEqual({ backgroundColor: '#ffffff', borderTop: '1px dotted #000000', borderRight: '0', borderBottom: '0', borderLeft: '4px dashed #ff0000' })
  })

  it('maps opacity, node blend mode, and hidden visibility', () => {
    expect(box({ opacity: 0.35, blendMode: 'color-dodge' })).toEqual({ backgroundColor: 'transparent', opacity: '0.35', mixBlendMode: 'color-dodge' })
    expect(box({ opacity: 0 }).opacity).toBe('0')
    expect(box({ visible: false })).toEqual({ backgroundColor: 'transparent', visibility: 'hidden' })
    expect(box({ opacity: 1 }).visibility).toBeUndefined()
  })

  it('uses color for one plain solid text fill and clips a background for any other text fill', () => {
    expect(appearanceStyle({ fills: [{ type: 'solid', color: '#334455' }] }, assets, 'text')).toEqual({ color: '#334455' })
    expect(appearanceStyle({ fills: [{ type: 'solid', color: '#334455', blendMode: 'normal' }] }, assets, 'text')).toEqual({ color: '#334455' })
    expect(appearanceStyle({ fills: [linear('oklch')] }, assets, 'text')).toEqual({
      color: 'transparent',
      backgroundImage: 'linear-gradient(in oklch 90deg, #ff0000 0%, #0000ff 100%)',
      backgroundSize: 'auto', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', backgroundBlendMode: 'normal',
      backgroundClip: 'text', WebkitBackgroundClip: 'text',
    })
    expect(appearanceStyle({ fills: [{ type: 'solid', color: '#334455', blendMode: 'overlay' }] }, assets, 'text')).toMatchObject({ color: 'transparent', backgroundImage: 'linear-gradient(#334455, #334455)', backgroundBlendMode: 'overlay', backgroundClip: 'text' })
    expect(appearanceStyle({ fills: [{ type: 'solid', color: '#111111' }, { type: 'solid', color: '#222222' }] }, assets, 'text')).toMatchObject({ color: 'transparent', backgroundImage: 'linear-gradient(#222222, #222222), linear-gradient(#111111, #111111)' })
    expect(appearanceStyle({ opacity: 0.5 }, assets, 'text')).toEqual({ color: 'transparent', opacity: '0.5' })
    expect(appearanceStyle(undefined, assets, 'text')).toEqual({ color: '#202124' })
  })

  it('touches only the sections a component appearance sets', () => {
    expect(appearanceStyle(undefined, assets, 'component')).toEqual({})
    expect(appearanceStyle({ opacity: 0.5 }, assets, 'component')).toEqual({ opacity: '0.5' })
    expect(appearanceStyle({ fills: [{ type: 'solid', color: '#ff00ff' }] }, assets, 'component')).toEqual({ backgroundColor: '#ff00ff' })
    expect(appearanceStyle({ fills: [{ type: 'image', assetId: 'photo', fit: 'cover' }] }, assets, 'component')).toMatchObject({ backgroundColor: 'transparent', backgroundImage: 'url("data:image/png;base64,AAAA")' })
  })

  it('keeps primitive geometry, clip, rotation, text font, and shape radius alongside appearance', () => {
    const element = { id: 'a', kind: 'shape', name: 'A', x: 10, y: 20, width: 30, height: 40, rotation: 12, parentId: null, appearance: { fills: [{ type: 'image', assetId: 'photo', fit: 'contain' }], opacity: 0.5 } }
    expect(canvasElementStyle(element, assets, { x: 5, y: 5 })).toEqual({
      position: 'absolute', left: '5px', top: '15px', width: '30px', height: '40px', boxSizing: 'border-box', pointerEvents: 'none', margin: 0, transformOrigin: 'center', transform: 'rotate(12deg)',
      backgroundColor: 'transparent', backgroundImage: 'url("data:image/png;base64,AAAA")', backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', backgroundBlendMode: 'normal', opacity: '0.5',
      borderRadius: '50%',
    })
    expect(canvasElementStyle({ ...element, kind: 'frame', clip: false }, assets).overflow).toBe('visible')
    expect(canvasElementStyle({ ...element, kind: 'text', text: 'Hi', appearance: undefined }, assets)).toMatchObject({ color: '#202124', fontSize: '16px', overflow: 'hidden' })
  })
})
