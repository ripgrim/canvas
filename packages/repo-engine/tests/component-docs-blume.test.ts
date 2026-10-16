import { describe, expect, it } from 'vitest'
import { componentDocsCatalog, validateComponentModelState } from '../src/component-model.js'
import { planBlumeComponentDocs } from '../src/component-docs-blume.js'

const definition = {
  id: 'component:button', name: 'Button', source: { kind: 'code' as const, bindingId: 'binding:button' }, revision: 1,
  properties: [
    { id: 'variant', name: 'State', description: 'Visual interaction state.', type: 'variant' as const, values: [{ id: 'default', name: 'Default' }, { id: 'hover', name: 'Hover' }], defaultValueId: 'default' },
    { id: 'label', name: 'Label', type: 'text' as const, defaultValue: '', optional: true as const },
    { id: 'disabled', name: 'Disabled', type: 'boolean' as const, defaultValue: false },
  ],
  materials: [], parts: [], interactions: [], docs: { slug: 'button', description: 'Triggers an action.' },
}
const existingNavigation = `import { defineMeta } from 'blume';\n\nexport default defineMeta({\n  collapsed: false,\n  order: 2,\n  pages: ['badge', 'card'],\n  title: 'Components',\n});\n`
const layout = { docsDirectory: 'apps/docs/docs/components', examplesDirectory: 'apps/docs/registry/comp', metaPath: 'apps/docs/docs/components/meta.ts', manifestPath: 'apps/docs/.canvas/components.json', navigationSource: existingNavigation }

describe('COMP-V2-DOCS-002 reviewed Blume output', () => {
  it('plans exact MDX, example, manifest, and navigation files without writing source', () => {
    const model = validateComponentModelState({ definitions: { [definition.id]: definition }, instances: {} })
    const catalog = componentDocsCatalog(model, { [definition.id]: '<Button state="default">Save</Button>' })
    const exampleSource = "import { Button } from '@trycompai/design-system';\n\nexport default function ButtonExample() {\n  return <Button variant=\"brand\">Save</Button>;\n}\n"
    const plan = planBlumeComponentDocs(catalog, [{ componentId: definition.id, path: 'button/examples/button-generated', source: exampleSource }], layout)

    expect(plan.omissions).toEqual([])
    expect(plan.files.map(file => [file.role, file.path])).toEqual([
      ['manifest', 'apps/docs/.canvas/components.json'],
      ['docs', 'apps/docs/docs/components/button.mdx'],
      ['example', 'apps/docs/registry/comp/button/examples/button-generated.tsx'],
      ['navigation', 'apps/docs/docs/components/meta.ts'],
    ])
    expect(plan.files.find(file => file.role === 'example')?.content).toBe(exampleSource)
    expect(plan.files.find(file => file.role === 'docs')?.content).toBe(`---
title: 'Button'
description: 'Triggers an action.'
---

<Component path="button/examples/button-generated" />

## Usage

\`\`\`tsx
<Button state="default">Save</Button>
\`\`\`

## Properties

| Property | Description | Type | Requirement | Default | Options |
| --- | --- | --- | --- | --- | --- |
| State | Visual interaction state. | variant | Required | Default | Default, Hover |
| Label |  | text | Optional | Component default |  |
| Disabled |  | boolean | Required | Off |  |

## Variants

- State: Default
- State: Hover
`)
    expect(plan.files.find(file => file.role === 'navigation')?.content).toContain("pages: ['badge', 'card', 'button']")
    expect(JSON.parse(plan.files[0]!.content)).toEqual(catalog)
  })

  it('omits components without exact usage or example adapters', () => {
    const model = validateComponentModelState({ definitions: { [definition.id]: definition }, instances: {} })
    const noUsage = planBlumeComponentDocs(componentDocsCatalog(model), [{ componentId: definition.id, path: 'button/examples/button-generated', source: 'export default function Example() { return null }' }], layout)
    expect(noUsage.files.map(file => file.role)).toEqual(['manifest', 'navigation'])
    expect(noUsage.omissions).toEqual([{ componentId: definition.id, reason: 'usage-adapter-required' }])
    const noExample = planBlumeComponentDocs(componentDocsCatalog(model, { [definition.id]: '<Button />' }), [], layout)
    expect(noExample.files.map(file => file.role)).toEqual(['manifest', 'navigation'])
    expect(noExample.omissions).toEqual([{ componentId: definition.id, reason: 'example-adapter-required' }])
  })

  it('rejects unknown, duplicate, and traversal-like example bindings', () => {
    const model = validateComponentModelState({ definitions: { [definition.id]: definition }, instances: {} })
    const catalog = componentDocsCatalog(model, { [definition.id]: '<Button />' })
    expect(() => planBlumeComponentDocs(catalog, [{ componentId: 'missing', path: 'missing/example', source: 'export default null' }], layout)).toThrow('missing component')
    expect(() => planBlumeComponentDocs(catalog, [
      { componentId: definition.id, path: 'button/one', source: 'export default null' },
      { componentId: definition.id, path: 'button/two', source: 'export default null' },
    ], layout)).toThrow('Duplicate Blume component example')
    expect(() => planBlumeComponentDocs(catalog, [{ componentId: definition.id, path: '../button', source: 'export default null' }], layout)).toThrow('Invalid Blume example path')
    expect(() => planBlumeComponentDocs(catalog, [], { ...layout, manifestPath: layout.metaPath })).toThrow('Blume output paths overlap')
    expect(() => planBlumeComponentDocs(catalog, [], { ...layout, navigationSource: "export default defineMeta({ pages: getPages() })" })).toThrow('pages are missing or ambiguous')
  })
})
