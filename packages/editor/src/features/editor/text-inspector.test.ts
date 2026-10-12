import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { InspectorPopover, InspectorToggle } from '../../design-system/inspector-atoms'
import { hasTextSizingReference, setTextSizingMode, TextInspector, textSizingModes, writeTextMaxLines, writeTextProperties, writeTextTruncation } from './TextInspector'
import type { TextNode } from './TextInspector'

const style = (overrides: Partial<TextNode['textStyle']> = {}): TextNode['textStyle'] => ({
  fontFamily: 'Inter, sans-serif', fontStyle: 'normal', fontWeight: 400, fontSize: 16,
  lineHeight: { kind: 'unitless', value: 1.25 }, letterSpacing: 0,
  horizontalAlign: 'left', verticalAlign: 'top', case: 'none', wrap: 'normal', keepWords: false,
  ...overrides,
})
const text = (id: string, overrides: Partial<TextNode> = {}): TextNode => ({
  id, type: 'text', name: 'Text', text: 'Hello', styles: { left: 0, top: 0, width: 160, height: 40 },
  textStyle: style(), textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } },
  ...overrides,
})
const file = (nodes: readonly TextNode[], parent = false): FileDocument => {
  const root = { id: 'root', type: 'root' as const }
  const frame = { id: 'frame', type: 'frame' as const, name: 'Frame', styles: { left: 0, top: 0, width: 400, height: 400 } }
  const parentId = parent ? frame.id : root.id
  return {
    schemaVersion: 9, fileId: 'file', revision: 1,
    nodes: { [root.id]: root, ...(parent ? { [frame.id]: frame } : {}), ...Object.fromEntries(nodes.map(node => [node.id, node])) },
    pages: [{ id: 'page', name: 'Page', rootNodeId: root.id }], theme: { tokens: {} },
    relationships: { ...(parent ? { [frame.id]: { parentId: root.id, orderKey: 'V' } } : {}), ...Object.fromEntries(nodes.map((node, index) => [node.id, { parentId, orderKey: String.fromCharCode(87 + index) }])) },
  } as FileDocument
}

