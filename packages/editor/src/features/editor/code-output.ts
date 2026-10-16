import { validateDocument } from '@canvas/repo-engine/document'
import type { EditorDocument } from '@canvas/repo-engine/document'
import { isRepositoryAtom } from '@canvas/repo-engine/contracts'
import type { Atom } from '@canvas/repo-engine/contracts'
import { codeOutputCopy } from './code-output-copy'

export type CssDiagnostic = {
  code: 'input-limit' | 'malformed' | 'stylesheet' | 'escaped-syntax' | 'important' | 'duplicate' | 'resource' | 'property'
  message: string
  declaration: string
}
export type CssOutput = {
  styleCode: string
  declarationCss: string
  retainedCss: string
  diagnostics: CssDiagnostic[]
  contract: string
}

type Declaration = { raw: string; text: string; escaped: boolean }
type ScanResult = { declarations: Declaration[]; error?: 'malformed' | 'stylesheet' }

function quoted(value: string | number | boolean): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function scanDeclarations(css: string): ScanResult {
  const declarations: Declaration[] = []
  const stack: string[] = []
  let quote = ''
  let text = ''
  let start = 0
  let escaped = false
  for (let index = 0; index < css.length; index++) {
    const char = css[index]!
    if (quote) {
      text += char
      if (char === '\\') {
        if (++index >= css.length) return { declarations, error: 'malformed' }
        text += css[index]!
      } else if (char === quote) quote = ''
      else if (char === '\n' || char === '\r' || char === '\f') return { declarations, error: 'malformed' }
      continue
    }
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2)
      if (end < 0) return { declarations, error: 'malformed' }
      text += ' '
      index = end + 1
      continue
    }
    if (char === '"' || char === "'") { quote = char; text += char; continue }
    if (char === '\\') {
      escaped = true
      if (++index >= css.length) return { declarations, error: 'malformed' }
      text += char + css[index]!
      continue
    }
    if (char === '{' || char === '}') return { declarations, error: 'stylesheet' }
    if (char === '(' || char === '[') stack.push(char === '(' ? ')' : ']')
    if ((char === ')' || char === ']') && stack.pop() !== char) return { declarations, error: 'malformed' }
    if (char === ';' && stack.length === 0) {
      declarations.push({ raw: css.slice(start, index + 1), text, escaped })
      start = index + 1
      text = ''
      escaped = false
    } else text += char
  }
  if (quote || stack.length) return { declarations, error: 'malformed' }
  if (text.trim()) declarations.push({ raw: css.slice(start), text, escaped })
  return { declarations }
}

const numericProperties = new Set(['opacity', 'line-height', 'font-weight', 'z-index', 'order', 'flex-grow', 'flex-shrink', 'fill-opacity', 'stroke-opacity', 'stop-opacity', 'flood-opacity', 'orphans', 'widows', 'column-count', 'animation-iteration-count', 'zoom'])

function styleKey(property: string): string {
  if (property.startsWith('--')) return property
  return property.toLowerCase().replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

export function convertCssDeclarations(css: string): CssOutput {
  const diagnostics: CssDiagnostic[] = []
  const result: CssOutput = { styleCode: '{}', declarationCss: css, retainedCss: '', diagnostics, contract: codeOutputCopy.cssContract }
  const fail = (code: CssDiagnostic['code'], message: string): CssOutput => {
    diagnostics.push({ code, message, declaration: css })
    result.retainedCss = css
    return result
  }
  if (css.length > 65_536) return fail('input-limit', codeOutputCopy.cssTooLarge)
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(css)) return fail('malformed', codeOutputCopy.cssMalformed)
  const scanned = scanDeclarations(css)
  if (scanned.error) return fail(scanned.error, scanned.error === 'stylesheet' ? codeOutputCopy.cssRule : codeOutputCopy.cssMalformed)
  const entries: { declaration: Declaration; property: string; value: string; key: string; diagnostic?: CssDiagnostic }[] = []
  for (const declaration of scanned.declarations) {
    const text = declaration.text.trim()
    if (!text) continue
    if (text.startsWith('@')) return fail('stylesheet', codeOutputCopy.cssRule)
    const colon = text.indexOf(':')
    if (colon <= 0 || !text.slice(colon + 1).trim()) return fail('malformed', codeOutputCopy.cssMalformed)
    const property = text.slice(0, colon).trim()
    const value = text.slice(colon + 1).trim()
    const entry: typeof entries[number] = { declaration, property, value, key: styleKey(property) }
    const diagnostic = (code: CssDiagnostic['code'], message: string) => { entry.diagnostic = { code, message, declaration: declaration.raw } }
    if (declaration.escaped) diagnostic('escaped-syntax', codeOutputCopy.cssEscaped)
    else if (!/^(?:--[A-Za-z0-9_-]+|-?[A-Za-z][A-Za-z0-9-]*)$/.test(property) || ['__proto__', 'constructor', 'prototype'].includes(property)) diagnostic('property', codeOutputCopy.cssProperty)
    else if (/!\s*important\s*$/i.test(value)) diagnostic('important', codeOutputCopy.cssImportant)
    else if (/(?:url|expression)\s*\(/i.test(value) || /^(?:behavior|-moz-binding)$/i.test(property)) diagnostic('resource', codeOutputCopy.cssResource)
    entries.push(entry)
  }
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
  const style: string[] = []
  const retained: string[] = []
  for (const entry of entries) {
    if (!entry.diagnostic && counts.get(entry.key)! > 1) entry.diagnostic = { code: 'duplicate', message: codeOutputCopy.cssDuplicate, declaration: entry.declaration.raw }
    if (entry.diagnostic) { diagnostics.push(entry.diagnostic); retained.push(entry.declaration.raw); continue }
    const { property, value, key } = entry
    const numeric = numericProperties.has(property.toLowerCase()) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))
    style.push(`  ${quoted(key)}: ${numeric ? String(Number(value)) : quoted(value)}`)
  }
  result.styleCode = style.length ? `{\n${style.join(',\n')}\n}` : '{}'
  result.retainedCss = retained.join('\n')
  return result
}

