import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { blumeDocsAdapterInputs, loadBlumeDocsAdapter, parseBlumeDocsAdapter } from '../src/component-docs-adapter.js'

const state = {
  definitions: {
    'component:button': {
      id: 'component:button', name: 'Button', source: { kind: 'code' as const, bindingId: 'binding:button' }, revision: 0,
      properties: [
        { id: 'property:variant', name: 'variant', type: 'variant' as const, values: [{ id: 'value:default', name: 'default' }, { id: 'value:brand', name: 'brand' }], defaultValueId: 'value:default' },
        { id: 'property:label', name: 'label', type: 'text' as const, defaultValue: '', optional: true as const },
        { id: 'property:disabled', name: 'disabled', type: 'boolean' as const, defaultValue: false },
        { id: 'property:icon', name: 'icon', type: 'slot' as const },
      ],
      materials: [], parts: [], interactions: [],
    },
  },
  instances: {},
}

const config = {
  version: 1,
  renderer: 'blume',
  layout: {
    docsDirectory: 'apps/docs/docs/components', examplesDirectory: 'apps/docs/registry/comp',
    metaPath: 'apps/docs/docs/components/meta.ts', manifestPath: 'apps/docs/.canvas/components.json',
  },
  components: [{
    componentId: 'component:button', slug: 'button', importSpecifier: '@trycompai/design-system',
    examplePath: 'button/examples/button-generated', description: 'Triggers an action.',
  }],
}

describe('COMP-V2-DOCS-004 explicit Blume repository adapter', () => {
  it('derives exact usage and example source from verified identity and reviewed configuration', () => {
    const result = blumeDocsAdapterInputs(state, [{ componentId: 'component:button', exportName: 'Button' }], config)
    expect(result.layout).toEqual(config.layout)
    expect(result.catalog.components).toHaveLength(1)
    expect(result.catalog.components[0]).toMatchObject({
      componentId: 'component:button', slug: 'button', description: 'Triggers an action.',
      usage: { status: 'available', snippet: 'import { Button } from "@trycompai/design-system";\n\n<Button variant={"default"} disabled={false} />' },
    })
    expect(result.examples).toEqual([{
      componentId: 'component:button', path: 'button/examples/button-generated',
      source: 'import { Button } from "@trycompai/design-system";\n\nexport default function ButtonExample() {\n  return <Button variant={"default"} disabled={false} />;\n}\n',
    }])
  })

  it('rejects inferred, duplicate, unsafe, and unverified mappings', () => {
    expect(() => parseBlumeDocsAdapter({ ...config, guessed: true })).toThrow('Invalid Blume documentation adapter')
    expect(() => parseBlumeDocsAdapter({ ...config, components: [config.components[0], config.components[0]] })).toThrow('Invalid Blume documentation adapter')
    expect(() => parseBlumeDocsAdapter({ ...config, layout: { ...config.layout, metaPath: '../meta.ts' } })).toThrow('Invalid Blume documentation adapter')
    expect(() => parseBlumeDocsAdapter({ ...config, components: [{ ...config.components[0], importSpecifier: 'https://example.com/button' }] })).toThrow('Invalid Blume documentation adapter')
    expect(() => blumeDocsAdapterInputs(state, [], config)).toThrow('unverified code component')
  })

  it('loads only the bounded repository-owned adapter file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'canvas-blume-adapter-'))
    try {
      expect(await loadBlumeDocsAdapter(root)).toBeNull()
      await mkdir(path.join(root, '.canvas'))
      await writeFile(path.join(root, '.canvas/blume.json'), JSON.stringify(config))
      expect(await loadBlumeDocsAdapter(root)).toEqual(parseBlumeDocsAdapter(config))
      await writeFile(path.join(root, '.canvas/blume.json'), '{')
      await expect(loadBlumeDocsAdapter(root)).rejects.toThrow('Invalid Blume documentation adapter')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
