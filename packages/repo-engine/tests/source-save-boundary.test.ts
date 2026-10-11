import { createHash } from 'node:crypto'
import { cp, lstat, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createRepoEngine } from '../src/index'
import { applyFileCommand } from '../src/file-document'
import type { FileDocument } from '../src/file-document'
import type { NodeLayout } from '../src/layout'
import type { EngineOptions } from '../src/types'
import { validatePreviewFiles } from '../../preview-runtime/src/index'

// LAY-SAVE-001 baseline: design file edits, including layout, never write source files. Source bytes change only
// through a prepared, approved source transaction. Already covered in engine.test.ts and relied on here:
// AT-SRC-003 (a prepared patch writes nothing until Save with the exact approval) and AT-SRC-001 (an input hash
// change after review turns Save into a conflict without writing).

const fixtureRoot = fileURLToPath(new URL('../../../tests/fixtures/component-repo-seed/', import.meta.url))
const fixtureDependencies = fileURLToPath(new URL('../../../fixtures/component-repo/node_modules/', import.meta.url))
const fixtureLockfile = fileURLToPath(new URL('../../../fixtures/component-repo/pnpm-lock.yaml', import.meta.url))
const prefix = 'design-editor-save-boundary-'
const temporary: string[] = []
const originalLabel = "import type { ComponentProps } from 'react'\n\nexport function Label(props: ComponentProps<'label'>) {\n  return <label {...props} style={{ padding: '4px 0', ...props.style }} />\n}\n"
const changedLabel = "import type { ComponentProps } from 'react'\n\nexport function Label(props: ComponentProps<'label'>) {\n  return <label {...props} style={{ padding: '8px 12px', ...props.style }} />\n}\n"
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const validatePreview: NonNullable<EngineOptions['validatePreview']> = input => validatePreviewFiles({ repositoryRoot: input.root, editorOrigin: 'design-editor://app', executionTrust: 'fixture-only' }, { ...input.binding, styles: ['src/globals.css'] }, input.files)
const layout: NodeLayout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 10 }, top: { kind: 'px', value: 20 } } } }

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  temporary.push(root)
  await cp(path.join(fixtureRoot, 'src'), path.join(root, 'src'), { recursive: true })
  await cp(path.join(fixtureRoot, 'package.json'), path.join(root, 'package.json'))
  await cp(fixtureLockfile, path.join(root, 'pnpm-lock.yaml'))
  await symlink(fixtureDependencies, path.join(root, 'node_modules'), 'junction')
  await writeFile(path.join(root, 'src/atoms/Label.tsx'), originalLabel)
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

/** Inserts a Button at the page root and gives it a v4 absolute layout, through the real file commands. */
function editDesign(file: FileDocument, atoms: Parameters<typeof applyFileCommand>[2], nodeId: string): FileDocument {
  const button = atoms.find(atom => atom.exportName === 'Button' && atom.status === 'bound')
  if (!button) throw new Error('The fixture has no bound Button atom')
  const inserted = applyFileCommand(file, { type: 'node.insert', node: { id: nodeId, type: 'component', componentId: button.componentId, exportName: 'Button', props: { children: 'Boundary' } }, placement: { parentId: file.pages[0]!.rootNodeId } }, atoms)
  return applyFileCommand(inserted, { type: 'node.setLayout', nodeId, layout }, atoms)
}

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

