import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import type { Atom } from '@canvas/repo-engine/contracts'
import type { EditorDocument } from '@canvas/repo-engine/document'
import { convertCssDeclarations, serializeComponentUsage } from './code-output'

function parse(code: string) {
  const file = ts.createSourceFile('output.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics
  expect(diagnostics.map(diagnostic => diagnostic.messageText)).toEqual([])
  return file
}

function atom(id: string, exportName: string, props: Atom['props']): Atom {
  return { componentId: id, exportName, name: exportName, path: `src/${id}.tsx`, fingerprint: id, sourceHash: 'hash', status: 'bound', candidates: [], kind: 'atom', props }
}

const atoms = [
  atom('card', 'Card', [{ name: 'heading', type: 'ReactNode', optional: true }, { name: 'children', type: 'ReactNode', optional: true }, { name: 'footer', type: 'ReactNode', optional: true }]),
  atom('button', 'Button', [{ name: 'children', type: 'ReactNode', optional: false }, { name: 'disabled', type: 'boolean', optional: true }, { name: 'variant', type: "'quiet' | 'primary'", optional: true }]),
  atom('label', 'Label', [{ name: 'children', type: 'ReactNode', optional: false }, { name: 'htmlFor', type: 'string', optional: true }]),
]
const document: EditorDocument = {
  version: 1, revision: 3, rootIds: ['card-instance'],
  frame: { width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false },
  nodes: {
    'card-instance': { id: 'card-instance', componentId: 'card', exportName: 'Card', props: { heading: 'Sign in' }, children: { children: ['label-instance'], footer: ['button-instance'] } },
    'label-instance': { id: 'label-instance', componentId: 'label', exportName: 'Label', props: { children: 'Email', htmlFor: 'email' }, children: {} },
    'button-instance': { id: 'button-instance', componentId: 'button', exportName: 'Button', props: { children: 'Continue', disabled: false, variant: 'quiet' }, children: {} },
  },
}
const moduleSpecifiers = { card: './atoms/Card', button: './atoms/Button', label: './atoms/Label' }

describe('CSS declaration output', () => {
  it('converts keys and preserves numeric units, unitless numbers, custom properties, and vendor prefixes', () => {
    const output = convertCssDeclarations('margin-top: 8px; opacity: .5; line-height: 1.5; width: 4; --count: 2; -ms-flex: 1; -webkit-line-clamp: 2;')
    expect(output.styleCode).toBe('{\n  "marginTop": "8px",\n  "opacity": 0.5,\n  "lineHeight": 1.5,\n  "width": "4",\n  "--count": "2",\n  "msFlex": "1",\n  "WebkitLineClamp": "2"\n}')
    expect(output.diagnostics).toEqual([])
    expect(output.retainedCss).toBe('')
    parse(`const style = ${output.styleCode};`)
  })

  it('keeps nested functions, quoted separators and comment delimiters inside strings intact', () => {
    const css = '/* start; */ color: rgb(1 2 3 / .5); width: calc(100% - var(--gap, 2px)); content: "a;:/*literal*/";'
    const output = convertCssDeclarations(css)
    expect(output.declarationCss).toBe(css)
    expect(output.styleCode).toBe('{\n  "color": "rgb(1 2 3 / .5)",\n  "width": "calc(100% - var(--gap, 2px))",\n  "content": "\\"a;:/*literal*/\\""\n}')
    expect(output.diagnostics).toEqual([])
  })

  it('retains important priorities and repeated fallbacks instead of silently weakening the CSS', () => {
    const output = convertCssDeclarations('color: red ! /*priority*/ important; display: -webkit-box; display: flex; padding: 4px;')
    expect(output.styleCode).toBe('{\n  "padding": "4px"\n}')
    expect(output.diagnostics.map(item => item.code)).toEqual(['important', 'duplicate', 'duplicate'])
    expect(output.retainedCss).toContain('color: red ! /*priority*/ important;')
    expect(output.retainedCss).toContain('display: -webkit-box;')
    expect(output.retainedCss).toContain('display: flex;')
    expect(convertCssDeclarations('display: flex;').styleCode).toBe('{\n  "display": "flex"\n}')
  })

  it.each(['button:hover { color: red }', '@media (width > 20px) { color: red }', '@keyframes pulse { from { opacity: 0 } }', '@import "theme.css";'])('retains stylesheet syntax: %s', css => {
    const output = convertCssDeclarations(css)
    expect(output.styleCode).toBe('{}')
    expect(output.retainedCss).toBe(css)
    expect(output.diagnostics[0]?.code).toBe('stylesheet')
  })

  it.each(['color: "red', 'color: rgb(1 2 3;', 'color: red; /*', 'color: red);', 'color:', 'color red;', 'color: red;\u0000', 'color: [red);'])('rejects malformed input atomically: %s', css => {
    const output = convertCssDeclarations(css)
    expect(output.styleCode).toBe('{}')
    expect(output.retainedCss).toBe(css)
    expect(output.diagnostics[0]?.code).toBe('malformed')
  })

  it('retains escaped syntax and resource CSS for explicit review', () => {
    const output = convertCssDeclarations('c\\6flor: red; background: url("javascript:alert(1)"); width: expression(alert(1)); color: blue;')
    expect(output.styleCode).toBe('{\n  "color": "blue"\n}')
    expect(output.diagnostics.map(item => item.code)).toEqual(['escaped-syntax', 'resource', 'resource'])
    expect(output.retainedCss).toContain('javascript:alert(1)')
  })

  it('cannot turn string content into additional JavaScript statements', () => {
    const css = `content: '\"};globalThis.compromised=true;//</script>';`
    const output = convertCssDeclarations(css)
    const file = parse(`const style = ${output.styleCode};`)
    expect(file.statements).toHaveLength(1)
    const statement = file.statements[0] as ts.VariableStatement
    const object = statement.declarationList.declarations[0]!.initializer as ts.ObjectLiteralExpression
    expect(ts.isObjectLiteralExpression(object)).toBe(true)
    expect(object.properties).toHaveLength(1)
    const property = object.properties[0] as ts.PropertyAssignment
    expect(ts.isStringLiteral(property.initializer)).toBe(true)
    expect((property.initializer as ts.StringLiteral).text).toBe(`'\"};globalThis.compromised=true;//</script>'`)
    expect(output.styleCode).not.toContain('</script>')
    expect(parse('const style = {};globalThis.compromised=true;').statements).toHaveLength(2)
  })

  it('bounds input and leaves empty CSS empty', () => {
    expect(convertCssDeclarations(' /* nothing */ ').styleCode).toBe('{}')
    const css = 'a'.repeat(65_537)
    expect(convertCssDeclarations(css)).toMatchObject({ styleCode: '{}', declarationCss: css, retainedCss: css, diagnostics: [{ code: 'input-limit' }] })
  })
})

describe('validated component usage output', () => {
  it('imports actual dependencies and serializes typed props and named slots without flattening', () => {
    const before = structuredClone(document)
    const output = serializeComponentUsage(document, atoms, { moduleSpecifiers })
    expect(output.imports).toBe('import { Card } from "./atoms/Card";\nimport { Label } from "./atoms/Label";\nimport { Button } from "./atoms/Button";')
    expect(output.jsx).toBe('<Card heading={"Sign in"} footer={<Button children={"Continue"} disabled={false} variant={"quiet"} />}><Label children={"Email"} htmlFor={"email"} /></Card>')
    expect(output.dependencies).toEqual([
      { componentId: 'card', sourcePath: 'src/card.tsx', exportName: 'Card', localName: 'Card', moduleSpecifier: './atoms/Card' },
      { componentId: 'label', sourcePath: 'src/label.tsx', exportName: 'Label', localName: 'Label', moduleSpecifier: './atoms/Label' },
      { componentId: 'button', sourcePath: 'src/button.tsx', exportName: 'Button', localName: 'Button', moduleSpecifier: './atoms/Button' },
    ])
    expect(output.contract).toContain('original application behavior are not reconstructed')
    expect(document).toEqual(before)
    expect(parse(output.code).statements).toHaveLength(4)
  })

  it('exports only the selected subtree and its dependencies', () => {
    const output = serializeComponentUsage(document, atoms, { moduleSpecifiers, rootIds: ['button-instance'] })
    expect(output.jsx).toBe('<Button children={"Continue"} disabled={false} variant={"quiet"} />')
    expect(output.dependencies.map(item => item.componentId)).toEqual(['button'])
  })

  it('uses fragments for multiple roots and named slot children', () => {
    const changed = structuredClone(document)
    changed.nodes['card-instance']!.children = { footer: ['label-instance', 'button-instance'] }
    const output = serializeComponentUsage(changed, atoms, { moduleSpecifiers })
    expect(output.jsx).toBe('<Card heading={"Sign in"} footer={<><Label children={"Email"} htmlFor={"email"} /><Button children={"Continue"} disabled={false} variant={"quiet"} /></>} />')
    parse(output.code)
    expect(serializeComponentUsage(document, atoms, { moduleSpecifiers, rootIds: [] }).jsx).toBe('<></>')
  })

  it('does not permit escaped strings to become JSX elements or script statements', () => {
    const changed = structuredClone(document)
    changed.nodes['label-instance']!.props.children = '</Label><script>danger()</script>{"}\n\u2028'
    const output = serializeComponentUsage(changed, atoms, { moduleSpecifiers, rootIds: ['label-instance'] })
    expect(output.jsx).toBe('<Label children={"\\u003c/Label\\u003e\\u003cscript\\u003edanger()\\u003c/script\\u003e{\\"}\\n\\u2028"} htmlFor={"email"} />')
    const file = parse(output.code)
    expect(file.statements).toHaveLength(2)
    const expression = (file.statements[1] as ts.ExpressionStatement).expression
    expect(ts.isJsxSelfClosingElement(expression)).toBe(true)
    const attributes = (expression as ts.JsxSelfClosingElement).attributes.properties
    expect(attributes).toHaveLength(2)
    const value = ((attributes[0] as ts.JsxAttribute).initializer as ts.JsxExpression).expression!
    expect(ts.isStringLiteral(value)).toBe(true)
    expect((value as ts.StringLiteral).text).toBe('</Label><script>danger()</script>{"}\n\u2028')
  })

  it('handles new component names and resolves colliding local import names', () => {
    const alternate = [atom('button', 'Widget', atoms[1]!.props), atom('label', 'Widget', atoms[2]!.props), atoms[0]!]
    const changed = structuredClone(document)
    changed.nodes['button-instance']!.exportName = 'Widget'
    changed.nodes['label-instance']!.exportName = 'Widget'
    const output = serializeComponentUsage(changed, alternate, { moduleSpecifiers })
    expect(output.imports).toContain('import { Widget as Widget2 } from "./atoms/Button";')
    expect(output.jsx).toContain('footer={<Widget2 children={"Continue"}')
    expect(output.jsx).toContain('<Widget children={"Email"}')
    parse(output.code)
  })

  it('aliases lowercase named source exports into valid component tags', () => {
    const changed = structuredClone(document)
    changed.nodes['label-instance']!.exportName = 'caption'
    const renamed = atoms.map(item => item.componentId === 'label' ? { ...item, exportName: 'caption' } : item)
    const output = serializeComponentUsage(changed, renamed, { moduleSpecifiers, rootIds: ['label-instance'] })
    expect(output.imports).toBe('import { caption as Caption } from "./atoms/Label";')
    expect(output.jsx).toBe('<Caption children={"Email"} htmlFor={"email"} />')
  })

  it('rejects missing bindings, overlapping selections, and unreviewed import paths', () => {
    expect(() => serializeComponentUsage(document, atoms.map(item => ({ ...item, status: 'missing' })), { moduleSpecifiers })).toThrow('binding')
    expect(() => serializeComponentUsage(document, atoms, { moduleSpecifiers, rootIds: ['card-instance', 'label-instance'] })).toThrow('non-overlapping')
    expect(() => serializeComponentUsage(document, atoms, { moduleSpecifiers, rootIds: ['unknown'] })).toThrow('non-overlapping')
    expect(() => serializeComponentUsage(document, atoms, { moduleSpecifiers: {} })).toThrow('module specifier')
    expect(() => serializeComponentUsage(document, atoms, { moduleSpecifiers: { ...moduleSpecifiers, card: 'javascript:alert(1)' } })).toThrow('module specifier')
    expect(() => serializeComponentUsage(document, [...atoms, atoms[0]!], { moduleSpecifiers })).toThrow('unique identities')
  })

  it('rejects event handlers and invalid slot bindings before generating code', () => {
    const unsafe = structuredClone(document)
    unsafe.nodes['button-instance']!.props.onClick = 'runCode()'
    expect(() => serializeComponentUsage(unsafe, atoms, { moduleSpecifiers })).toThrow('Unsupported prop onClick')
    const invalidSlot = structuredClone(document)
    invalidSlot.nodes['card-instance']!.children = { unknown: ['button-instance', 'label-instance'] }
    expect(() => serializeComponentUsage(invalidSlot, atoms, { moduleSpecifiers })).toThrow('Invalid slot')
    expect(serializeComponentUsage(document, atoms, { moduleSpecifiers }).jsx).toContain('<Button')
  })
})
