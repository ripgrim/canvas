import { describe, expect, it } from 'vitest'
import { validateFileDocument } from '../../repo-engine/src/file-document.js'
import { upgradeFileDocument } from '../../repo-engine/src/file-migration.js'
import { projectPreviewPage } from '../../repo-engine/src/file-preview.js'
import { isPreviewCanvasElement } from '../src/protocol.js'
import { canvasElementStyle, freeformTextAxisSize } from '../src/scene-styles.mjs'

const textStyle = {
  fontFamily: 'Inter, system-ui, sans-serif',
  fontStyle: 'normal',
  fontWeight: 400,
  fontSize: 16,
  lineHeight: { kind: 'unitless', value: 1.25 },
  letterSpacing: 0,
  horizontalAlign: 'left',
  verticalAlign: 'top',
  case: 'none',
  wrap: 'normal',
  keepWords: false,
} as const
const text = (textSizing: unknown, style: Record<string, unknown> = textStyle) => ({ id: 'text', kind: 'text', name: 'Text', x: 12, y: 20, width: 180, height: 60, rotation: 0, parentId: null, text: 'One two three', textStyle: style, textSizing })

describe('PAPER-TEXT-002: preview text protocol and CSS', () => {
  it('renders Fit/Fit intrinsically without wrapping', () => {
    const element = text({ width: { mode: 'fit' }, height: { mode: 'fit' } })
    expect(isPreviewCanvasElement(element)).toBe(true)
    expect(canvasElementStyle(element)).toMatchObject({
      width: 'max-content',
      height: 'max-content',
      whiteSpace: 'pre',
      textWrap: 'nowrap',
      overflow: 'visible',
      fontFamily: 'Inter, system-ui, sans-serif',
      fontWeight: 400,
      fontSize: '16px',
      lineHeight: '1.25',
      letterSpacing: '0px',
      left: '12px',
    })
  })

  it('renders Fixed/Fit as wrapped width with intrinsic height', () => {
    const element = text({ width: { mode: 'fixed' }, height: { mode: 'fit' } }, { ...textStyle, wrap: 'pretty', keepWords: true, horizontalAlign: 'center', verticalAlign: 'middle' })
    expect(canvasElementStyle(element)).toMatchObject({ width: '180px', height: 'max-content', whiteSpace: 'pre-wrap', textWrap: 'pretty', overflowWrap: 'normal', overflow: 'visible', textAlign: 'center', alignContent: 'center' })
  })

  it('projects each safe line-height representation to exact CSS', () => {
    const cases = [
      [{ kind: 'normal' }, 'normal'],
      [{ kind: 'unitless', value: 1.4 }, '1.4'],
      [{ kind: 'percent', value: 125 }, '125%'],
      [{ kind: 'px', value: 24 }, '24px'],
      [{ kind: 'em', value: 1.5 }, '1.5em'],
      [{ kind: 'source', property: '--body-line-height', fallback: { kind: 'unitless', value: 1.25 } }, 'var(--body-line-height, 1.25)'],
    ] as const
    for (const [lineHeight, css] of cases) {
      const element = text({ width: { mode: 'fixed' }, height: { mode: 'fit' } }, { ...textStyle, lineHeight })
      expect(isPreviewCanvasElement(element)).toBe(true)
      expect(canvasElementStyle(element).lineHeight).toBe(css)
    }
  })

  it('uses max-lines as the only truncation switch and does not rewrite geometry', () => {
    const element = text({ width: { mode: 'relative', value: 50 }, height: { mode: 'fit' } }, { ...textStyle, fontStyle: 'italic', fontWeight: 650, fontSize: 20, letterSpacing: -0.25, horizontalAlign: 'right', verticalAlign: 'bottom', case: 'uppercase', wrap: 'balance', maxLines: 2 })
    expect(isPreviewCanvasElement(element)).toBe(true)
    expect(canvasElementStyle(element)).toMatchObject({ width: '50%', height: 'max-content', overflow: 'hidden', letterSpacing: '-0.05px', textTransform: 'uppercase', textAlign: 'right', alignContent: 'end', textWrap: 'balance', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: '2' })
    expect(canvasElementStyle(element)).not.toHaveProperty('maxHeight')
    expect(canvasElementStyle(element)).not.toHaveProperty('textOverflow')
    expect(isPreviewCanvasElement(text({ width: { mode: 'fixed' }, height: { mode: 'fixed' } }, { ...textStyle, maxLines: 2 }))).toBe(false)
  })

  it('preserves the complete v7 rendering contract through migration, projection, and runtime CSS', () => {
    const version7 = {
      schemaVersion: 7,
      fileId: 'file-1', revision: 1,
      pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
      nodes: { 'root-1': { id: 'root-1', type: 'root' }, label: { id: 'label', type: 'text', name: 'Label', styles: { left: 4, top: 5, width: 180, height: 60 }, text: 'Legacy' } },
      relationships: { label: { parentId: 'root-1', orderKey: 'V' } },
      theme: { tokens: {} },
    }
    const file = validateFileDocument(upgradeFileDocument(version7), [])
    const projected = projectPreviewPage(file, 'page-1')!.document.canvas.elements[0]!
    expect(canvasElementStyle(projected)).toMatchObject({
      left: '4px', top: '5px', width: '180px', height: '60px',
      fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
      fontStyle: 'normal', fontWeight: 400, fontSize: '16px', lineHeight: '1.25', letterSpacing: '0px',
      textAlign: 'left', alignContent: 'start', textTransform: 'none', whiteSpace: 'pre-wrap', textWrap: 'wrap', overflowWrap: 'anywhere', overflow: 'hidden',
    })
  })

  it('rejects arbitrary CSS, unsafe source references, malformed sizing, and text-only fields on rectangles', () => {
    expect(isPreviewCanvasElement(text({ width: { mode: 'relative', value: 0 }, height: { mode: 'fixed' } }))).toBe(false)
    expect(isPreviewCanvasElement(text({ width: { mode: 'fixed' }, height: { mode: 'fit' } }, { ...textStyle, lineHeight: 'calc(100vh)' }))).toBe(false)
    expect(isPreviewCanvasElement(text({ width: { mode: 'fixed' }, height: { mode: 'fit' } }, { ...textStyle, lineHeight: { kind: 'source', property: '--bad);color:red', fallback: { kind: 'unitless', value: 1 } } }))).toBe(false)
    expect(isPreviewCanvasElement({ ...text({ width: { mode: 'fixed' }, height: { mode: 'fixed' } }), kind: 'rectangle' })).toBe(false)
    const { textStyle: _style, ...missingStyle } = text({ width: { mode: 'fixed' }, height: { mode: 'fixed' } })
    expect(isPreviewCanvasElement(missingStyle)).toBe(false)
  })

  it('isolates freeform sizing so flex can replace the parent-context mapping', () => {
    expect(freeformTextAxisSize({ mode: 'fixed' }, 180)).toBe('180px')
    expect(freeformTextAxisSize({ mode: 'fit' }, 180)).toBe('max-content')
    expect(freeformTextAxisSize({ mode: 'fill' }, 180)).toBe('100%')
    expect(freeformTextAxisSize({ mode: 'relative', value: 50 }, 180)).toBe('50%')
  })

  it('PAPER-FILL-003: honors parent-projected stretch and flex growth for text Fill', () => {
    const cross = { ...text({ width: { mode: 'fill' }, height: { mode: 'fixed' } }), layout: { mode: 'flow', declarations: { 'align-self': 'stretch' } } }
    expect(canvasElementStyle(cross)).toMatchObject({ width: undefined, alignSelf: 'stretch' })
    const main = { ...text({ width: { mode: 'fill' }, height: { mode: 'fixed' } }), layout: { mode: 'flow', declarations: { 'flex-grow': '1', 'flex-shrink': '1', 'flex-basis': '0%' } } }
    expect(canvasElementStyle(main)).toMatchObject({ width: undefined, flexGrow: '1', flexShrink: '1', flexBasis: '0%' })
  })

  it('anchors intrinsic width to the stored left, center, or right alignment reference', () => {
    const sizing = { width: { mode: 'fit' }, height: { mode: 'fit' } }
    expect(canvasElementStyle(text(sizing, { ...textStyle, horizontalAlign: 'left' })).left).toBe('12px')
    expect(canvasElementStyle(text(sizing, { ...textStyle, horizontalAlign: 'center' }))).toMatchObject({ left: '102px', transform: 'translateX(-50%)' })
    expect(canvasElementStyle(text(sizing, { ...textStyle, horizontalAlign: 'right' }))).toMatchObject({ left: '192px', transform: 'translateX(-100%)' })
    expect(canvasElementStyle(text(sizing, { ...textStyle, horizontalAlign: 'justify' }))).toMatchObject({ left: '12px', transform: undefined })
    expect(canvasElementStyle(text({ width: { mode: 'fixed' }, height: { mode: 'fit' } }, { ...textStyle, horizontalAlign: 'right' })).left).toBe('12px')
  })
})