export type ComponentDependency = { componentId: string; sourcePath: string; exportName: string; localName: string; moduleSpecifier: string }
export type ComponentUsageOutput = { code: string; jsx: string; imports: string; dependencies: ComponentDependency[]; contract: string }
export type ComponentUsageOptions = { rootIds?: readonly string[]; moduleSpecifiers: Readonly<Record<string, string>> }

function validModuleSpecifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && value.trim() === value && /^(?:\.{1,2}\/|@?[A-Za-z0-9_-])/.test(value) && !/[\s\u0000-\u001f\u007f\\:?#]/.test(value)
}

export function serializeComponentUsage(input: EditorDocument, atoms: Atom[], options: ComponentUsageOptions): ComponentUsageOutput {
  if (new Set(atoms.map(atom => atom.componentId)).size !== atoms.length) throw new Error(codeOutputCopy.invalidBinding)
  const document = validateDocument(input, atoms)
  const rootIds = options.rootIds ? [...options.rootIds] : document.rootIds
  const visited = new Set<string>()
  const dependencies: ComponentDependency[] = []
  const bindingNames = new Map<string, string>()
  const localNames = new Set<string>()
  function visit(id: string) {
    const node = Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined
    if (!node || visited.has(id)) throw new Error(codeOutputCopy.invalidSelection)
    visited.add(id)
    if (!bindingNames.has(node.componentId)) {
      const atom = atoms.find(candidate => candidate.componentId === node.componentId)
      if (!atom || !isRepositoryAtom(atom)) throw new Error(codeOutputCopy.invalidBinding)
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(atom.exportName)) throw new Error(codeOutputCopy.invalidBinding)
      const moduleSpecifier = Object.hasOwn(options.moduleSpecifiers, atom.componentId) ? options.moduleSpecifiers[atom.componentId] : undefined
      if (!validModuleSpecifier(moduleSpecifier)) throw new Error(codeOutputCopy.missingImport)
      const baseName = atom.exportName[0]!.toUpperCase() + atom.exportName.slice(1)
      let localName = baseName
      let suffix = 2
      while (localNames.has(localName)) localName = `${baseName}${suffix++}`
      localNames.add(localName)
      bindingNames.set(atom.componentId, localName)
      dependencies.push({ componentId: atom.componentId, sourcePath: atom.path, exportName: atom.exportName, localName, moduleSpecifier })
    }
    for (const children of Object.values(node.children)) for (const child of children) visit(child)
  }
  for (const id of rootIds) visit(id)
  function renderGroup(ids: string[]): string {
    return ids.length === 1 ? render(ids[0]!) : `<>${ids.map(render).join('')}</>`
  }
  function render(id: string): string {
    const node = document.nodes[id]!
    const name = bindingNames.get(node.componentId)!
    const props = Object.entries(node.props).map(([key, value]) => ` ${key}={${quoted(value)}}`)
    for (const [slot, children] of Object.entries(node.children)) {
      if (slot !== 'children' && children.length) props.push(` ${slot}={${renderGroup(children)}}`)
    }
    const children = node.children.children ?? []
    return children.length ? `<${name}${props.join('')}>${children.map(render).join('')}</${name}>` : `<${name}${props.join('')} />`
  }
  const jsx = renderGroup(rootIds)
  const imports = dependencies.map(dependency => `import { ${dependency.exportName}${dependency.exportName === dependency.localName ? '' : ` as ${dependency.localName}`} } from ${quoted(dependency.moduleSpecifier)};`).join('\n')
  return { jsx, imports, code: `${imports}${imports ? '\n\n' : ''}${jsx}`, dependencies, contract: codeOutputCopy.componentContract }
}
