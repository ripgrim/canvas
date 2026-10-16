import type { ComponentDocsCatalog, ComponentDocsManifest, ComponentScalarValue } from './component-model.js'
import * as recast from 'recast'
import { parseTsx } from './patches.js'

export type BlumeComponentExample = Readonly<{ componentId: string; path: string; source: string }>
export type BlumeComponentDocsLayout = Readonly<{ docsDirectory: string; examplesDirectory: string; metaPath: string; manifestPath: string; navigationSource: string | null }>
export type BlumeComponentDocsFile = Readonly<{ path: string; content: string; role: 'docs' | 'example' | 'manifest' | 'navigation' }>
export type BlumeComponentDocsOmission = Readonly<{ componentId: string; reason: 'example-adapter-required' | 'usage-adapter-required' }>
export type BlumeComponentDocsPlan = Readonly<{ files: readonly BlumeComponentDocsFile[]; omissions: readonly BlumeComponentDocsOmission[] }>

const relativePath = (value: string, label: string): string => {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid ${label}`)
  return normalized
}

const singleQuoted = (value: string): string => `'${value.replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll("'", "''")}'`
const markdown = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('`', '\\`').replaceAll('\r', ' ').replaceAll('\n', ' ')

function displayValue(component: ComponentDocsManifest, propertyId: string, value: ComponentScalarValue | undefined): string {
  if (value === undefined) return ''
  const control = component.controls.find(candidate => candidate.id === propertyId)
  if (control?.type === 'variant') return control.options?.find(option => option.id === value)?.name ?? String(value)
  return typeof value === 'boolean' ? value ? 'On' : 'Off' : String(value)
}

function controlsTable(component: ComponentDocsManifest): string {
  if (!component.controls.length) return ''
  const rows = component.controls.map(control => {
    const options = control.options?.map(option => option.name).join(', ') ?? ''
    const defaultValue = control.optional ? 'Component default' : displayValue(component, control.id, control.defaultValue)
    return `| ${markdown(control.name)} | ${markdown(control.description ?? '')} | ${control.type} | ${control.optional ? 'Optional' : 'Required'} | ${markdown(defaultValue)} | ${markdown(options)} |`
  })
  return `\n## Properties\n\n| Property | Description | Type | Requirement | Default | Options |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`
}

function combinationsList(component: ComponentDocsManifest): string {
  const variants = component.controls.filter(control => control.type === 'variant')
  if (!variants.length) return ''
  const rows = component.combinations.map(combination => variants.map(control => `${control.name}: ${displayValue(component, control.id, combination[control.id])}`).join(', '))
  return `\n## Variants\n\n${rows.map(row => `- ${markdown(row)}`).join('\n')}\n`
}

function docsSource(component: ComponentDocsManifest, examplePath: string): string {
  if (component.usage.status !== 'available') throw new Error('Component usage adapter is unavailable')
  if (component.usage.snippet.includes('```')) throw new Error('Component usage snippet cannot contain a fenced code block')
  const description = component.description ? `\ndescription: ${singleQuoted(component.description)}` : ''
  return `---\ntitle: ${singleQuoted(component.name)}${description}\n---\n\n<Component path=${JSON.stringify(examplePath)} />\n\n## Usage\n\n\`\`\`tsx\n${component.usage.snippet.trim()}\n\`\`\`\n${controlsTable(component)}${combinationsList(component)}`
}

function navigationSource(source: string | null, slugs: readonly string[]): string {
  if (source === null) return `import { defineMeta } from 'blume';\n\nexport default defineMeta({\n  collapsed: false,\n  order: 2,\n  pages: [${slugs.map(singleQuoted).join(', ')}],\n  title: 'Components',\n});\n`
  const ast = parseTsx(source)
  let matches = 0
  recast.types.visit(ast, {
    visitCallExpression(callPath) {
      const call = callPath.node
      if (call.callee.type !== 'Identifier' || call.callee.name !== 'defineMeta' || call.arguments.length !== 1 || call.arguments[0]?.type !== 'ObjectExpression') return false
      const pages = call.arguments[0].properties.filter(property => property.type === 'ObjectProperty' && !property.computed && ((property.key.type === 'Identifier' && property.key.name === 'pages') || (property.key.type === 'StringLiteral' && property.key.value === 'pages')))
      if (pages.length !== 1 || pages[0]!.type !== 'ObjectProperty' || pages[0]!.value.type !== 'ArrayExpression') throw new Error('Blume navigation pages are missing or ambiguous')
      const values = pages[0]!.value.elements
      if (values.some(value => value?.type !== 'StringLiteral')) throw new Error('Blume navigation pages must be string literals')
      const existing = new Set(values.flatMap(value => value?.type === 'StringLiteral' ? [value.value] : []))
      for (const slug of slugs) if (!existing.has(slug)) values.push(recast.types.builders.stringLiteral(slug))
      matches += 1
      return false
    },
  })
  if (matches !== 1) throw new Error('Blume navigation definition is missing or ambiguous')
  return recast.print(ast, { quote: 'single', lineTerminator: source.includes('\r\n') ? '\r\n' : '\n' }).code
}

export function planBlumeComponentDocs(catalog: ComponentDocsCatalog, examples: readonly BlumeComponentExample[], layout: BlumeComponentDocsLayout): BlumeComponentDocsPlan {
  if (catalog.version !== 1) throw new Error('Unsupported component docs catalog')
  const docsDirectory = relativePath(layout.docsDirectory, 'Blume docs directory')
  const examplesDirectory = relativePath(layout.examplesDirectory, 'Blume examples directory')
  const metaPath = relativePath(layout.metaPath, 'Blume navigation path')
  const manifestPath = relativePath(layout.manifestPath, 'Blume manifest path')
  const components = new Map(catalog.components.map(component => [component.componentId, component]))
  if (components.size !== catalog.components.length) throw new Error('Duplicate component docs identity')
  const adapters = new Map<string, BlumeComponentExample>()
  const examplePaths = new Set<string>()
  for (const example of examples) {
    if (!components.has(example.componentId)) throw new Error('Blume example references a missing component')
    if (adapters.has(example.componentId)) throw new Error('Duplicate Blume component example')
    const path = relativePath(example.path, 'Blume example path')
    if (path.endsWith('.tsx') || examplePaths.has(path)) throw new Error('Duplicate or extended Blume example path')
    if (!example.source.trim()) throw new Error('Blume example source is empty')
    adapters.set(example.componentId, { ...example, path })
    examplePaths.add(path)
  }
  const files: BlumeComponentDocsFile[] = [{ path: manifestPath, content: `${JSON.stringify(catalog, null, 2)}\n`, role: 'manifest' }]
  const omissions: BlumeComponentDocsOmission[] = []
  const slugs: string[] = []
  for (const component of catalog.components) {
    const example = adapters.get(component.componentId)
    if (!example) { omissions.push({ componentId: component.componentId, reason: 'example-adapter-required' }); continue }
    if (component.usage.status !== 'available') { omissions.push({ componentId: component.componentId, reason: 'usage-adapter-required' }); continue }
    slugs.push(component.slug)
    files.push({ path: `${docsDirectory}/${component.slug}.mdx`, content: docsSource(component, example.path), role: 'docs' })
    files.push({ path: `${examplesDirectory}/${example.path}.tsx`, content: example.source, role: 'example' })
  }
  files.push({ path: metaPath, content: navigationSource(layout.navigationSource, slugs), role: 'navigation' })
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Blume output paths overlap')
  return { files, omissions }
}
