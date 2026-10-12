import { describe, expect, it } from 'vitest'
import { geometryMatchesProjection, unprojectGeometry } from './preview-service'

describe('PAPER-FLEX-001/002 preview geometry identity', () => {
  it('rejects missing, stale, and future layout generations even when the document revision matches', () => {
    const document = { revision: 7 }
    expect(geometryMatchesProjection({ documentRevision: 7 }, document, 4)).toBe(false)
    expect(geometryMatchesProjection({ documentRevision: 7, layoutGeneration: 3 }, document, 4)).toBe(false)
    expect(geometryMatchesProjection({ documentRevision: 7, layoutGeneration: 5 }, document, 4)).toBe(false)
    expect(geometryMatchesProjection({ documentRevision: 6, layoutGeneration: 4 }, document, 4)).toBe(false)
    expect(geometryMatchesProjection({ documentRevision: 7, layoutGeneration: 4 }, document, 4)).toBe(true)
  })

  it('preserves the runtime unrotated border box for a single authored overlay rotation', () => {
    const nodes = unprojectGeometry([
      { instanceId: 'rotated-flow', source: 'canvas', canvasKind: 'rectangle', bounds: { x: 500, y: 360, width: 160, height: 80 }, worldAabb: { x: 540, y: 320, width: 80, height: 160 }, offset: { x: 0, y: 0, width: 80, height: 40, origin: { x: 40, y: 20 } }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], directChild: true, transform: [0, 1, -1, 0, 0, 0] },
    ], { x: 20, y: -10, zoom: 2, width: 800, height: 600 }, 7, 4)
    expect(nodes['rotated-flow']).toMatchObject({ documentRevision: 7, layoutGeneration: 4, rect: { x: 40, y: 35, width: 80, height: 40 }, worldAabb: { x: 60, y: 15, width: 40, height: 80 }, offsetParentNodeId: null, offsetParentToRoot: [1, 0, 0, 1, 0, 0], transform: [0, 1, -1, 0, 0, 0] })
  })

  it('preserves resolved text metrics on the same revision and layout-generation fenced measurement', () => {
    const nodes = unprojectGeometry([
      { instanceId: 'text-1', source: 'canvas', canvasKind: 'text', bounds: { x: 400, y: 300, width: 200, height: 48 }, worldAabb: { x: 400, y: 300, width: 200, height: 48 }, text: { resolvedLineHeight: 24 } },
    ], { x: 0, y: 0, zoom: 2, width: 800, height: 600 }, 11, 9)
    expect(nodes['text-1']).toEqual({ canvasKind: 'text', documentRevision: 11, layoutGeneration: 9, rect: { x: 0, y: 0, width: 100, height: 24 }, worldAabb: { x: 0, y: 0, width: 100, height: 24 }, text: { resolvedLineHeight: 24 } })
    const fenced = { documentRevision: nodes['text-1']!.documentRevision!, layoutGeneration: nodes['text-1']!.layoutGeneration! }
    expect(geometryMatchesProjection(fenced, { revision: 10 }, 9)).toBe(false)
    expect(geometryMatchesProjection(fenced, { revision: 11 }, 8)).toBe(false)
    expect(geometryMatchesProjection(fenced, { revision: 11 }, 9)).toBe(true)
  })
})
