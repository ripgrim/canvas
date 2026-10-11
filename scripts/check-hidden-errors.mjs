import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])

function sourceKind(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.ts') || path.endsWith('.mts')) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

function location(source, node) {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `${source.fileName}:${point.line + 1}:${point.character + 1}`
}

function returnsUndefined(block) {
  if (block.statements.length !== 1) return false
  const statement = block.statements[0]
  return ts.isReturnStatement(statement) && isUndefined(statement.expression)
}

function isUndefined(node) { return Boolean(node && ts.isIdentifier(node) && node.text === 'undefined') }

export function findHiddenErrorsInSource(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, sourceKind(path))
  const failures = []
  const visit = node => {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) failures.push(`${location(source, node)} empty catch clause`)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') {
      const handler = node.arguments[0]
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        const hidden = ts.isBlock(handler.body) ? handler.body.statements.length === 0 || returnsUndefined(handler.body) : isUndefined(handler.body)
        if (hidden) failures.push(`${location(source, handler)} rejected promise is discarded`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return failures
}

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (sourceExtensions.has(extname(entry.name)) && !/\.(?:test|spec)\.[^.]+$/.test(entry.name)) files.push(path)
  }
  return files
}

export async function checkHiddenErrors() {
  const files = []
  for (const group of ['apps', 'packages']) {
    for (const workspace of await readdir(join(root, group), { withFileTypes: true })) {
      if (workspace.isDirectory()) {
        const source = join(root, group, workspace.name, 'src')
        try { files.push(...await sourceFiles(source)) }
        catch (error) { if (error?.code !== 'ENOENT') throw error }
      }
    }
  }
  files.push(...await sourceFiles(join(root, 'scripts')))
  const failures = []
  for (const file of files) failures.push(...findHiddenErrorsInSource(relative(root, file), await readFile(file, 'utf8')))
  if (failures.length) throw new Error(`Hidden error paths are prohibited:\n${failures.join('\n')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkHiddenErrors().then(
    () => process.stdout.write('Hidden error check passed.\n'),
    error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 },
  )
}
