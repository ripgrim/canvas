import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, join, relative, sep } from 'node:path'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const effectNames = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect'])
const lifecycleNames = new Set(['componentDidMount', 'componentDidUpdate', 'componentWillUnmount', 'componentWillMount', 'componentWillReceiveProps', 'componentWillUpdate', 'getSnapshotBeforeUpdate', 'getDerivedStateFromProps'])
const sideEffectCalls = new Set(['fetch', 'setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'])
const sideEffectMembers = new Set(['log', 'warn', 'error', 'subscribe', 'setState', 'dispatch', 'navigate', 'push', 'replace', 'assign', 'write', 'writeFile', 'setItem'])
const copyProps = new Set(['title', 'label', 'placeholder', 'description', 'message', 'aria-label', 'alt'])

function nodeName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined
}

function isPage(path) {
  return /(?:^|\/)(?:pages|routes)\//.test(path.replaceAll('\\', '/'))
}

function rootDocument(path, node) {
  if (!/\/routes\/__root\.tsx$/.test(path.replaceAll('\\', '/'))) return false
  if (!ts.isJsxElement(node) || node.openingElement.tagName.getText() !== 'html') return false
  const children = node.children.filter(child => !ts.isJsxText(child) || child.getText().trim())
  if (children.length !== 2) return false
  const [head, body] = children
  if (!ts.isJsxSelfClosingElement(head) || head.tagName.getText() !== 'head') return false
  if (!ts.isJsxElement(body) || body.openingElement.tagName.getText() !== 'body') return false
  const bodyChildren = body.children.filter(child => !ts.isJsxText(child) || child.getText().trim())
  return bodyChildren.length === 1 && ts.isJsxSelfClosingElement(bodyChildren[0]) && /^[A-Z]/.test(bodyChildren[0].tagName.getText())
}

export function checkSource(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const violations = []
  const aliases = new Set(effectNames)
  const namespaces = new Set(['React'])
  const page = isPage(path)
  const add = (node, reason) => violations.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${reason}`)
  const reference = node => ts.isIdentifier(node) && aliases.has(node.text)
    || ts.isPropertyAccessExpression(node) && effectNames.has(node.name.text)
    || ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && effectNames.has(node.argumentExpression.text)

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === 'react' && statement.importClause) {
      const clause = statement.importClause
      if (clause.name) namespaces.add(clause.name.text)
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text)
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const specifier of clause.namedBindings.elements) {
        const imported = specifier.propertyName?.text ?? specifier.name.text
        if (effectNames.has(imported)) {
          aliases.add(specifier.name.text)
          add(specifier, `prohibited lifecycle import ${imported}`)
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const specifier of statement.exportClause.elements) {
      const name = specifier.propertyName?.text ?? specifier.name.text
      if (effectNames.has(name) || aliases.has(name)) add(specifier, `prohibited lifecycle re-export ${name}`)
    }
    if (ts.isExportDeclaration(statement) && !statement.exportClause && statement.moduleSpecifier?.text === 'react') add(statement, 'prohibited lifecycle wildcard re-export')
  }

  const documentNodes = new Set()
  function collectDocument(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === 'html') {
      if (rootDocument(path, node)) {
        documentNodes.add(node.openingElement)
        const [head, body] = node.children.filter(child => !ts.isJsxText(child) || child.getText().trim())
        documentNodes.add(head)
        documentNodes.add(body.openingElement)
      } else add(node, 'invalid document shell')
    }
    ts.forEachChild(node, collectDocument)
  }
  if (page) collectDocument(file)

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && reference(node.initializer)) aliases.add(node.name.text)
      if (ts.isObjectBindingPattern(node.name) && namespaces.has(node.initializer.getText(file))) for (const element of node.name.elements) {
        const original = element.propertyName ? nodeName(element.propertyName) : nodeName(element.name)
        if (effectNames.has(original)) {
          aliases.add(nodeName(element.name))
          add(element, `prohibited lifecycle alias ${original}`)
        }
      }
    }
    if (ts.isCallExpression(node) && reference(node.expression)) add(node, 'prohibited lifecycle call')
    if (ts.isPropertyAccessExpression(node) && effectNames.has(node.name.text)) add(node, `prohibited lifecycle member ${node.name.text}`)
    if (ts.isMethodDeclaration(node) && lifecycleNames.has(nodeName(node.name))) add(node, `prohibited class lifecycle ${nodeName(node.name)}`)
    if (ts.isPropertyDeclaration(node) && lifecycleNames.has(nodeName(node.name))) add(node, `prohibited class lifecycle ${nodeName(node.name)}`)
    if (page) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^[a-z]/.test(node.tagName.getText(file))) {
        if (!documentNodes.has(node)) add(node, 'page contains raw DOM')
      }
      if (ts.isJsxAttribute(node)) {
        const prop = node.name.getText(file)
        if (prop === 'className') add(node, 'page contains className')
        if (copyProps.has(prop) && node.initializer && ts.isStringLiteral(node.initializer)) add(node, `page contains inline copy in ${prop}`)
      }
      if (ts.isJsxText(node) && node.getText(file).trim()) add(node, 'page contains inline copy')
      if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteralLike(node.expression)) add(node, 'page contains inline copy')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  function renderVisit(node) {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return
    if (ts.isCallExpression(node)) {
      const target = node.expression
      if (ts.isIdentifier(target) && sideEffectCalls.has(target.text)) add(node, `render-time side effect ${target.text}`)
      if (ts.isPropertyAccessExpression(target) && sideEffectMembers.has(target.name.text)) add(node, `render-time side effect ${target.name.text}`)
    }
    if (ts.isNewExpression(node) && /^(WebSocket|Worker|EventSource)$/.test(node.expression.getText(file))) add(node, 'render-time external resource')
    ts.forEachChild(node, renderVisit)
  }
  for (const statement of file.statements) {
    if (page && ts.isFunctionDeclaration(statement) && statement.name && /^[A-Z]/.test(statement.name.text) && statement.body) {
      if (statement.body.statements.length !== 1 || !ts.isReturnStatement(statement.body.statements[0])) add(statement, 'page contains feature implementation')
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && /^[A-Z]/.test(statement.name.text) && statement.body) renderVisit(statement.body)
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (page && ts.isIdentifier(declaration.name) && /^[A-Z]/.test(declaration.name.text) && declaration.initializer && ts.isArrowFunction(declaration.initializer) && ts.isBlock(declaration.initializer.body)) {
        if (declaration.initializer.body.statements.length !== 1 || !ts.isReturnStatement(declaration.initializer.body.statements[0])) add(declaration, 'page contains feature implementation')
      }
      if (ts.isIdentifier(declaration.name) && /^[A-Z]/.test(declaration.name.text) && declaration.initializer && ts.isArrowFunction(declaration.initializer)) renderVisit(declaration.initializer.body)
    }
    if (ts.isClassDeclaration(statement)) for (const member of statement.members) {
      if (ts.isMethodDeclaration(member) && nodeName(member.name) === 'render' && member.body) renderVisit(member.body)
    }
  }
  return [...new Set(violations)]
}

async function scan(directory, violations) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', 'fixtures', '.git'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await scan(path, violations)
    else if (['.ts', '.tsx'].includes(extname(entry.name))) {
      const name = relative(root, path).split(sep).join('/')
      violations.push(...checkSource(await readFile(path, 'utf8'), name))
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = []
  await scan(root, violations)
  if (violations.length) {
    console.error(violations.join('\n'))
    process.exitCode = 1
  }
}
