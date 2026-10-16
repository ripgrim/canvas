import { describe, expect, it } from 'vitest'
import { legacyTextProperties } from '@canvas/repo-engine/file-document'
import { externalizeHostedFileDocument, repairHostedFileDocument, validateHostedFileDocument } from '../src/index.js'

const blank = () => ({
  schemaVersion: 13,
  fileId: 'file-1',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' } },
  relationships: {},
  theme: { tokens: {} },
  componentModel: { definitions: {}, instances: {} },
})
const legacyBlank = (schemaVersion: number) => {
  const { componentModel: _componentModel, ...document } = blank()
  return { ...document, schemaVersion }
}

const advancedComponentDocument = () => ({
  ...blank(),
  nodes: {
    'root-1': { id: 'root-1', type: 'root' },
    'button-master': { id: 'button-master', type: 'frame', name: 'Button', styles: { relativeTransform: [1, 0, 0, 1, 20, 30], width: 160, height: 48 } },
    'button-face': { id: 'button-face', type: 'rectangle', name: 'Face', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 160, height: 48 } },
    'button-label': { id: 'button-label', type: 'text', name: 'Label', text: 'Continue', styles: { relativeTransform: [1, 0, 0, 1, 16, 14], width: 96, height: 20 }, ...legacyTextProperties() },
    'button-slot': { id: 'button-slot', type: 'frame', name: 'Content', styles: { relativeTransform: [1, 0, 0, 1, 128, 12], width: 24, height: 24 } },
    'button-icon-use': { id: 'button-icon-use', type: 'frame', name: 'Icon use', styles: { relativeTransform: [0.866, 0.5, -0.5, 0.866, 2, 1], width: 20, height: 20 } },
    'icon-master': { id: 'icon-master', type: 'frame', name: 'Icon', styles: { relativeTransform: [1, 0, 0, 1, 220, 30], width: 20, height: 20 } },
    'icon-shape': { id: 'icon-shape', type: 'rectangle', name: 'Shape', styles: { relativeTransform: [1, 0, 0, 1, 2, 2], width: 16, height: 16 } },
  },
  relationships: {
    'button-master': { parentId: 'root-1', orderKey: 'V' },
    'button-face': { parentId: 'button-master', orderKey: 'V' },
    'button-label': { parentId: 'button-master', orderKey: 'W' },
    'button-slot': { parentId: 'button-master', orderKey: 'X' },
    'button-icon-use': { parentId: 'button-slot', orderKey: 'V' },
    'icon-master': { parentId: 'root-1', orderKey: 'W' },
    'icon-shape': { parentId: 'icon-master', orderKey: 'V' },
  },
  componentModel: {
    definitions: {
      button: {
        id: 'button', name: 'Button', source: { kind: 'canvas', masterRootId: 'button-master' }, revision: 1,
        properties: [
          { id: 'state', name: 'State', type: 'variant', defaultValueId: 'default', values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }], binding: { kind: 'variant', nodeId: 'button-face', appearances: { default: {}, hover: { opacity: 0.8 } } } },
          { id: 'tone', name: 'Tone', type: 'variant', defaultValueId: 'neutral', values: [{ id: 'neutral', name: 'Neutral' }, { id: 'danger', name: 'Danger' }], binding: { kind: 'variant', nodeId: 'button-face', appearances: { neutral: {}, danger: { opacity: 0.7 } } } },
          { id: 'label', name: 'Label', type: 'text', defaultValue: 'Continue', binding: { kind: 'text', nodeId: 'button-label' } },
          { id: 'visible', name: 'Visible', type: 'boolean', defaultValue: true, binding: { kind: 'visibility', nodeId: 'button-face' } },
          { id: 'content', name: 'Content', type: 'slot', binding: { kind: 'slot', nodeId: 'button-slot' } },
          { id: 'icon', name: 'Icon', type: 'instance-swap', defaultValue: 'icon', binding: { kind: 'instance-swap', nodeId: 'button-icon-use' } },
        ],
        variantAppearances: { 'button-face': {
          'state=default|tone=neutral': { opacity: 0.99 }, 'state=default|tone=danger': { opacity: 0.9 },
          'state=hover|tone=neutral': { opacity: 0.8 }, 'state=hover|tone=danger': { opacity: 0.7 },
        } },
        materials: [{ id: 'surface', group: 'Interaction', name: 'Surface', description: 'Interactive face.', appearance: { opacity: 0.95 } }],
        parts: [{ id: 'face', name: 'Face', nodeId: 'button-face', materialId: 'surface' }, { id: 'label-part', name: 'Label', nodeId: 'button-label' }],
        interactions: [{ id: 'hover-interaction', trigger: 'pointer-hover', propertyId: 'state', valueId: 'hover' }],
      },
      icon: { id: 'icon', name: 'Icon', source: { kind: 'canvas', masterRootId: 'icon-master' }, revision: 0, properties: [], materials: [], parts: [{ id: 'shape', name: 'Shape', nodeId: 'icon-shape' }], interactions: [] },
    },
    instances: { 'button-icon-use': { id: 'button-icon-use', componentId: 'icon', values: {} } },
  },
})

