import { parse as babelParse } from '@babel/parser'
import * as recast from 'recast'
import postcss from 'postcss'

const parser = { parse: (source: string) => babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], tokens: true }) }

export function parseTsx(source: string) {
  return recast.parse(source, { parser })
}

export function patchLabelPadding(source: string, exportName: string, padding: string): string {
  if (!/^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))(?:\s+(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))){0,3}$/.test(padding)) throw new Error('Use one to four literal spacing values')
  // Raw Babel offsets preserve LF, CRLF, and tabs before Recast prints the changed literal.
  const ast = parser.parse(source)
  let matches = 0
  let inTarget = false
  let span: { start: number; end: number } | null = null
  recast.types.visit(ast, {
    visitFunctionDeclaration(functionPath) {
      if (functionPath.node.id?.name !== exportName) return false
      inTarget = true
      this.traverse(functionPath)
      inTarget = false
      return false
    },
    visitJSXOpeningElement(elementPath) {
      const element = elementPath.node
      if (!inTarget || element.name.type !== 'JSXIdentifier' || element.name.name !== 'label') return false
      for (const attribute of element.attributes ?? []) {
        if (attribute.type !== 'JSXAttribute' || attribute.name.name !== 'style') continue
        const value = attribute.value
        if (value?.type !== 'JSXExpressionContainer' || value.expression.type !== 'ObjectExpression') throw new Error('Computed padding has no writable literal provenance')
        for (const property of value.expression.properties) {
          if (property.type !== 'ObjectProperty') continue
          const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' ? property.key.value : null
          if (key !== 'padding') continue
          if (property.computed || property.value.type !== 'StringLiteral') throw new Error('Computed padding has no writable literal provenance')
          const literal = property.value as typeof property.value & { start: number; end: number }
          span = { start: literal.start, end: literal.end }
          matches += 1
        }
      }
      return false
    },
  })
  if (matches !== 1) throw new Error('Padding provenance is missing or ambiguous')
  const location = span as { start: number; end: number } | null
  if (!location || !Number.isInteger(location.start) || !Number.isInteger(location.end)) throw new Error('The padding literal has no verified source span')
  const printed = recast.print(recast.types.builders.stringLiteral(padding), { quote: source[location.start] === '"' ? 'double' : 'single' }).code
  return source.slice(0, location.start) + printed + source.slice(location.end)
}

export function patchToken(source: string, value: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error('Use a six-digit hex color')
  const root = postcss.parse(source)
  let matches = 0
  root.walkRules(':root', rule => rule.walkDecls('--accent', declaration => {
    declaration.value = value
    matches += 1
  }))
  if (matches !== 1) throw new Error('The canonical token declaration is missing or ambiguous')
  return root.toString()
}

export function promotionSource(name: string, source: string): string {
  if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(name) || ['Input', 'Button', 'Card', 'Label', 'PreviewLogin'].includes(name)) throw new Error('Choose a new PascalCase component name')
  const ast = parseTsx(source)
  let renamed = 0
  recast.types.visit(ast, {
    visitImportDeclaration(importPath) {
      const value = importPath.node.source.value
      if (typeof value === 'string' && value.startsWith('./')) importPath.node.source.value = `../${value.slice(2)}`
      else if (typeof value === 'string' && value.startsWith('../')) throw new Error('This preview import needs a verified promotion path adapter')
      return false
    },
    visitFunctionDeclaration(functionPath) {
      if (functionPath.node.id?.name === 'PreviewLogin') {
        functionPath.node.id.name = name
        renamed += 1
      }
      this.traverse(functionPath)
    },
  })
  if (renamed !== 1) throw new Error('The preview composition cannot be promoted safely')
  return recast.print(ast, { quote: 'single', lineTerminator: source.includes('\r\n') ? '\r\n' : '\n' }).code
}

export function appendExport(source: string, name: string): string {
  const ast = parseTsx(source)
  const statement = parseTsx(`export { ${name} } from './${name}'`).program.body[0]
  ast.program.body.push(statement)
  return recast.print(ast, { quote: 'single', lineTerminator: source.includes('\r\n') ? '\r\n' : '\n' }).code
}
