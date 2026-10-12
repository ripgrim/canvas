import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TextSizing, TextStyle } from '@canvas/repo-engine/file-document'
import { CanvasTextEditor, canvasTextKeyAction, createTextEditorFinisher, normalizeEditablePlainText } from '../../design-system/canvas-atoms'
import { canvasTextEditorStyle } from './SelectionHud'

const textStyle: TextStyle = {
  fontFamily: 'Inter, sans-serif',
  fontStyle: 'normal',
  fontWeight: 500,
  fontSize: 18,
  lineHeight: { kind: 'source', property: '--design-line-height', fallback: { kind: 'percent', value: 125 } },
  letterSpacing: 0.25,
  horizontalAlign: 'center',
  verticalAlign: 'middle',
  case: 'none',
  wrap: 'pretty',
  keepWords: true,
}
const textSizing: TextSizing = { width: { mode: 'fixed' }, height: { mode: 'fixed' } }

describe('PAPER-TEXT-004 canvas text editor surface', () => {
  it('fails closed instead of reconstructing a transformed editor from transient rectangles', () => {
    const source = readFileSync(new URL('./SelectionHud.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('selectionHudRect')
    expect(source).not.toContain('transient.rects')
    expect(source).not.toContain('<CanvasTextEditor')
  })
  it('renders one plaintext contenteditable with an accessible multiline name instead of a textarea', () => {
    const html = renderToStaticMarkup(createElement(CanvasTextEditor, {
      id: 'text-1',
      value: 'First\nSecond',
      label: 'Edit text in Heading',
      style: { left: 10, top: 20, width: 120, height: 40, transform: 'rotate(20deg) scale(2)' },
      onUpdate: vi.fn(),
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      onTraverse: vi.fn(),
    }))

    expect(html).toContain('role="textbox"')
    expect(html).toContain('aria-label="Edit text in Heading"')
    expect(html).toContain('aria-multiline="true"')
    expect(html).toContain('contentEditable="plaintext-only"')
    expect(html).toContain('data-editing="text-1"')
    expect(html).toContain('transform:rotate(20deg) scale(2)')
    expect(html).not.toContain('<textarea')
  })

  it('keeps the editor on the oriented node face while preserving unscaled text metrics', () => {
    expect(canvasTextEditorStyle({ x: 100, y: 80, width: 240, height: 120 }, 30, 2, textStyle, textSizing)).toMatchObject({
      left: 160,
      top: 110,
      width: 120,
      height: 60,
      transform: 'rotate(30deg) scale(2)',
      fontFamily: 'Inter, sans-serif',
      fontWeight: 500,
      fontSize: '18px',
      lineHeight: 'var(--design-line-height, 125%)',
      letterSpacing: '0.045px',
      textAlign: 'center',
      alignContent: 'center',
      whiteSpace: 'pre-wrap',
      textWrap: 'pretty',
      overflowWrap: 'normal',
    })
  })

  it('keeps the editable glyph layer transparent while leaving a visible selection caret', () => {
    const css = readFileSync(new URL('../../design-system/canvas.css', import.meta.url), 'utf8')
    const rule = /\.canvas-text-editor\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''

    expect(rule).toContain('color: transparent')
    expect(rule).toContain('-webkit-text-fill-color: transparent')
    expect(rule).toContain('caret-color: var(--color-4)')
    expect(css).not.toContain('textarea.node-label-editor')
  })
})

describe('PAPER-TEXT-005 keyboard and completion semantics', () => {
  it('distinguishes both newline keys from primary-modifier commit', () => {
    expect(canvasTextKeyAction({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false })).toBe('newline')
    expect(canvasTextKeyAction({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: true })).toBe('newline')
    expect(canvasTextKeyAction({ key: 'Enter', ctrlKey: true, metaKey: false, shiftKey: false })).toBe('commit')
    expect(canvasTextKeyAction({ key: 'Enter', ctrlKey: false, metaKey: true, shiftKey: false })).toBe('commit')
  })

  it('maps Escape and both Tab directions without treating ordinary keys as commands', () => {
    expect(canvasTextKeyAction({ key: 'Escape', ctrlKey: false, metaKey: false })).toBe('cancel')
    expect(canvasTextKeyAction({ key: 'Tab', ctrlKey: false, metaKey: false, shiftKey: false })).toBe('next')
    expect(canvasTextKeyAction({ key: 'Tab', ctrlKey: false, metaKey: false, shiftKey: true })).toBe('previous')
    expect(canvasTextKeyAction({ key: 'a', ctrlKey: false, metaKey: false })).toBe('continue')
  })

  it('leaves IME composition in control of Escape, Tab, and primary-modifier Enter', () => {
    expect(canvasTextKeyAction({ key: 'Escape', ctrlKey: false, metaKey: false, isComposing: true })).toBe('continue')
    expect(canvasTextKeyAction({ key: 'Tab', ctrlKey: false, metaKey: false, isComposing: true })).toBe('continue')
    expect(canvasTextKeyAction({ key: 'Enter', ctrlKey: true, metaKey: false, isComposing: true })).toBe('continue')
  })

  it('removes only the Chromium terminal caret sentinel created by a line break', () => {
    expect(normalizeEditablePlainText('First\n\n', 'insertParagraph')).toBe('First\n')
    expect(normalizeEditablePlainText('First\n\n', 'insertLineBreak')).toBe('First\n')
    expect(normalizeEditablePlainText('First\n\n\n', 'insertParagraph')).toBe('First\n\n')
    expect(normalizeEditablePlainText('First\n\n', 'insertFromPaste')).toBe('First\n\n')
    expect(normalizeEditablePlainText('First\n\nSecond', 'insertParagraph')).toBe('First\n\nSecond')
    expect(normalizeEditablePlainText('First\r\nSecond', 'insertText')).toBe('First\nSecond')
  })

  it('allows only the first blur or keyboard completion to finish the session', () => {
    const action = vi.fn()
    const ignored = vi.fn()
    const finish = createTextEditorFinisher()

    expect(finish(action)).toBe(true)
    expect(finish(ignored)).toBe(false)
    expect(action).toHaveBeenCalledOnce()
    expect(ignored).not.toHaveBeenCalled()
  })
})