describe('hosted document validation', () => {
  it('accepts a canonical blank document', () => {
    expect(validateHostedFileDocument(blank())).toEqual(blank())
  })

  it('COMP-V2-PERSIST-001 roundtrips a complete schema-13 canvas component graph without dropping compound or nested metadata', () => {
    const input = advancedComponentDocument()
    const validated = validateHostedFileDocument(input)
    expect(validated).toEqual(input)
    expect(validated.componentModel.definitions.button).toMatchObject({
      variantAppearances: { 'button-face': { 'state=hover|tone=danger': { opacity: 0.7 } } },
      properties: expect.arrayContaining([
        expect.objectContaining({ type: 'instance-swap', defaultValue: 'icon', binding: { kind: 'instance-swap', nodeId: 'button-icon-use' } }),
        expect.objectContaining({ type: 'slot', binding: { kind: 'slot', nodeId: 'button-slot' } }),
      ]),
    })
    expect(validated.nodes['button-icon-use']).toMatchObject({ styles: { relativeTransform: [0.866, 0.5, -0.5, 0.866, 2, 1] } })
  })

  it('CLOUD-SYNC-COMPONENT-NEG-002 rejects missing and extra compound tuple cells without mutating either document', () => {
    const missing = advancedComponentDocument()
    Reflect.deleteProperty(missing.componentModel.definitions.button.variantAppearances['button-face'], 'state=hover|tone=danger')
    const missingBefore = structuredClone(missing)
    expect(() => validateHostedFileDocument(missing)).toThrow('Invalid component variant appearance table')
    expect(missing).toEqual(missingBefore)

    const extra = advancedComponentDocument()
    Reflect.set(extra.componentModel.definitions.button.variantAppearances['button-face'], 'state=pressed|tone=neutral', { opacity: 0.4 })
    const extraBefore = structuredClone(extra)
    expect(() => validateHostedFileDocument(extra)).toThrow('Invalid component variant appearance table')
    expect(extra).toEqual(extraBefore)
  })

  it('CLOUD-SYNC-COMPONENT-NEG-002 rejects non-nested and recursive Instance swap roots without mutating either document', () => {
    const nonNested = advancedComponentDocument()
    Reflect.set(nonNested.componentModel.definitions.button, 'properties', nonNested.componentModel.definitions.button.properties.map(property => property.id === 'icon'
      ? { ...property, binding: { kind: 'instance-swap', nodeId: 'button-master' } }
      : property))
    Reflect.set(nonNested.componentModel, 'instances', { 'button-master': { id: 'button-master', componentId: 'icon', values: {} } })
    const nonNestedBefore = structuredClone(nonNested)
    expect(() => validateHostedFileDocument(nonNested)).toThrow('An Instance swap property needs a nested component instance root')
    expect(nonNested).toEqual(nonNestedBefore)

    const recursive = advancedComponentDocument()
    Reflect.set(recursive.componentModel.definitions.icon, 'properties', [{
      id: 'owner', name: 'Owner', type: 'instance-swap', defaultValue: 'button', binding: { kind: 'instance-swap', nodeId: 'icon-shape' },
    }])
    Reflect.set(recursive.componentModel, 'instances', {
      ...recursive.componentModel.instances,
      'icon-shape': { id: 'icon-shape', componentId: 'button', values: {} },
    })
    const recursiveBefore = structuredClone(recursive)
    expect(() => validateHostedFileDocument(recursive)).toThrow('Components cannot contain themselves recursively')
    expect(recursive).toEqual(recursiveBefore)
  })

  it('upgrades a schema v10 document to the current schema', () => {
    expect(validateHostedFileDocument({ ...blank(), schemaVersion: 10 })).toEqual(blank())
  })

  it('upgrades an asset-free version 6 document and rejects inline asset migration', () => {
    expect(validateHostedFileDocument(legacyBlank(6))).toEqual(blank())
    expect(() => validateHostedFileDocument({ ...legacyBlank(6), assets: { photo: { data: 'inline' } } })).toThrow('externalization')
  })

  it('PAPER-FLEX-001 upgrades schema v8 to v11 without synthesizing primitive layout', () => {
    const current = legacyBlank(8)
    const source = {
      ...current,
      nodes: { ...current.nodes, frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 10, top: 20, width: 300, height: 200 }, themeMode: 'inherit' } },
      relationships: { frame: { parentId: 'root-1', orderKey: 'V' } },
    }
    const upgraded = validateHostedFileDocument(source)
    expect(upgraded).toEqual({
      ...source,
      schemaVersion: 13,
      componentModel: { definitions: {}, instances: {} },
      nodes: {
        ...source.nodes,
        frame: { ...source.nodes.frame, styles: { relativeTransform: [1, 0, 0, 1, 10, 20], width: 300, height: 200 } },
      },
    })
    expect(upgraded.nodes.frame).not.toHaveProperty('layout')
    expect(source.schemaVersion).toBe(8)
  })

  it('checks the complete primitive graph instead of only the envelope', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).box = { id: 'box', type: 'rectangle', name: 'Box', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: -1, height: 10 } }
    ;(input.relationships as Record<string, unknown>).box = { parentId: 'root-1', orderKey: 'a0' }
    expect(() => validateHostedFileDocument(input)).toThrow('Invalid node geometry')
  })

  it('allows unavailable hosted component bindings but rejects unsafe props', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).button = { id: 'button', type: 'component', componentId: 'button-component', exportName: 'Button', props: { children: 'Save' } }
    ;(input.relationships as Record<string, unknown>).button = { parentId: 'root-1', orderKey: 'V' }
    expect(validateHostedFileDocument(input).nodes.button).toMatchObject({ componentId: 'button-component', props: { children: 'Save' } })
    ;((input.nodes as Record<string, Record<string, unknown>>).button!.props as Record<string, unknown>).onClick = 'alert(1)'
    expect(() => validateHostedFileDocument(input)).toThrow('Unsupported prop onClick')
  })

  it('validates hosted Card slot relationships without claiming a source binding', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).card = { id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', props: {} }
    ;(input.nodes as Record<string, unknown>).button = { id: 'button', type: 'component', componentId: 'button-component', exportName: 'Button', props: { children: 'Save' } }
    ;(input.relationships as Record<string, unknown>).card = { parentId: 'root-1', orderKey: 'V' }
    ;(input.relationships as Record<string, unknown>).button = { parentId: 'card', orderKey: 'V', slot: 'footer' }
    expect(validateHostedFileDocument(input).relationships.button).toEqual({ parentId: 'card', orderKey: 'V', slot: 'footer' })
  })

  it('rejects one component identity bound to different exports', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).one = { id: 'one', type: 'component', componentId: 'shared', exportName: 'Button', props: {} }
    ;(input.nodes as Record<string, unknown>).two = { id: 'two', type: 'component', componentId: 'shared', exportName: 'Input', props: {} }
    ;(input.relationships as Record<string, unknown>).one = { parentId: 'root-1', orderKey: 'a0' }
    ;(input.relationships as Record<string, unknown>).two = { parentId: 'root-1', orderKey: 'a1' }
    expect(() => validateHostedFileDocument(input)).toThrow('Component identity is inconsistent')
  })

  it('COMP-V2-PERSIST-ORPHAN-001 repairs only component instance metadata whose design node is already absent', () => {
    const source = blank()
    ;(source.nodes as Record<string, unknown>).master = { id: 'master', type: 'frame', name: 'Button', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 120, height: 40 } }
    ;(source.relationships as Record<string, unknown>).master = { parentId: 'root-1', orderKey: 'V' }
    source.componentModel = {
      definitions: { button: { id: 'button', name: 'Button', source: { kind: 'canvas', masterRootId: 'master' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] } },
      instances: { ghost: { id: 'ghost', componentId: 'button', values: {} } },
    }

    const repaired = repairHostedFileDocument(source)
    expect(repaired).toMatchObject({ status: 'repaired', removedInstanceIds: ['ghost'], document: { revision: 0, componentModel: { instances: {} } } })
    expect(source.componentModel.instances).toHaveProperty('ghost')
    expect(repairHostedFileDocument(blank())).toEqual({ status: 'not-repairable' })
  })

  it('COMP-V2-PERSIST-ORPHAN-001 refuses broader graph repair and leaves existing instance nodes alone', () => {
    const malformed = blank()
    ;(malformed.nodes as Record<string, unknown>).master = { id: 'master', type: 'frame', name: 'Button', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 120, height: 40 } }
    ;(malformed.relationships as Record<string, unknown>).master = { parentId: 'missing', orderKey: 'V' }
    malformed.componentModel = {
      definitions: { button: { id: 'button', name: 'Button', source: { kind: 'canvas', masterRootId: 'master' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] } },
      instances: { ghost: { id: 'ghost', componentId: 'button', values: {} } },
    }
    expect(repairHostedFileDocument(malformed)).toEqual({ status: 'not-repairable' })

    const present = structuredClone(malformed)
    ;(present.relationships as Record<string, unknown>).master = { parentId: 'root-1', orderKey: 'V' }
    ;(present.nodes as Record<string, unknown>).ghost = { id: 'ghost', type: 'rectangle', name: 'Ghost', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 10, height: 10 } }
    ;(present.relationships as Record<string, unknown>).ghost = { parentId: 'root-1', orderKey: 'W' }
    expect(repairHostedFileDocument(present)).toEqual({ status: 'not-repairable' })
  })

  it('FILE-ASSET-001 externalizes every validated version 6 image before returning the current schema', async () => {
    const source = {
      ...legacyBlank(6),
      assets: {
        photo: { id: 'photo', name: 'photo.jpg', mime: 'image/jpeg', width: 1, height: 1, bytes: 3, data: 'AAAA' },
      },
    }
    const uploads: unknown[] = []
    const result = await externalizeHostedFileDocument(source, async input => {
      uploads.push(input)
      return { id: 'photo', name: 'photo.jpg', mime: 'image/jpeg', extension: 'jpg', width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) }
    })

    expect(result.status).toBe('externalized')
    if (result.status !== 'externalized') throw new Error('Expected externalization')
    expect(uploads).toEqual([{ fileId: 'file-1', asset: { id: 'photo', name: 'photo.jpg', mime: 'image/jpeg', extension: 'jpg', width: 1, height: 1, bytes: 3, data: 'AAAA' } }])
    expect(result.document).toEqual({
      ...blank(),
      assets: { photo: { id: 'photo', name: 'photo.jpg', mime: 'image/jpeg', extension: 'jpg', width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) } },
    })
    expect(source).toHaveProperty('assets.photo.data', 'AAAA')
  })

  it('FILE-ASSET-SEC-001 validates the full graph before uploading legacy bytes', async () => {
    const source = {
      ...legacyBlank(6),
      assets: {
        photo: { id: 'photo', name: 'photo.png', mime: 'image/png', width: 1, height: 1, bytes: 3, data: 'AAAA' },
      },
      relationships: { ghost: { parentId: 'missing', orderKey: 'V' } },
    }
    let uploads = 0
    await expect(externalizeHostedFileDocument(source, async () => {
      uploads += 1
      throw new Error('must not upload')
    })).rejects.toThrow()
    expect(uploads).toBe(0)
  })

  it('FILE-ASSET-SEC-001 rejects malformed bytes and mismatched trusted results', async () => {
    const source = {
      ...legacyBlank(6),
      assets: {
        photo: { id: 'photo', name: 'photo.png', mime: 'image/png', width: 1, height: 1, bytes: 4, data: 'AAAA' },
      },
    }
    await expect(externalizeHostedFileDocument(source, async () => {
      throw new Error('must not upload')
    })).rejects.toThrow('size does not match')

    const valid = { ...source, assets: { photo: { ...source.assets.photo, bytes: 3 } } }
    await expect(externalizeHostedFileDocument(valid, async () => ({
      id: 'other', name: 'photo.png', mime: 'image/png', extension: 'png', width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64),
    }))).rejects.toThrow('metadata does not match')

    await expect(externalizeHostedFileDocument({ ...valid, assets: { 'photo:unsafe': { ...valid.assets.photo, id: 'photo:unsafe' } } }, async () => {
      throw new Error('must not upload')
    })).rejects.toThrow('identity')
  })

  it('does not call the migration uploader for a current document', async () => {
    let uploads = 0
    const result = await externalizeHostedFileDocument(blank(), async () => {
      uploads += 1
      throw new Error('must not upload')
    })
    expect(result).toEqual({ status: 'current', document: blank() })
    expect(uploads).toBe(0)
  })
})
