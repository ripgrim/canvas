import { componentDocsCatalog, validateComponentModelState } from './component-model.js'
import type { ComponentDefinition, ComponentDocsCatalog, ComponentModelState, ComponentScalarValue } from './component-model.js'
import type { BlumeComponentDocsLayout, BlumeComponentExample } from './component-docs-blume.js'
import { readOptional } from './paths.js'

export type BlumeDocsComponentAdapter = Readonly<{
  componentId: string
  slug: string
  importSpecifier: string
  examplePath: string
  description?: string
}>

export type BlumeDocsAdapter = Readonly<{
  version: 1
  renderer: 'blume'
  layout: Omit<BlumeComponentDocsLayout, 'navigationSource'>
  components: readonly BlumeDocsComponentAdapter[]
}>

export type VerifiedDocsComponent = Readonly<{ componentId: string; exportName: string }>
export type BlumeDocsAdapterInputs = Readonly<{ catalog: ComponentDocsCatalog; examples: readonly BlumeComponentExample[]; layout: BlumeDocsAdapter['layout'] }>

export const blumeDocsAdapterPath = '.canvas/blume.json'

const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\u0000-\u001f\u007f]{1,512}$/u
const id = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const exportName = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/
const specifier = /^(?:\.{1,2}\/|@?[A-Za-z0-9_-])[A-Za-z0-9_./@+-]*$/
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const invalid = (): never => { throw new Error('Invalid Blume documentation adapter') }
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) invalid()
}
const text = (value: unknown, pattern: RegExp, maximum = 512): string => typeof value === 'string' && value.length > 0 && value.length <= maximum && pattern.test(value) ? value : invalid()
const path = (value: unknown): string => text(value, safePath)

export function parseBlumeDocsAdapter(input: unknown): BlumeDocsAdapter {
  const candidate = record(input) ? input : invalid()
  exact(candidate, ['version', 'renderer', 'layout', 'components'])
  if (candidate.version !== 1 || candidate.renderer !== 'blume' || !record(candidate.layout) || !Array.isArray(candidate.components) || candidate.components.length > 500) invalid()
  const rawLayout = candidate.layout as Record<string, unknown>
  const rawComponents = candidate.components as unknown[]
  exact(rawLayout, ['docsDirectory', 'examplesDirectory', 'metaPath', 'manifestPath'])
  const layout = {
    docsDirectory: path(rawLayout.docsDirectory), examplesDirectory: path(rawLayout.examplesDirectory),
    metaPath: path(rawLayout.metaPath), manifestPath: path(rawLayout.manifestPath),
  }
  const components = rawComponents.map(value => {
    const component = record(value) ? value : invalid()
    exact(component, ['componentId', 'slug', 'importSpecifier', 'examplePath'], ['description'])
    const description = component.description === undefined ? undefined : text(component.description, /^[^\u0000-\u001f\u007f]*$/u, 500)
    return {
      componentId: text(component.componentId, id, 128), slug: text(component.slug, slug, 128),
      importSpecifier: text(component.importSpecifier, specifier, 2_048), examplePath: path(component.examplePath),
      ...(description === undefined ? {} : { description }),
    }
  })
  if (new Set(components.map(component => component.componentId)).size !== components.length
    || new Set(components.map(component => component.slug)).size !== components.length
    || new Set(components.map(component => component.examplePath)).size !== components.length) invalid()
  return Object.freeze({ version: 1, renderer: 'blume', layout: Object.freeze(layout), components: Object.freeze(components.map(component => Object.freeze(component))) })
}

export async function loadBlumeDocsAdapter(root: string): Promise<BlumeDocsAdapter | null> {
  const source = await readOptional(root, blumeDocsAdapterPath)
  if (source === null) return null
  if (Buffer.byteLength(source, 'utf8') > 64 * 1024) throw new Error('Blume documentation adapter is too large')
  let input: unknown
  try { input = JSON.parse(source) }
  catch { throw new Error('Invalid Blume documentation adapter') }
  return parseBlumeDocsAdapter(input)
}

function defaultValue(definition: ComponentDefinition, property: ComponentDefinition['properties'][number]): ComponentScalarValue | undefined {
  if (property.optional) return undefined
  if (property.type === 'variant') return property.values.find(value => value.id === property.defaultValueId)?.name
  if (property.type === 'text' || property.type === 'boolean') return property.defaultValue
  return undefined
}

function jsx(exported: string, definition: ComponentDefinition): string {
  const props = definition.properties.flatMap(property => {
    const value = defaultValue(definition, property)
    if (value === undefined) return []
    return [` ${property.name}={${JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}}`]
  })
  return `<${exported}${props.join('')} />`
}

export function blumeDocsAdapterInputs(stateInput: ComponentModelState, verifiedInput: readonly VerifiedDocsComponent[], configInput: unknown): BlumeDocsAdapterInputs {
  const state = validateComponentModelState(stateInput)
  const config = parseBlumeDocsAdapter(configInput)
  const verified = new Map<string, VerifiedDocsComponent>()
  for (const component of verifiedInput) {
    if (!id.test(component.componentId) || !exportName.test(component.exportName) || verified.has(component.componentId)) throw new Error('Invalid verified documentation component')
    verified.set(component.componentId, Object.freeze({ ...component }))
  }
  const definitions: Record<string, ComponentDefinition> = structuredClone(state.definitions)
  const usage: Record<string, string> = {}
  const examples: BlumeComponentExample[] = []
  for (const adapter of config.components) {
    const definition = definitions[adapter.componentId]
    const binding = verified.get(adapter.componentId)
    if (!definition || definition.source.kind !== 'code' || !binding) throw new Error('Blume adapter references an unverified code component')
    definitions[adapter.componentId] = { ...definition, docs: { slug: adapter.slug, ...(adapter.description === undefined ? {} : { description: adapter.description }) } }
    const rendered = jsx(binding.exportName, definition)
    usage[definition.id] = `import { ${binding.exportName} } from ${JSON.stringify(adapter.importSpecifier)};\n\n${rendered}`
    examples.push({ componentId: definition.id, path: adapter.examplePath, source: `import { ${binding.exportName} } from ${JSON.stringify(adapter.importSpecifier)};\n\nexport default function ${binding.exportName}Example() {\n  return ${rendered};\n}\n` })
  }
  return Object.freeze({ catalog: componentDocsCatalog({ definitions, instances: state.instances }, usage), examples: Object.freeze(examples), layout: config.layout })
}