describe('PAPER-TEXT-006 complete inspector commands', () => {
  it('maps a field edit to one complete style and sizing payload without mutating the selected node', () => {
    const node = text('text-a')
    const write = vi.fn((_entries: readonly { nodeId: string; textStyle: TextNode['textStyle']; textSizing: TextNode['textSizing'] }[]) => true)
    expect(writeTextProperties([node], next => { next.fontSize = 28 }, write)).toBe(1)
    expect(write).toHaveBeenCalledWith([{ nodeId: 'text-a', textStyle: { ...style(), fontSize: 28 }, textSizing: { width: { mode: 'fixed' }, height: { mode: 'fit' } } }])
    expect(node.textStyle.fontSize).toBe(16)
    expect(node.textSizing).toEqual({ width: { mode: 'fixed' }, height: { mode: 'fit' } })
  })

  it('removes incompatible truncation in the same height-sizing command', () => {
    const node = text('text-a', { textStyle: style({ maxLines: 3 }) })
    const write = vi.fn((_entries: readonly { nodeId: string; textStyle: TextNode['textStyle']; textSizing: TextNode['textSizing'] }[]) => true)
    expect(setTextSizingMode([node], 'height', 'fixed', write)).toBe(1)
    const { textStyle: nextStyle, textSizing: nextSizing } = write.mock.calls[0]![0][0]!
    expect(nextStyle).not.toHaveProperty('maxLines')
    expect(nextSizing.height).toEqual({ mode: 'fixed' })
  })

  it('uses the dedicated max-line command for truncation and clamps direct line-count edits', () => {
    const a = text('a')
    const b = text('b', { textStyle: style({ maxLines: 4 }) })
    const write = vi.fn((_entries: readonly { nodeId: string; maxLines: number | undefined }[]) => true)
    expect(writeTextTruncation([a, b], true, write)).toBe(2)
    expect(write).toHaveBeenCalledWith([{ nodeId: 'a', maxLines: 1 }, { nodeId: 'b', maxLines: 4 }])
    write.mockClear()
    expect(writeTextTruncation([a, b], false, write)).toBe(2)
    expect(write).toHaveBeenCalledWith([{ nodeId: 'a', maxLines: undefined }, { nodeId: 'b', maxLines: undefined }])
    write.mockClear()
    expect(writeTextMaxLines([a], 0, write)).toBe(1)
    expect(write).toHaveBeenCalledWith([{ nodeId: 'a', maxLines: 1 }])
  })

  it('negative control skips a semantic command when the complete state is unchanged', () => {
    const node = text('text-a', { textSizing: { width: { mode: 'relative', value: 62.5 }, height: { mode: 'fit' } } })
    const write = vi.fn((_entries: readonly { nodeId: string; textStyle: TextNode['textStyle']; textSizing: TextNode['textSizing'] }[]) => true)
    expect(writeTextProperties([node], () => undefined, write)).toBe(0)
    expect(setTextSizingMode([node], 'width', 'relative', write)).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('PAPER-TEXT-007 Paper-order inspector presentation', () => {
  it('omits Fill and Relative sizing at the root and exposes them only with a reference parent', () => {
    const node = text('text-a')
    const rootFile = file([node])
    expect(hasTextSizingReference(rootFile, node)).toBe(false)
    expect(textSizingModes(rootFile, [node])).toEqual(['fixed', 'fit'])
    const nestedFile = file([node], true)
    expect(hasTextSizingReference(nestedFile, node)).toBe(true)
    expect(textSizingModes(nestedFile, [node])).toEqual(['fixed', 'fit', 'fill', 'relative'])
  })

  it('renders mixed values honestly instead of choosing the first selected node', () => {
    const a = text('a')
    const b = text('b', { textStyle: style({ fontFamily: 'Georgia, serif', keepWords: true, horizontalAlign: 'right' }), textSizing: { width: { mode: 'fit' }, height: { mode: 'fit' } } })
    const html = renderToStaticMarkup(h(TextInspector, { file: file([a, b]), nodes: [a, b], disabled: false }))
    expect(html).toContain('placeholder="Mixed"')
    expect(html).toContain('Mixed')
    expect(html).not.toContain('value="Inter, sans-serif"')
    expect(html).not.toContain('value="Georgia, serif"')
    const toggle = renderToStaticMarkup(h(InspectorToggle, { label: 'Keep words', value: null, onChange: () => undefined }))
    expect(toggle).toContain('role="checkbox"')
    expect(toggle).toContain('aria-checked="mixed"')
  })

  it('keeps Text after Fill and before later appearance sections without moving Theme or duplicating Typography', () => {
    const inspector = readFileSync(new URL('./InspectorPanels.tsx', import.meta.url), 'utf8')
    const appearance = readFileSync(new URL('./AppearancePanels.tsx', import.meta.url), 'utf8')
    expect(inspector.indexOf('<NodeThemeSection')).toBeLessThan(inspector.indexOf('<AppearanceSections'))
    expect(inspector).toContain('afterFill={textNodes.length ? <TextInspector')
    expect(inspector).not.toContain('id="typography"')
    expect(appearance).toMatch(/BlendingSection[\s\S]*FillSection[\s\S]*afterFill[\s\S]*OutlineSection[\s\S]*BorderSection/)
  })

  it('uses Base UI for the formatting popup and exposes one named keyboard trigger', () => {
    const html = renderToStaticMarkup(h(InspectorPopover, { label: 'Text formatting', icon: 'text', children: h('span', null, 'Options') }))
    expect(html).toContain('aria-label="Text formatting"')
    expect(html).toContain('title="Text formatting"')
    const source = readFileSync(new URL('../../design-system/inspector-atoms.tsx', import.meta.url), 'utf8')
    expect(source).toContain("import { Popover } from '@base-ui/react/popover'")
    expect(source).toContain('<Popover.Trigger')
    expect(source).toContain('<Popover.Popup')
  })

  it('uses the same compact icon-only alignment rows as Paper without losing accessible names', () => {
    const node = text('text-a')
    const html = renderToStaticMarkup(h(TextInspector, { file: file([node]), nodes: [node], disabled: false }))
    expect(html).toContain('data-icon-style="filled"')
    expect(html).toContain('aria-label="Left"')
    expect(html).toContain('aria-label="Center"')
    expect(html).toContain('aria-label="Right"')
    expect(html).toContain('aria-label="Top"')
    expect(html).toContain('aria-label="Middle"')
    expect(html).toContain('aria-label="Bottom"')
    expect(html).not.toContain('<span class="inspector-segment-label">Left</span>')
    expect(html).not.toContain('<span class="inspector-segment-label">Middle</span>')
  })

  it('matches Paper text-control order, density, and the shared exact icon set', () => {
    const node = text('text-a')
    const html = renderToStaticMarkup(h(TextInspector, { file: file([node]), nodes: [node], disabled: false }))
    const formatting = html.indexOf('aria-label="Text formatting"')
    const family = html.indexOf('id="text-family"')
    const variant = html.indexOf('id="text-variant"')
    const size = html.indexOf('id="text-size"')
    const lineHeight = html.indexOf('id="text-line-height"')
    const tracking = html.indexOf('id="text-letter-spacing"')
    const horizontal = html.indexOf('aria-label="Horizontal alignment"')
    const vertical = html.indexOf('aria-label="Vertical alignment"')
    const width = html.indexOf('id="text-width"')
    const height = html.indexOf('id="text-height"')

    expect([formatting, family, variant, size, lineHeight, tracking, horizontal, vertical, width, height].every(index => index >= 0)).toBe(true)
    expect(formatting).toBeLessThan(family)
    expect(family).toBeLessThan(variant)
    expect(variant).toBeLessThan(size)
    expect(size).toBeLessThan(lineHeight)
    expect(lineHeight).toBeLessThan(tracking)
    expect(tracking).toBeLessThan(horizontal)
    expect(horizontal).toBeLessThan(vertical)
    expect(vertical).toBeLessThan(width)
    expect(width).toBeLessThan(height)
    expect(html).toContain('data-icon="text-settings"')
    expect(html).toContain('data-icon="font-family"')
    expect(html).toContain('data-icon="font-style"')
    expect(html).toContain('data-icon="font-size"')
    expect(html).toContain('data-icon="line-height"')
    expect(html).toContain('data-icon="letter-spacing"')
    expect(html).toContain('value="0"')
    expect(html).toMatch(/<span class="inspector-field-suffix"[^>]*>%<\/span>/)
    expect(html).not.toContain('>Font family<')
    expect(html).not.toContain('>Font size<')
  })
})
