import { createHash } from 'node:crypto'
import { cp, lstat, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as recast from 'recast'
import { afterEach, describe, expect, it } from 'vitest'
import { createRepoEngine } from '../src/index'
import { applyFileCommand } from '../src/file-document'
import type { FileDocument } from '../src/file-document'
import type { NodeLayout } from '../src/layout'
import { parseTsx } from '../src/patches'
import type { Atom, Composition, EngineOptions } from '../src/types'
import { validatePreviewFiles } from '../../preview-runtime/src/index'

// Fixture helpers follow tests/engine.test.ts and tests/source-save-boundary.test.ts: a real copy of the seed
// repository, the shared dependency junction, and a real Vite build through validatePreviewFiles.
const fixtureRoot = fileURLToPath(new URL('../../../tests/fixtures/component-repo-seed/', import.meta.url))
const fixtureDependencies = fileURLToPath(new URL('../../../fixtures/component-repo/node_modules/', import.meta.url))
const prefix = 'design-editor-promotion-layout-'
const temporary: string[] = []
const originalLabel = "import type { ComponentProps } from 'react'\n\nexport function Label(props: ComponentProps<'label'>) {\n  return <label {...props} style={{ padding: '4px 0', ...props.style }} />\n}\n"
// A Card whose props cannot carry `style`: the staged promotion must fail type validation rather than drop layout.
const styleLessCard = "import type { ReactNode } from 'react'\n\nexport type CardProps = { heading?: ReactNode; footer?: ReactNode; children?: ReactNode }\n\nexport function Card({ heading, footer, children }: CardProps) {\n  return <section className=\"fixture-card\">{heading}{children}{footer}</section>\n}\n"
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const validatePreview: NonNullable<EngineOptions['validatePreview']> = input => validatePreviewFiles({ repositoryRoot: input.root, editorOrigin: 'design-editor://app', executionTrust: 'fixture-only' }, { ...input.binding, styles: ['src/globals.css'] }, input.files)
const px = (value: number) => ({ kind: 'px' as const, value })

async function fixture(card?: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  temporary.push(root)
  await cp(path.join(fixtureRoot, 'src'), path.join(root, 'src'), { recursive: true })
  await cp(path.join(fixtureRoot, 'package.json'), path.join(root, 'package.json'))
  await symlink(fixtureDependencies, path.join(root, 'node_modules'), 'junction')
  await writeFile(path.join(root, 'src/atoms/Label.tsx'), originalLabel)
  if (card) await writeFile(path.join(root, 'src/atoms/Card.tsx'), card)
  return root
}

/** sha256 of every project file outside the editor's own `.design-editor` folder and the dependency junction. */
async function sourceHashes(root: string, relative = ''): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (!relative && (entry.name === '.design-editor' || entry.name === 'node_modules')) continue
    if (entry.isSymbolicLink()) throw new Error(`Unexpected link in the fixture source tree: ${child}`)
    if (entry.isDirectory()) Object.assign(hashes, await sourceHashes(root, child))
    else if (entry.isFile()) hashes[child] = sha256(await readFile(path.join(root, child)))
  }
  return hashes
}
const changed = (before: Record<string, string>, after: Record<string, string>) => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]).sort()

afterEach(async () => {
  const temporaryRoot = await realpath(tmpdir())
  for (const root of temporary.splice(0)) {
    const canonical = await realpath(root)
    const relative = path.relative(temporaryRoot, canonical)
    if (!relative || path.isAbsolute(relative) || relative.includes(path.sep) || !relative.startsWith(prefix)) throw new Error('Refusing to remove an unexpected temporary fixture path')
    const dependencies = path.join(canonical, 'node_modules')
    if ((await lstat(dependencies).catch(() => null))?.isSymbolicLink()) await unlink(dependencies)
    await rm(canonical, { recursive: true, force: true })
  }
})

type Ids = { card: string; input: string; button: string; pinned: string }
/**
 * Through the real file commands: the login Card becomes a two column Grid (gap 8, padding 20), the Button spans both
 * columns, the first Input gets a 120 px flow width, and a new Button sits at the page root with a five-field absolute
 * placement at world (10, 20), 120 x 40.
 */
