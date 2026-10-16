import { describe, expect, it } from 'vitest'
import { applyFileCommand, createBlankFile, pageRoot } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument } from '@canvas/repo-engine/file-document'
import { duplicatePlan, frameSelectionPlan, layerOrderPlan, ungroupPlan } from './context-menu-commands'

const atoms: Parameters<typeof applyFileCommand>[2] = []
const fixture = () => {
  let file = createBlankFile('file-1', 'page-1', 'root-1', 'Page 1')
  const insert = (command: FileCommand) => { file = applyFileCommand(file, command, atoms) }
  insert({ type: 'node.insert', node: { id: 'a', type: 'rectangle', name: 'A', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 30, height: 40 } }, placement: { parentId: pageRoot(file, 'page-1')! } })
  insert({ type: 'node.insert', node: { id: 'b', type: 'rectangle', name: 'B', styles: { relativeTransform: [1, 0, 0, 1, 70, 20], width: 20, height: 40 } }, placement: { parentId: pageRoot(file, 'page-1')! } })
  return file
}
const run = (file: FileDocument, commands: FileCommand[]) => commands.reduce((current, command) => applyFileCommand(current, command, atoms), file)

describe('context menu command plans', () => {
  it('duplicates on top without offset and offset-pastes beside the source', () => {
    const onTop = duplicatePlan(fixture(), ['a'], () => 'copy-a', true)
    const beside = duplicatePlan(fixture(), ['a'], () => 'copy-b', false)
    expect(onTop.commands[0]).not.toHaveProperty('offset')
    expect(beside.commands[0]).toMatchObject({ offset: { x: 50, y: 0 } })
  })

  it('maps forward and back to sibling order without wrapping', () => {
    expect(layerOrderPlan(fixture(), ['a'], 'forward')).toEqual([{ type: 'node.reorder', nodeId: 'a', index: 1 }])
    expect(layerOrderPlan(fixture(), ['a'], 'backward')).toEqual([])
    expect(layerOrderPlan(fixture(), ['b'], 'front')).toEqual([])
  })

  it('frames primitive siblings and can ungroup the resulting frame', () => {
    const plan = frameSelectionPlan(fixture(), 'page-1', ['a', 'b'], () => 'frame-1')!
    const framed = run(fixture(), plan.commands)
    expect(framed.nodes['frame-1']).toMatchObject({ type: 'frame', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 80, height: 40 } })
    expect(framed.relationships.a?.parentId).toBe('frame-1')
    const ungroup = ungroupPlan(framed, ['frame-1'])!
    const restored = run(framed, ungroup.commands)
    expect(restored.nodes['frame-1']).toBeUndefined()
    expect(restored.relationships.a?.parentId).toBe('root-1')
  })
})
