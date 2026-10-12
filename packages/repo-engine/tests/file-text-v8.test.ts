import { describe, expect, it } from 'vitest'
import { validateFileCommand, validateFileDocument } from '../src/file-document.js'
import { upgradeFileDocument } from '../src/file-migration.js'
import { projectPreviewPage } from '../src/file-preview.js'

const legacyTypography = {
  fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
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
const fixedSizing = { width: { mode: 'fixed' }, height: { mode: 'fixed' } } as const
const legacyFile = () => ({
  schemaVersion: 7,
  fileId: 'file-1',
  revision: 3,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    label: { id: 'label', type: 'text', name: 'Label', styles: { left: 10, top: 20, width: 160, height: 40 }, text: 'Hello', themeMode: 'inherit' },
    box: { id: 'box', type: 'rectangle', name: 'Box', styles: { left: 0, top: 0, width: 100, height: 80 }, themeMode: 'inherit' },
  },
  relationships: { label: { parentId: 'root-1', orderKey: 'V' }, box: { parentId: 'root-1', orderKey: 'W' } },
  theme: { tokens: {} },
})
const currentFile = () => ({
  schemaVersion: 9,
  fileId: 'file-1',
  revision: 3,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    label: { id: 'label', type: 'text', name: 'Label', styles: { left: 10, top: 20, width: 160, height: 40 }, text: 'Hello', textStyle: structuredClone(legacyTypography) as Record<string, unknown>, textSizing: structuredClone(fixedSizing) as { width: { mode: string; value?: number }; height: { mode: string; value?: number } }, themeMode: 'inherit' },
    box: { id: 'box', type: 'rectangle', name: 'Box', styles: { left: 0, top: 0, width: 100, height: 80 }, themeMode: 'inherit' },
  } as Record<string, Record<string, unknown>> & { label: { textStyle: Record<string, unknown>; textSizing: { width: { mode: string; value?: number }; height: { mode: string; value?: number } } }; box: Record<string, unknown> },
  relationships: { label: { parentId: 'root-1', orderKey: 'V' }, box: { parentId: 'root-1', orderKey: 'W' } } as Record<string, { parentId: string; orderKey: string }>,
  theme: { tokens: {} },
})

describe('PAPER-TEXT-001 and PAPER-TEXT-003: current text storage', () => {
  it('migrates v7 text to literal legacy typography and fixed bounds without changing unrelated content', () => {
    const input = legacyFile()
    const upgraded = upgradeFileDocument(input)
    expect(upgraded).toStrictEqual({
      ...input,
      schemaVersion: 9,
      nodes: {
        ...input.nodes,
        label: { ...input.nodes.label, textStyle: legacyTypography, textSizing: fixedSizing },
      },
    })
    expect(validateFileDocument(upgraded, [])).toStrictEqual(upgraded)
  })

  it('rejects incomplete typography, arbitrary line-height strings, and text-only fields on rectangles', () => {
    const missingFamily = currentFile()
    delete missingFamily.nodes.label.textStyle.fontFamily
    expect(() => validateFileDocument(missingFamily, [])).toThrow('Invalid node text')

    const arbitraryCss = currentFile()
    arbitraryCss.nodes.label.textStyle.lineHeight = 'calc(100vh)'
    expect(() => validateFileDocument(arbitraryCss, [])).toThrow('Invalid node text')

    const rectangleText = currentFile() as unknown as { nodes: { box: Record<string, unknown> } }
    rectangleText.nodes.box.textStyle = { ...legacyTypography }
    expect(() => validateFileDocument(rectangleText, [])).toThrow('Invalid node text')
  })

  it('requires explicit text properties on insert commands', () => {
    const node = { id: 'new-text', type: 'text', name: 'Text', styles: { left: 0, top: 0, width: 120, height: 24 }, text: 'New' }
    expect(() => validateFileCommand({ type: 'node.insert', node, placement: { parentId: 'root-1' } })).toThrow('Invalid file command')
    expect(validateFileCommand({ type: 'node.insert', node: { ...node, textStyle: legacyTypography, textSizing: fixedSizing }, placement: { parentId: 'root-1' } }).type).toBe('node.insert')
  })

  it('rejects parent-relative root text but retains it for a frame child', () => {
    for (const axis of ['width', 'height'] as const) for (const mode of ['fill', 'relative'] as const) {
      const rootText = currentFile()
      rootText.nodes.label.textSizing[axis] = mode === 'fill' ? { mode } : { mode, value: 50 }
      expect(() => validateFileDocument(rootText, [])).toThrow('Root text cannot use parent-relative sizing')
    }

    const nested = currentFile()
    nested.nodes.frame = { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 0, top: 0, width: 300, height: 200 }, themeMode: 'inherit' }
    nested.relationships.frame = { parentId: 'root-1', orderKey: 'X' }
    nested.relationships.label = { parentId: 'frame', orderKey: 'V' }
    nested.nodes.label.textSizing = { width: { mode: 'relative', value: 50 }, height: { mode: 'fill' } }
    expect(validateFileDocument(nested, []).nodes.label).toMatchObject({ textSizing: { width: { mode: 'relative', value: 50 }, height: { mode: 'fill' } } })
  })

  it('allows max-lines only when height is Fit', () => {
    const fixed = currentFile()
    fixed.nodes.label.textStyle.maxLines = 2
    expect(() => validateFileDocument(fixed, [])).toThrow('Invalid node text')
    fixed.nodes.label.textSizing.height = { mode: 'fit' }
    expect(validateFileDocument(fixed, []).nodes.label).toMatchObject({ textStyle: { maxLines: 2 }, textSizing: { height: { mode: 'fit' } } })
  })
})

describe('PAPER-TEXT-002: text preview projection', () => {
  it('projects literal authoritative text fields and no text fields on other primitives', () => {
    const file = validateFileDocument(upgradeFileDocument(legacyFile()), [])
    const elements = projectPreviewPage(file, 'page-1')!.document.canvas.elements
    expect(elements[0]).toStrictEqual({ id: 'label', kind: 'text', name: 'Label', x: 10, y: 20, width: 160, height: 40, rotation: 0, parentId: null, text: 'Hello', textStyle: legacyTypography, textSizing: fixedSizing })
    expect(elements[1]).not.toHaveProperty('textStyle')
    expect(elements[1]).not.toHaveProperty('textSizing')
  })
})