describe('LAY-SAVE-001 design edits never write source before explicit Save', () => {
  it('applies insert and v4 setLayout commands and saves the design file without changing any source byte', async () => {
    const root = await fixture()
    const before = await sourceHashes(root)
    expect(Object.keys(before).sort()).toEqual(['package.json', 'pnpm-lock.yaml', 'src/PreviewLogin.tsx', 'src/atoms/Button.tsx', 'src/atoms/Card.tsx', 'src/atoms/Input.tsx', 'src/atoms/Label.tsx', 'src/atoms/index.ts', 'src/components/index.ts', 'src/globals.css'])
    expect(before['src/atoms/Label.tsx']).toBe(sha256(originalLabel))

    const engine = await createRepoEngine(root)
    const opened = await engine.inspectFixture()
    const edited = editDesign(opened.file, opened.atoms, 'boundary-button')
    expect(edited.nodes['boundary-button']).toEqual({ id: 'boundary-button', type: 'component', componentId: opened.atoms.find(atom => atom.exportName === 'Button')!.componentId, exportName: 'Button', props: { children: 'Boundary' }, layout, themeMode: 'inherit' })
    expect(edited.revision).toBe(opened.file.revision + 2)
    expect(await sourceHashes(root)).toEqual(before)

    const saved = await engine.saveFile(edited, opened.file.revision)
    // The stored revision advances once per save from the expected base, whatever the local command count was.
    expect(saved.file.revision).toBe(opened.file.revision + 1)
    const stored = JSON.parse(await readFile(path.join(root, '.design-editor/document.json'), 'utf8'))
    expect(stored.revision).toBe(opened.file.revision + 1)
    expect(stored.nodes['boundary-button'].layout).toEqual({ item: { position: { mode: 'absolute', left: { kind: 'px', value: 10 }, top: { kind: 'px', value: 20 } } } })
    expect(await sourceHashes(root)).toEqual(before)
    // The save wrote only the design file and identity metadata: no staged candidate, journal, lock, or temporary file.
    expect((await readdir(path.join(root, '.design-editor'))).sort()).toEqual(['document.json', 'identity.json'])

    const reopened = await createRepoEngine(root)
    expect((await reopened.inspectFixture()).file.nodes['boundary-button']).toMatchObject({ layout })
    expect(await sourceHashes(root)).toEqual(before)

    // Negative control: the hash walk sees a real source change at exactly that path.
    await writeFile(path.join(root, 'src/atoms/Button.tsx'), `${await readFile(path.join(root, 'src/atoms/Button.tsx'), 'utf8')}\n`)
    const changed = await sourceHashes(root)
    expect(Object.keys(changed).filter(file => changed[file] !== before[file])).toEqual(['src/atoms/Button.tsx'])
  }, 60_000)

  it('stages a prepared source change outside the source tree, and a design save in between invalidates its approval', async () => {
    const root = await fixture()
    const before = await sourceHashes(root)
    const engine = await createRepoEngine(root, { validatePreview })
    const opened = await engine.inspectFixture()

    const prepared = await engine.prepareLabelPadding('8px 12px')
    expect(prepared.validation.map(check => check.status)).toEqual(['passed', 'passed', 'passed'])
    expect(await readFile(path.join(root, `.design-editor/staged/${prepared.id}/src/atoms/Label.tsx`), 'utf8')).toBe(changedLabel)
    expect(await sourceHashes(root)).toEqual(before)

    await engine.saveFile(editDesign(opened.file, opened.atoms, 'boundary-button'), opened.file.revision)
    await expect(engine.savePrepared(prepared.id, prepared.approvalDigest)).rejects.toThrow('Approval is missing, expired, or does not match this change')
    expect(await sourceHashes(root)).toEqual(before)

    // Negative control: a fresh review of the same change, approved with its own digest, does write the source.
    const fresh = await engine.prepareLabelPadding('8px 12px')
    expect(await sourceHashes(root)).toEqual(before)
    expect((await engine.savePrepared(fresh.id, fresh.approvalDigest)).status).toBe('saved')
    const after = await sourceHashes(root)
    expect(after['src/atoms/Label.tsx']).toBe(sha256(changedLabel))
    expect(Object.keys(after).filter(file => after[file] !== before[file])).toEqual(['src/atoms/Label.tsx'])
    expect(JSON.parse(await readFile(path.join(root, '.design-editor/document.json'), 'utf8')).nodes['boundary-button'].layout).toEqual(layout)
  }, 120_000)
})
