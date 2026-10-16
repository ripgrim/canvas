import { describe, expect, it } from 'vitest'
import { applyFileCommand, createBlankFile } from '@canvas/repo-engine/file-document'
import type { ImageAssetReference } from '@canvas/repo-engine/file-document'
import { planClipboardImageInsertion } from './clipboard-image-insertion'

const asset = (id: string, width: number, height: number): ImageAssetReference => ({ id, name: `${id}.png`, mime: 'image/png', extension: 'png', bytes: 4, width, height, sha256: (id === 'two' ? 'b' : 'a').repeat(64) })
const ids = (...values: string[]) => { let index = 0; return () => values[index++]! }

describe('PAPER-CLIP-005 image insertion placement', () => {
  it('centers an ordered image row, scales it to the visible viewport, and validates one batch', () => {
    const file = createBlankFile('file', 'page', 'root')
    const plan = planClipboardImageInsertion(file, 'page', [asset('one', 800, 400), asset('two', 200, 400)], { center: { x: 100, y: 80 }, visibleSize: { width: 500, height: 300 }, selection: [] }, ids('node-1', 'fill-1', 'node-2', 'fill-2'))
    expect(plan.selection).toEqual(['node-1', 'node-2'])
    const next = applyFileCommand(file, plan.command, [], { allowUnavailableBindings: true })
    expect(next.nodes['node-1']).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, -86, 20], width: 240, height: 120 }, appearance: { fills: [{ assetId: 'one' }] } })
    expect(next.nodes['node-2']).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 166, -40], width: 120, height: 240 }, appearance: { fills: [{ assetId: 'two' }] } })
    expect(next.assets).toEqual({ one: asset('one', 800, 400), two: asset('two', 200, 400) })
  })

  it('places flow children directly into a selected flex frame', () => {
    const file = createBlankFile('file', 'page', 'root')
    file.nodes.frame = {
      id: 'frame', type: 'frame', name: 'Frame',
      styles: { relativeTransform: [1, 0, 0, 1, 50, 60], width: 500, height: 300 },
      layout: {
        item: { position: { mode: 'freeform' } },
        container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'start' } },
      },
    }
    file.relationships.frame = { parentId: 'root', orderKey: 'V' }
    const plan = planClipboardImageInsertion(file, 'page', [asset('one', 100, 50)], { center: { x: 0, y: 0 }, visibleSize: { width: 1000, height: 800 }, selection: ['frame'] }, ids('node', 'fill'))
    const next = applyFileCommand(file, plan.command, [], { allowUnavailableBindings: true })
    expect(next.relationships.node?.parentId).toBe('frame')
    expect(next.nodes.node).toMatchObject({ layout: { item: { position: { mode: 'flow' } } }, styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 100, height: 50 } })
  })

  it('falls back to the page root when the selection cannot contain children', () => {
    const file = createBlankFile('file', 'page', 'root')
    file.nodes.box = { id: 'box', type: 'rectangle', name: 'Box', styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 40, height: 40 } }
    file.relationships.box = { parentId: 'root', orderKey: 'V' }
    const plan = planClipboardImageInsertion(file, 'page', [asset('one', 20, 10)], { center: { x: 100, y: 100 }, visibleSize: { width: 500, height: 500 }, selection: ['box'] }, ids('node', 'fill'))
    const next = applyFileCommand(file, plan.command, [], { allowUnavailableBindings: true })
    expect(next.relationships.node?.parentId).toBe('root')
  })

  it('climbs from an unsupported selected layer to the nearest compatible frame', () => {
    const file = createBlankFile('file', 'page', 'root')
    file.nodes.frame = { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 50, 60], width: 500, height: 300 } }
    file.nodes.child = { id: 'child', type: 'rectangle', name: 'Child', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 40, height: 40 } }
    file.relationships.frame = { parentId: 'root', orderKey: 'V' }
    file.relationships.child = { parentId: 'frame', orderKey: 'V' }
    const plan = planClipboardImageInsertion(file, 'page', [asset('one', 20, 10)], { center: { x: 100, y: 100 }, visibleSize: { width: 500, height: 500 }, selection: ['child'] }, ids('node', 'fill'))
    const next = applyFileCommand(file, plan.command, [], { allowUnavailableBindings: true })
    expect(next.relationships.node?.parentId).toBe('frame')
    expect(next.nodes.node).toMatchObject({ styles: { relativeTransform: [1, 0, 0, 1, 40, 35] } })
  })

  it('falls back to the page root when a drop point is outside the selected frame', () => {
    const file = createBlankFile('file', 'page', 'root')
    file.nodes.frame = { id: 'frame', type: 'frame', name: 'Frame', styles: { relativeTransform: [1, 0, 0, 1, 50, 60], width: 100, height: 100 } }
    file.relationships.frame = { parentId: 'root', orderKey: 'V' }
    const plan = planClipboardImageInsertion(file, 'page', [asset('one', 20, 10)], { center: { x: 300, y: 300 }, visibleSize: { width: 500, height: 500 }, selection: ['frame'], containSelectionAtCenter: true }, ids('node', 'fill'))
    const next = applyFileCommand(file, plan.command, [], { allowUnavailableBindings: true })
    expect(next.relationships.node?.parentId).toBe('root')
  })
})
