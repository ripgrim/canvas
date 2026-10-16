import { describe, expect, it } from 'vitest'
import { applyFileCommand, applyFileCommandWithHistory, frameAt, nodeWorldTransform, validateFileDocument, worldRect } from '../src/file-document.js'
import type { FileDocument, PrimitiveNode } from '../src/file-document.js'
import { transformPoint } from '../src/transform-matrix.js'
import { matrixFromLegacyPose } from '../src/layout-pose.js'

const source = (): FileDocument => validateFileDocument({
  schemaVersion: 13,
  fileId: 'matrix-file',
  revision: 0,
  pages: [{ id: 'page', name: 'Page', rootNodeId: 'root' }],
  nodes: {
    root: { id: 'root', type: 'root' },
    parent: { id: 'parent', type: 'frame', name: 'Parent', styles: { relativeTransform: matrixFromLegacyPose({ left: 100, top: 50, rotation: 90 }, { width: 100, height: 100 }), width: 100, height: 100 } },
    child: { id: 'child', type: 'rectangle', name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 20, height: 10 } },
  },
  relationships: {
    parent: { parentId: 'root', orderKey: 'V' },
    child: { parentId: 'parent', orderKey: 'V' },
  },
  theme: { tokens: {} },
  componentModel: { definitions: {}, instances: {} },
}, [])

describe('file geometry uses composed matrices', () => {
  it('MATRIX-LAYOUT-001 persists relativeTransform as the only primitive pose truth', () => {
    const file = source()
    const stored = JSON.stringify(file)
    const child = JSON.parse(stored).nodes.child

    expect(child.styles).toEqual({ relativeTransform: [1, 0, 0, 1, 10, 20], width: 20, height: 10 })
    expect(stored).toContain('\"relativeTransform\"')
    expect(stored).not.toMatch(/\"(?:left|top|rotation|flipX|flipY)\"\s*:/)
  })

  it('MATRIX-LAYOUT-002 composes nested relative transforms into world space', () => {
    const world = nodeWorldTransform(source(), 'child')
    expect(transformPoint(world, { x: 0, y: 0 })).toEqual({ x: 180, y: 60 })
    expect(worldRect(source(), 'child')).toEqual({ x: 170, y: 60, width: 10, height: 20 })
  })

  it('MATRIX-LAYOUT-003 uses inverse local geometry instead of the world AABB for frame hits', () => {
    const file = source()
    ;(file.nodes.parent as PrimitiveNode).styles.relativeTransform = matrixFromLegacyPose({ left: 100, top: 50, rotation: 45 }, { width: 100, height: 100 })
    const bounds = worldRect(file, 'parent')!
    // A rotated rectangle does not occupy the corners of its axis-aligned bounding box.
    expect(frameAt(file, 'page', { x: bounds.x + 1, y: bounds.y + 1 })).toBeNull()
    expect(frameAt(file, 'page', transformPoint(nodeWorldTransform(file, 'parent'), { x: 50, y: 50 }))).toBe('parent')
  })

  it('MATRIX-LAYOUT-HISTORY-001 preserves exact serialized bytes after transform edits undo and redo', () => {
    const before = source()
    const command = { type: 'node.setStyles' as const, nodeId: 'child', styles: { relativeTransform: matrixFromLegacyPose({ left: 27, top: -4, rotation: -35, flipX: true }, { width: 20, height: 10 }) } }
    const changed = applyFileCommandWithHistory(before, command, [])
    const undone = applyFileCommandWithHistory(changed.file, changed.undo, [])
    expect(JSON.stringify({ ...undone.file, revision: 0 })).toBe(JSON.stringify(before))
    const redone = applyFileCommand(undone.file, undone.undo, [])
    expect((redone.nodes.child as PrimitiveNode).styles).toEqual((changed.file.nodes.child as PrimitiveNode).styles)
  })

  it('MATRIX-LAYOUT-005 resize changes size without introducing transform scale', () => {
    const file = source()
    const before = nodeWorldTransform(file, 'child')
    const resized = applyFileCommand(file, { type: 'node.setStyles', nodeId: 'child', styles: { width: 80, height: 40 } }, [])
    expect(nodeWorldTransform(resized, 'child')).toEqual(before)
    expect((resized.nodes.child as PrimitiveNode).styles).toMatchObject({ width: 80, height: 40 })
  })

  it('MATRIX-LAYOUT-002 preserves the complete world transform when reparenting out of a rotated frame', () => {
    const file = source()
    const before = nodeWorldTransform(file, 'child')
    const moved = applyFileCommand(file, { type: 'node.reparent', nodeId: 'child', placement: { parentId: 'root' }, preserveWorldPosition: true }, [])
    const after = nodeWorldTransform(moved, 'child')
    before.forEach((value, index) => expect(after[index]).toBeCloseTo(value, 12))
    expect(moved.relationships.child?.parentId).toBe('root')
  })
})
