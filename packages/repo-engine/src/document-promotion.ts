import path from 'node:path'
import * as recast from 'recast'
import { parseTsx } from './patches.js'
import { validateDocument } from './document.js'
import type { EditorDocument, DocumentValue } from './document.js'
import { hostOrigin } from './file-document.js'
import type { FileDocument } from './file-document.js'
import { projectPreviewPage } from './file-preview.js'
import { cssPropertyToJsx, rejectedSourceDeclaration } from './layout-css.js'
import { isRepositoryAtom } from './types.js'
import type { Atom, RepositoryAtom } from './types.js'

export type LayoutStyles = Record<string, Record<string, string>>

/**
 * Per-node layout as kebab-case longhands for a source `style` prop, matching what the preview runtime applies: the
 * five-field placement first (absolute position and px insets, px sizes, `flex: 0 0 auto` for a sized flow item),
 * then the projected declarations, which win. Authored insets replace the placement's left/top, and root-level px
 * insets shift by the host origin, exactly as the runtime places them. Built from `projectPreviewPage` so source and
 * preview cannot drift. Nodes without layout get no entry.
 */
export function promotionLayoutStyles(file: FileDocument, pageId: string): LayoutStyles {
  const projection = projectPreviewPage(file, pageId)
  if (!projection) throw new Error('Unknown page')
  const origin = hostOrigin(projection.document.frame)
  const roots = new Set(projection.document.rootIds)
  const styles: LayoutStyles = {}
  for (const entry of projection.layout) {
    const node = file.nodes[entry.nodeId]
    if (node?.type !== 'component' || !node.layout) continue
    const declarations = entry.declarations ?? {}
    const style: Record<string, string> = {}
    if (entry.mode === 'absolute') {
      style.position = 'absolute'
      if (!['left', 'right', 'top', 'bottom'].some(name => Object.hasOwn(declarations, name))) {
        const root = roots.has(entry.nodeId)
        style.left = `${root ? entry.x - origin.x : entry.x}px`
        style.top = `${root ? entry.y - origin.y : entry.y}px`
      }
    }
    if (entry.width !== undefined) {
      style.width = `${entry.width}px`
      if (entry.mode === 'flow') style.flex = '0 0 auto'
    }
    if (entry.height !== undefined) style.height = `${entry.height}px`
    Object.assign(style, declarations)
    if (Object.keys(style).length) styles[entry.nodeId] = style
  }
  return styles
}

/**
 * Builds a promoted component from a legacy page document. Layout is written only through `layoutStyles` as a
 * `style` prop on the node's own element (never a wrapper), and every declaration must pass the source grammar.
 */
export function documentPromotionSource(name: string, input: EditorDocument, atoms: Atom[], outputPath = `src/components/${name}.tsx`, layoutStyles?: LayoutStyles): string {
  if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(name) || atoms.some(atom => isRepositoryAtom(atom) && atom.exportName === name)) throw new Error('Choose a new PascalCase component name')
  if (!/^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.tsx$/.test(outputPath)) throw new Error('Unsupported promotion path')
  const document = validateDocument(input, atoms)
  // Drawn primitives have no source adapter. Layout without reviewed styles would be dropped silently, so it refuses too.
  if (document.canvas?.elements.length || (!layoutStyles && Object.values(document.nodes).some(node => node.layout))) throw new Error('Canvas layout needs a reviewed source adapter before promotion')
  const styles = new Map<string, Record<string, string>>()
  for (const [id, declarations] of Object.entries(layoutStyles ?? {})) {
    if (!Object.hasOwn(document.nodes, id)) throw new Error(`Layout style targets a node that is not on this page: ${id}`)
    if (declarations === null || typeof declarations !== 'object') throw new Error(`Layout style for ${id} is not a declaration map`)
    const rejected = rejectedSourceDeclaration(declarations)
    if (rejected !== null) throw new Error(`Layout style for ${id} is outside the reviewed CSS grammar: ${rejected}`)
    if (Object.hasOwn(document.nodes[id]!.props, 'style')) throw new Error(`Layout style for ${id} would replace its own style prop`)
    if (Object.keys(declarations).length) styles.set(id, declarations)
  }
  const b = recast.types.builders
  const scalar = (value: DocumentValue) => typeof value === 'string' ? b.stringLiteral(value) : typeof value === 'boolean' ? b.booleanLiteral(value) : b.numericLiteral(value)
  const used = new Map<string, RepositoryAtom>()
  for (const node of Object.values(document.nodes)) {
    const atom = atoms.find(candidate => candidate.componentId === node.componentId)!
    if (!isRepositoryAtom(atom)) throw new Error('Hosted components cannot be promoted to source')
    if (used.has(atom.exportName) && used.get(atom.exportName)!.componentId !== atom.componentId) throw new Error('Ambiguous component exports need an import alias adapter')
    used.set(atom.exportName, atom)
  }
  const fragment = (ids: string[]): ReturnType<typeof b.jsxFragment> => b.jsxFragment(b.jsxOpeningFragment(), b.jsxClosingFragment(), ids.map(render))
  function render(id: string): ReturnType<typeof b.jsxElement> {
    const node = document.nodes[id]!
    const attributes: ReturnType<typeof b.jsxAttribute>[] = [b.jsxAttribute(b.jsxIdentifier('key'), b.jsxExpressionContainer(b.stringLiteral(node.id)))]
    const children: (ReturnType<typeof b.jsxExpressionContainer> | ReturnType<typeof b.jsxElement>)[] = []
    for (const [prop, value] of Object.entries(node.props)) {
      if (prop === 'children') children.push(b.jsxExpressionContainer(scalar(value)))
      else attributes.push(b.jsxAttribute(b.jsxIdentifier(prop), b.jsxExpressionContainer(scalar(value))))
    }
    const style = styles.get(id)
    if (style) attributes.push(b.jsxAttribute(b.jsxIdentifier('style'), b.jsxExpressionContainer(b.objectExpression(Object.entries(style).map(([property, value]) => b.objectProperty(b.identifier(cssPropertyToJsx(property)), b.stringLiteral(value)))))))
    for (const [slot, ids] of Object.entries(node.children)) {
      if (slot === 'children') children.push(...ids.map(render))
      else if (ids.length) attributes.push(b.jsxAttribute(b.jsxIdentifier(slot), b.jsxExpressionContainer(fragment(ids))))
    }
    return b.jsxElement(b.jsxOpeningElement(b.jsxIdentifier(node.exportName), attributes, children.length === 0), children.length ? b.jsxClosingElement(b.jsxIdentifier(node.exportName)) : null, children)
  }
  const imports = [...used.values()].sort((a, z) => a.exportName.localeCompare(z.exportName)).map(atom => {
    if (!/^src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.tsx?$/.test(atom.path) || atom.path.split('/').includes('..')) throw new Error('Unsupported atom import path')
    let relative = path.posix.relative(path.posix.dirname(outputPath), atom.path).replace(/\.tsx?$/, '')
    if (!relative.startsWith('.')) relative = `./${relative}`
    return b.importDeclaration([b.importSpecifier(b.identifier(atom.exportName))], b.stringLiteral(relative))
  })
  const declaration = b.exportNamedDeclaration(b.functionDeclaration(b.identifier(name), [], b.blockStatement([b.returnStatement(fragment(document.rootIds))])))
  const source = recast.print(b.program([...imports, declaration]), { quote: 'single', tabWidth: 2 }).code + '\n'
  parseTsx(source)
  return source
}