function layoutDesign(file: FileDocument, atoms: Atom[], composition: Composition): { file: FileDocument; ids: Ids } {
  const ids: Ids = { card: `${composition.id}:card`, input: composition.children.find(child => child.exportName === 'Input')!.id, button: composition.children.find(child => child.exportName === 'Button')!.id, pinned: 'pinned-button' }
  const button = atoms.find(atom => atom.exportName === 'Button' && atom.status === 'bound')!
  const grid: NodeLayout = { item: { position: { mode: 'flow' } }, container: { display: 'grid', gap: 8, grid: { columns: [{ kind: 'fr', value: 1 }, { kind: 'fr', value: 1 }], rows: [{ kind: 'auto' }], autoFlow: 'row' } }, spacing: { padding: 20 } }
  let next = applyFileCommand(file, { type: 'node.setLayout', nodeId: ids.card, layout: grid }, atoms)
  next = applyFileCommand(next, { type: 'node.setLayout', nodeId: ids.button, layout: { item: { position: { mode: 'flow' }, grid: { columnStart: 1, columnSpan: 2 } } } }, atoms)
  next = applyFileCommand(next, { type: 'node.setLayout', nodeId: ids.input, layout: { item: { position: { mode: 'flow' }, width: { value: px(120) } } } }, atoms)
  next = applyFileCommand(next, { type: 'node.insert', node: { id: ids.pinned, type: 'component', componentId: button.componentId, exportName: 'Button', props: { children: 'Pinned' } }, placement: { parentId: file.pages[0]!.rootNodeId } }, atoms)
  next = applyFileCommand(next, { type: 'node.setLayout', nodeId: ids.pinned, layout: { item: { position: { mode: 'absolute', left: px(10), top: px(20) }, width: { value: px(120) }, height: { value: px(40) } } } }, atoms)
  return { file: next, ids }
}

async function layoutProject(options: EngineOptions = {}, card?: string) {
  const root = await fixture(card)
  const engine = await createRepoEngine(root, { validatePreview, ...options })
  const opened = await engine.inspectFixture()
  const { file, ids } = layoutDesign(opened.file, opened.atoms, opened.composition)
  const saved = await engine.saveFile(file, opened.file.revision)
  return { root, engine, opened, saved, ids }
}

type Element = { name: string; key: string | null; style: Record<string, string> | null }
function elements(source: string): Element[] {
  const found: Element[] = []
  recast.types.visit(parseTsx(source), {
    visitJSXElement(path) {
      const opening = path.node.openingElement
      if (opening.name.type !== 'JSXIdentifier') throw new Error('Unexpected member or namespaced element name')
      const element: Element = { name: opening.name.name, key: null, style: null }
      for (const attribute of opening.attributes ?? []) {
        if (attribute.type !== 'JSXAttribute' || attribute.name.type !== 'JSXIdentifier') throw new Error('Unexpected spread or namespaced attribute')
        const value = attribute.value
        if (attribute.name.name === 'key' && value?.type === 'JSXExpressionContainer' && value.expression.type === 'StringLiteral') element.key = value.expression.value
        if (attribute.name.name === 'style') {
          if (value?.type !== 'JSXExpressionContainer' || value.expression.type !== 'ObjectExpression') throw new Error('Style is not an object literal')
          element.style = {}
          for (const property of value.expression.properties) {
            if (property.type !== 'ObjectProperty' || property.key.type !== 'Identifier' || property.value.type !== 'StringLiteral') throw new Error('Style entry is not a literal')
            element.style[property.key.name] = property.value.value
          }
        }
      }
      found.push(element)
      this.traverse(path)
    },
  })
  return found
}

