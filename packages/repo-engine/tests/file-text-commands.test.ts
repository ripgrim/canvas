import { describe, expect, it } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, validateFileCommand } from '../src/file-document.js'
import type { FileCommand, FileDocument, TextSizing, TextStyle } from '../src/file-document.js'

const baseStyle = (): TextStyle => ({
  fontFamily: 'Inter',
  fontStyle: 'normal',
  fontWeight: 400,
  fontSize: 16,
  lineHeight: { kind: 'normal' },
  letterSpacing: 0,
  horizontalAlign: 'left',
  verticalAlign: 'top',
  case: 'none',
  wrap: 'normal',
  keepWords: false,
})

const nextStyle = (): TextStyle => ({
  fontFamily: 'Geist Sans',
  fontStyle: 'italic',
  fontWeight: 650,
  fontSize: 28,
  lineHeight: { kind: 'percent', value: 125 },
  letterSpacing: -0.25,
  horizontalAlign: 'center',
  verticalAlign: 'middle',
  case: 'uppercase',
  wrap: 'balance',
  keepWords: true,
  maxLines: 3,
})

const fixedSizing = (): TextSizing => ({ width: { mode: 'fixed' }, height: { mode: 'fixed' } })
const fitSizing = (): TextSizing => ({ width: { mode: 'fit' }, height: { mode: 'fit' } })

const fixture = (): FileDocument => ({
  schemaVersion: 12, componentModel: { definitions: {}, instances: {} },
  fileId: 'text-command-file',
  revision: 4,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'text-1': { id: 'text-1', type: 'text', name: 'Label', text: 'Hello', textStyle: baseStyle(), textSizing: fixedSizing(), styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 120, height: 32 } },
    'box-1': { id: 'box-1', type: 'rectangle', name: 'Box', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 50, height: 50 } },
  },
  relationships: {
    'text-1': { parentId: 'root-1', orderKey: 'V' },
    'box-1': { parentId: 'root-1', orderKey: 'W' },
  },
  theme: { tokens: {} },
})

const command = (): Extract<FileCommand, { type: 'node.setTextProperties' }> => ({ type: 'node.setTextProperties', nodeId: 'text-1', textStyle: nextStyle(), textSizing: fitSizing() })

describe('PAPER-TEXT-005 atomic text property command', () => {
  it('accepts one exact complete payload and returns a detached command', () => {
    const input = command()
    const validated = validateFileCommand(input)
    expect(validated).toEqual({ type: 'node.setTextProperties', nodeId: 'text-1', textStyle: nextStyle(), textSizing: fitSizing() })
    expect(validated).not.toBe(input)
    expect((validated as Extract<FileCommand, { type: 'node.setTextProperties' }>).textStyle).not.toBe((input as Extract<FileCommand, { type: 'node.setTextProperties' }>).textStyle)
  })

  it('rejects incomplete, extra, unsafe and internally inconsistent payloads', () => {
    const valid = command()
    expect(() => validateFileCommand({ type: valid.type, nodeId: valid.nodeId, textStyle: valid.textStyle })).toThrow('Invalid file command')
    expect(() => validateFileCommand({ ...valid, unexpected: true })).toThrow('Invalid file command')
    expect(() => validateFileCommand({ ...valid, textStyle: { ...valid.textStyle, lineHeight: { kind: 'source', property: 'line-height', fallback: { kind: 'normal' } } } })).toThrow('Invalid file command')
    expect(() => validateFileCommand({ ...valid, textSizing: fixedSizing() })).toThrow('Invalid file command')
    expect(() => validateFileCommand({ ...valid, textStyle: { ...valid.textStyle, maxLines: 0 } })).toThrow('Invalid file command')
  })

  it('writes style and sizing together, refuses non-text targets, and keeps root sizing constraints', () => {
    const next = applyFileCommand(fixture(), command(), [])
    expect(next.revision).toBe(5)
    expect(next.nodes['text-1']).toMatchObject({ textStyle: nextStyle(), textSizing: fitSizing() })
    expect(() => applyFileCommand(fixture(), { ...command(), nodeId: 'box-1' }, [])).toThrow('Only text nodes carry valid text properties')
    expect(() => applyFileCommand(fixture(), { ...command(), textStyle: baseStyle(), textSizing: { width: { mode: 'fill' }, height: { mode: 'fixed' } } }, [])).toThrow('Root text cannot use parent-relative sizing')
  })
})

describe('PAPER-TEXT-006 and PAPER-TEXT-008 semantic history', () => {
  it('produces an exact inverse and a final redo whose complete payload equals the stored state', () => {
    const before = fixture()
    const projection = applyFileCommandWithHistory(before, command(), [])
    expect(projection.undo).toEqual({ type: 'node.setTextProperties', nodeId: 'text-1', textStyle: baseStyle(), textSizing: fixedSizing() })
    expect(projection.redo).toEqual({ type: 'node.setTextProperties', nodeId: 'text-1', textStyle: nextStyle(), textSizing: fitSizing() })

    const stored = projection.file.nodes['text-1']
    if (!stored || stored.type !== 'text') throw new Error('Expected text node')
    const redo = projection.redo as Extract<FileCommand, { type: 'node.setTextProperties' }>
    expect({ textStyle: redo.textStyle, textSizing: redo.textSizing }).toEqual({ textStyle: stored.textStyle, textSizing: stored.textSizing })

    const undone = applyFileCommand(projection.file, projection.undo, [])
    expect({ textStyle: (undone.nodes['text-1'] as typeof stored).textStyle, textSizing: (undone.nodes['text-1'] as typeof stored).textSizing }).toEqual({ textStyle: baseStyle(), textSizing: fixedSizing() })
    const redone = applyFileCommand(undone, projection.redo, [])
    expect({ textStyle: (redone.nodes['text-1'] as typeof stored).textStyle, textSizing: (redone.nodes['text-1'] as typeof stored).textSizing }).toEqual({ textStyle: nextStyle(), textSizing: fitSizing() })
  })

  it('keeps a text property change and content change in one batch revision with reverse-order undo', () => {
    const projection = applyFileCommandWithHistory(fixture(), { type: 'batch', commands: [command(), { type: 'node.setText', nodeId: 'text-1', text: 'Updated' }] }, [])
    expect(projection.file.revision).toBe(5)
    expect(projection.redo).toEqual({ type: 'batch', commands: [command(), { type: 'node.setText', nodeId: 'text-1', text: 'Updated' }] })
    expect(projection.undo).toEqual({ type: 'batch', commands: [{ type: 'node.setText', nodeId: 'text-1', text: 'Hello' }, { type: 'node.setTextProperties', nodeId: 'text-1', textStyle: baseStyle(), textSizing: fixedSizing() }] })
    const restored = applyFileCommand(projection.file, projection.undo, [])
    expect(restored.nodes['text-1']).toMatchObject({ text: 'Hello', textStyle: baseStyle(), textSizing: fixedSizing() })
  })
})
