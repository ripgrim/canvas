import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { Node, Project, SyntaxKind, ts } from 'ts-morph'
import type { Atom } from './types.js'
import { confined, readOptional } from './paths.js'

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

export async function sourceFiles(root: string, directory = 'src'): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(await confined(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error('Symbolic source links need an explicit adapter')
    if (entry.isDirectory()) Object.assign(files, await sourceFiles(root, relative))
    else if (/\.(?:tsx?|css)$/.test(entry.name)) files[relative] = (await readOptional(root, relative))!
  }
  return files
}

export function makeProject(root: string, files: Record<string, string>) {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      esModuleInterop: true,
    },
  })
  for (const [relative, source] of Object.entries(files)) {
    if (/\.tsx?$/.test(relative)) project.createSourceFile(path.join(root, relative), source, { overwrite: true })
  }
  return project
}

function fingerprint(node: Node): string {
  const tokens: string[] = []
  const declaredName = Node.isFunctionDeclaration(node) ? node.getNameNode() : undefined
  const walk = (current: Node) => {
    if (current === declaredName) { tokens.push('DeclarationName'); return }
    const children = current.getChildren()
    if (children.length) children.forEach(walk)
    else tokens.push(`${current.getKind()}:${current.getText()}`)
  }
  walk(node)
  return hash(tokens.join('|'))
}

export function discover(root: string, files: Record<string, string>): Omit<Atom, 'componentId' | 'status' | 'candidates'>[] {
  const project = makeProject(root, files)
  const candidates: Omit<Atom, 'componentId' | 'status' | 'candidates'>[] = []
  for (const [entry, kind] of [['src/atoms/index.ts', 'atom'], ['src/components/index.ts', 'component']] as const) {
    const barrel = project.getSourceFile(path.join(root, entry))
    if (!barrel) continue
    for (const [exportName, declarations] of barrel.getExportedDeclarations()) {
      for (const declaration of declarations) {
        if (!Node.isFunctionDeclaration(declaration) || !declaration.getDescendants().some(node => [SyntaxKind.JsxElement, SyntaxKind.JsxSelfClosingElement, SyntaxKind.JsxFragment].includes(node.getKind()))) continue
        const relative = path.relative(root, declaration.getSourceFile().getFilePath()).replaceAll('\\', '/')
        if (!Object.hasOwn(files, relative)) throw new Error('Export resolves outside indexed source')
        const parameter = declaration.getParameters()[0]
        const props = parameter?.getType().getProperties().map(symbol => ({
          name: symbol.getName(),
          type: symbol.getTypeAtLocation(parameter).getText(parameter),
          optional: symbol.isOptional(),
        })) ?? []
        candidates.push({ name: exportName, exportName, path: relative, fingerprint: fingerprint(declaration), sourceHash: hash(files[relative]!), props, kind })
      }
    }
  }
  return candidates
}

export function reconcile(previous: Atom[], candidates: ReturnType<typeof discover>): Atom[] {
  const remaining = new Set(candidates)
  const bindings: Atom[] = []
  for (const old of previous) {
    const exact = candidates.filter(candidate => candidate.path === old.path && candidate.exportName === old.exportName)
    if (exact.length === 1 && old.status === 'bound') {
      remaining.delete(exact[0]!)
      bindings.push({ ...exact[0]!, componentId: old.componentId, status: 'bound', candidates: [] })
      continue
    }
    const alternatives = candidates.filter(candidate => candidate.fingerprint === old.fingerprint)
    alternatives.forEach(candidate => remaining.delete(candidate))
    bindings.push({ ...old, status: alternatives.length ? 'ambiguous' : 'missing', candidates: alternatives.map(candidate => `${candidate.path}#${candidate.exportName}`) })
  }
  for (const candidate of remaining) bindings.push({ ...candidate, componentId: randomUUID(), status: 'bound', candidates: [] })
  return bindings
}