describe('promotion with layout through the source transaction', () => {
  it('LAY-SAVE-001 and LAY-SAVE-004 stage without writing, then an approved Save writes exactly the promoted style props and rebinds identity', async () => {
    const { root, engine, opened, saved, ids } = await layoutProject()
    const before = await sourceHashes(root)
    expect(Object.keys(before)).toContain('src/components/index.ts')

    const prepared = await engine.preparePromotion('LayoutLogin')
    expect(prepared.summary).toBe('Promote Login to LayoutLogin with layout written as inline style props')
    expect(prepared.validation.map(check => [check.name, check.status])).toEqual([['Parse', 'passed'], ['Types', 'passed'], ['Preview build', 'passed']])
    expect(prepared.files.map(file => file.path)).toEqual(['src/components/LayoutLogin.tsx', 'src/components/index.ts'])
    const source = prepared.files[0]!.after!
    // Nothing under the project changed before approval; the candidate exists only in the staging area.
    expect(await sourceHashes(root)).toEqual(before)
    await expect(readFile(path.join(root, 'src/components/LayoutLogin.tsx'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(root, `.design-editor/staged/${prepared.id}/src/components/LayoutLogin.tsx`), 'utf8')).toBe(source)

    const found = elements(source)
    // One element per design node and only atom exports: no layout wrapper.
    expect(found.map(element => element.name).sort()).toEqual(['Button', 'Button', 'Card', 'Input', 'Input', 'Label', 'Label'])
    expect(found.map(element => element.key).sort()).toEqual([ids.card, ids.pinned, ...opened.composition.children.map(child => child.id)].sort())
    const styles = Object.fromEntries(found.filter(element => element.style).map(element => [element.key, element.style]))
    // Host origin (-176, -236): world (10, 20) is left 186, top 256.
    expect(styles).toEqual({
      [ids.card]: { display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: 'auto', gridAutoFlow: 'row', columnGap: '8px', rowGap: '8px', paddingTop: '20px', paddingRight: '20px', paddingBottom: '20px', paddingLeft: '20px' },
      [ids.button]: { gridColumnStart: '1', gridColumnEnd: 'span 2' },
      [ids.input]: { width: '120px', flex: '0 0 auto' },
      [ids.pinned]: { position: 'absolute', left: '186px', top: '256px', width: '120px', height: '40px' },
    })
    expect(source).not.toMatch(/className|<style|<div|<span/)

    const result = await engine.savePrepared(prepared.id, prepared.approvalDigest)
    expect(result.status).toBe('saved')
    const after = await sourceHashes(root)
    expect(changed(before, after)).toEqual(['src/components/LayoutLogin.tsx', 'src/components/index.ts'])
    expect(await readFile(path.join(root, 'src/components/LayoutLogin.tsx'), 'utf8')).toBe(source)
    expect(await readFile(path.join(root, 'src/components/index.ts'), 'utf8')).toBe(prepared.files[1]!.after)
    // Identity: the composition now binds the discovered promoted component, and the design file keeps its node ids and layouts.
    const promoted = result.snapshot.atoms.find(atom => atom.exportName === 'LayoutLogin')
    expect(promoted).toMatchObject({ kind: 'component', path: 'src/components/LayoutLogin.tsx', status: 'bound' })
    expect(result.snapshot.composition).toMatchObject({ componentId: promoted!.componentId, name: 'LayoutLogin', children: opened.composition.children })
    expect(result.snapshot.file.nodes).toEqual(saved.file.nodes)
    expect(result.snapshot.conflict).toBeNull()
    const reopened = await createRepoEngine(root, { validatePreview })
    expect((await reopened.inspectFixture()).composition.componentId).toBe(promoted!.componentId)
    expect(await sourceHashes(root)).toEqual(after)
  }, 120_000)

  it('LAY-SAVE-002 a source hash change after approval turns Save into a conflict and writes nothing', async () => {
    const { root, engine } = await layoutProject()
    const prepared = await engine.preparePromotion('LayoutLogin')
    const input = path.join(root, 'src/atoms/Input.tsx')
    await writeFile(input, `${await readFile(input, 'utf8')}\n`)
    const before = await sourceHashes(root)

    const result = await engine.savePrepared(prepared.id, prepared.approvalDigest)
    expect(result.status).toBe('conflict')
    expect(result.snapshot.conflict).toMatchObject({ kind: 'external-change', paths: ['src/atoms/Input.tsx'] })
    expect(await sourceHashes(root)).toEqual(before)
    await expect(readFile(path.join(root, 'src/components/LayoutLogin.tsx'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(engine.savePrepared(prepared.id, prepared.approvalDigest)).rejects.toThrow('Approval is missing, expired, or does not match this change')
    expect(await sourceHashes(root)).toEqual(before)

    // Negative control: after refresh, a fresh review against the current hashes does save.
    await engine.refresh()
    const fresh = await engine.preparePromotion('LayoutLogin')
    expect((await engine.savePrepared(fresh.id, fresh.approvalDigest)).status).toBe('saved')
    expect(changed(before, await sourceHashes(root))).toEqual(['src/components/LayoutLogin.tsx', 'src/components/index.ts'])
  }, 120_000)

  it('LAY-SAVE-003 a staged candidate that fails type validation writes nothing', async () => {
    // The Card here cannot accept a style prop, so the staged promotion fails TypeScript diagnostics in staging.
    const { root, engine } = await layoutProject({}, styleLessCard)
    const before = await sourceHashes(root)
    await expect(engine.preparePromotion('LayoutLogin')).rejects.toThrow(/Source validation failed[\s\S]*Property 'style' does not exist/)
    expect(await sourceHashes(root)).toEqual(before)
    await expect(readFile(path.join(root, 'src/components/LayoutLogin.tsx'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(root, '.design-editor/transaction.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)

  it('LAY-SAVE-003 a failure between file replacements rolls back every file and keeps the old binding', async () => {
    const { root, engine, opened } = await layoutProject({ afterReplacement: index => { if (index === 1) throw new Error('Injected disk failure') } })
    const before = await sourceHashes(root)
    const prepared = await engine.preparePromotion('LayoutLogin')
    const result = await engine.savePrepared(prepared.id, prepared.approvalDigest)
    expect(result.status).toBe('rolled-back')
    expect(await sourceHashes(root)).toEqual(before)
    await expect(readFile(path.join(root, 'src/components/LayoutLogin.tsx'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(path.join(root, '.design-editor/transaction.json'), 'utf8'))).toMatchObject({ status: 'rolled-back', message: 'Injected disk failure' })
    expect(result.snapshot.conflict).toMatchObject({ kind: 'rollback', paths: ['src/components/LayoutLogin.tsx', 'src/components/index.ts'] })
    expect(result.snapshot.composition.componentId).toBe(opened.composition.componentId)
    expect(result.snapshot.atoms.some(atom => atom.exportName === 'LayoutLogin')).toBe(false)
  }, 120_000)
})
