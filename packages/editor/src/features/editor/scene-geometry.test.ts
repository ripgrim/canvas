import { afterEach, describe, expect, it } from 'vitest'
import { sceneGeometry } from './scene-geometry'

afterEach(() => sceneGeometry.clear())

describe('CLOUD-SYNC-GESTURE-001 runtime-issued measurement authority', () => {
  it('stores the accepted runtime token exactly and permits a replacement generation to restart it', () => {
    sceneGeometry.update(
      { selected: { rect: { x: 10, y: 20, width: 30, height: 40 } } },
      { documentRevision: 8, layoutGeneration: 3, measurementRevision: 57 },
    )
    expect(sceneGeometry.getSnapshot()).toStrictEqual({
      nodes: { selected: { rect: { x: 10, y: 20, width: 30, height: 40 } } },
      revision: 57,
      documentRevision: 8,
      layoutGeneration: 3,
      unsupported: {},
      themeUnsupported: {},
      unownedPortals: 0,
    })

    sceneGeometry.clear()
    expect(sceneGeometry.getSnapshot()).toStrictEqual({ nodes: {}, revision: 0, documentRevision: null, layoutGeneration: null, gap: 'retired', unsupported: {}, themeUnsupported: {}, unownedPortals: 0 })
    sceneGeometry.clear('temporary')
    expect(sceneGeometry.getSnapshot()).toMatchObject({ nodes: {}, documentRevision: null, layoutGeneration: null, gap: 'temporary' })
    sceneGeometry.update({}, { documentRevision: 8, layoutGeneration: 3, measurementRevision: 1 })
    expect(sceneGeometry.getSnapshot()).toStrictEqual({ nodes: {}, revision: 1, documentRevision: 8, layoutGeneration: 3, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 })
  })
})
