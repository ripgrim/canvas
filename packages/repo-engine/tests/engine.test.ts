import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Real Vite builds in staging take several seconds each and overrun the 15 s default when the machine is busy.
vi.setConfig({ testTimeout: 90_000 })
import { createRepoEngine } from '../src/index'
import { patchLabelPadding } from '../src/patches'
import { appendOrderKeys, childrenOf } from '../src/file-document'
import type { ComponentNode, FileDocument } from '../src/file-document'
import { validatePreviewFiles } from '../../preview-runtime/src/index'

const fixtureRoot = fileURLToPath(new URL('../../../tests/fixtures/component-repo-seed/', import.meta.url))
const fixtureDependencies = fileURLToPath(new URL('../../../fixtures/component-repo/node_modules/', import.meta.url))
const fixtureLockfile = fileURLToPath(new URL('../../../fixtures/component-repo/pnpm-lock.yaml', import.meta.url))
const temporary: string[] = []
const originalLabel = "import type { ComponentProps } from 'react'\n\nexport function Label(props: ComponentProps<'label'>) {\n  return <label {...props} style={{ padding: '4px 0', ...props.style }} />\n}\n"
const changedLabel = "import type { ComponentProps } from 'react'\n\nexport function Label(props: ComponentProps<'label'>) {\n  return <label {...props} style={{ padding: '8px 12px', ...props.style }} />\n}\n"
const checksum = (source: string) => createHash('sha256').update(source).digest('hex')
const validatePreview: NonNullable<import('../src/types').EngineOptions['validatePreview']> = input => validatePreviewFiles({ repositoryRoot: input.root, editorOrigin: 'design-editor://app', executionTrust: 'fixture-only' }, { ...input.binding, styles: ['src/globals.css'] }, input.files)

const createValidatedEngine = (root: string, options: import('../src/types').EngineOptions = {}) => createRepoEngine(root, { validatePreview, ...options })
const documentPath = (root: string) => path.join(root, '.design-editor/document.json')
const backupPath = (root: string) => path.join(root, '.design-editor/document.v1.backup.json')
function componentNode(file: FileDocument, id: string): ComponentNode {
  const node = file.nodes[id]
  if (node?.type !== 'component') throw new Error(`Expected component node ${id}`)
  return node
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'design-editor-source-test-'))
  temporary.push(root)
  await cp(path.join(fixtureRoot, 'src'), path.join(root, 'src'), { recursive: true })
  await cp(path.join(fixtureRoot, 'package.json'), path.join(root, 'package.json'))
  await cp(fixtureLockfile, path.join(root, 'pnpm-lock.yaml'))
  await symlink(fixtureDependencies, path.join(root, 'node_modules'), 'junction')
  await writeFile(path.join(root, 'src/atoms/Label.tsx'), originalLabel)
  return root
}

afterEach(async () => {
  const temporaryRoot = await realpath(tmpdir())
  for (const root of temporary.splice(0)) {
    const canonical = await realpath(root)
    const relative = path.relative(temporaryRoot, canonical)
    if (await lstat(root).then(stat => stat.isSymbolicLink()) || !relative || path.isAbsolute(relative) || relative.includes(path.sep) || !/^design-editor-(?:source-test|outside)-[A-Za-z0-9]+$/.test(relative)) throw new Error('Refusing to remove an unexpected temporary fixture path')
    for (const name of ['node_modules', 'src']) {
      const candidate = path.join(canonical, name)
      const stat = await lstat(candidate).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (stat?.isSymbolicLink()) await unlink(candidate)
    }
    await rm(canonical, { recursive: true, force: true })
  }
})

describe('real source transactions', () => {
  it('AT-SRC-006 persists reviewed source undo and redo without writing before Save', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const patch = await engine.prepareLabelPadding('8px 12px')
    await engine.savePrepared(patch.id, patch.approvalDigest)
    const reopened = await createValidatedEngine(root)
    const state = await reopened.inspectFixture()
    expect(state.sourceHistory.at(-1)).toEqual({ transactionId: patch.id, summary: 'Change shared Label padding', action: 'undo' })
    await expect(reopened.prepareRedo(patch.id)).rejects.toThrow('no saved transaction')
    const undo = await reopened.prepareUndo(patch.id)
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(changedLabel)
    await expect(reopened.savePrepared(undo.id, patch.approvalDigest)).rejects.toThrow('Approval')
    const undone = await reopened.savePrepared(undo.id, undo.approvalDigest)
    expect(undone.status).toBe('saved')
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(originalLabel)
    const redo = await reopened.prepareRedo(undo.id)
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(originalLabel)
    const redone = await reopened.savePrepared(redo.id, redo.approvalDigest)
    expect(redone.status).toBe('saved')
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(changedLabel)
    await expect(reopened.prepareUndo(patch.id)).rejects.toThrow('latest')
  }, 60_000)

  it('AT-SRC-006 reverses promotion files and rebinds the original identity on redo', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const initial = await engine.inspectFixture()
    const patch = await engine.preparePromotion('UndoLogin')
    const saved = await engine.savePrepared(patch.id, patch.approvalDigest)
    const promotedId = saved.snapshot.composition.componentId
    expect(promotedId).not.toBeNull()
    const undo = await engine.prepareUndo(patch.id)
    const undone = await engine.savePrepared(undo.id, undo.approvalDigest)
    expect(undone.status).toBe('saved')
    expect(undone.snapshot.composition).toEqual(initial.composition)
    expect(undone.snapshot.conflict).toBeNull()
    await expect(readFile(path.join(root, 'src/components/UndoLogin.tsx'))).rejects.toMatchObject({ code: 'ENOENT' })
    const reopened = await createValidatedEngine(root)
    const redo = await reopened.prepareRedo(undo.id)
    const redone = await reopened.savePrepared(redo.id, redo.approvalDigest)
    expect(redone.status).toBe('saved')
    expect(redone.snapshot.composition.componentId).toBe(promotedId)
    expect(await readFile(path.join(root, 'src/components/UndoLogin.tsx'), 'utf8')).toBe(patch.files[0]!.after)
  }, 60_000)

  it('refuses promotion undo after external deletion and redo after replacement', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const patch = await engine.preparePromotion('UndoLogin')
    await engine.savePrepared(patch.id, patch.approvalDigest)
    await unlink(path.join(root, 'src/components/UndoLogin.tsx'))
    await expect(engine.prepareUndo(patch.id)).rejects.toThrow('Source changed after Save')
    await writeFile(path.join(root, 'src/components/UndoLogin.tsx'), patch.files[0]!.after!)
    const undo = await engine.prepareUndo(patch.id)
    await engine.savePrepared(undo.id, undo.approvalDigest)
    await writeFile(path.join(root, 'src/components/UndoLogin.tsx'), 'export const external = true\n')
    await expect(engine.prepareRedo(undo.id)).rejects.toThrow('Source changed after Save')
    expect(await readFile(path.join(root, 'src/components/UndoLogin.tsx'), 'utf8')).toBe('export const external = true\n')
  })

  it('rolls back a failed promotion undo with its binding and saved source intact', async () => {
    const root = await fixture()
    let failReverse = false
    const engine = await createValidatedEngine(root, { afterReplacement: index => { if (failReverse && index === 1) throw new Error('Reverse write failure') } })
    const patch = await engine.preparePromotion('UndoLogin')
    const saved = await engine.savePrepared(patch.id, patch.approvalDigest)
    const before = await readFile(path.join(root, 'src/components/UndoLogin.tsx'), 'utf8')
    const reverse = await engine.prepareUndo(patch.id)
    failReverse = true
    const result = await engine.savePrepared(reverse.id, reverse.approvalDigest)
    expect(result.status).toBe('rolled-back')
    expect(result.snapshot.composition.componentId).toBe(saved.snapshot.composition.componentId)
    expect(await readFile(path.join(root, 'src/components/UndoLogin.tsx'), 'utf8')).toBe(before)
    expect((await readFile(path.join(root, 'src/components/index.ts'), 'utf8'))).toContain("export { UndoLogin } from './UndoLogin'")
    expect(result.snapshot.sourceHistory.at(-1)?.transactionId).toBe(patch.id)
  }, 60_000)

  it('a fresh project snapshot is the bound composition as one page file and writes no document', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const { file, composition, projectId } = await engine.inspectFixture()
    const pageId = `page-${projectId}`
    const rootId = `root:${pageId}`
    const cardId = `${composition.id}:card`
    expect(file).toMatchObject({ schemaVersion: 7, fileId: projectId, revision: 0, pages: [{ id: pageId, name: 'Page 1', rootNodeId: rootId }] })
    expect(composition.children.map(child => child.exportName)).toEqual(['Label', 'Input', 'Label', 'Input', 'Button'])
    expect(Object.keys(file.nodes).sort()).toEqual([rootId, cardId, ...composition.children.map(child => child.id)].sort())
    expect(file.nodes[cardId]).toMatchObject({ type: 'component', exportName: 'Card', props: { heading: 'Welcome back' } })
    expect(file.relationships[cardId]?.parentId).toBe(rootId)
    for (const child of composition.children) {
      expect(file.nodes[child.id]).toEqual({ id: child.id, type: 'component', componentId: child.componentId, exportName: child.exportName, props: child.props, themeMode: 'inherit' })
      expect(file.relationships[child.id]).toMatchObject({ parentId: cardId, slot: 'children' })
    }
    expect(childrenOf(file, cardId, 'children')).toEqual(composition.children.map(child => child.id))
    await expect(readFile(documentPath(root))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(path.join(root, '.design-editor/identity.json'), 'utf8'))).not.toHaveProperty('previewTheme')
  })

  it('file saves persist the design file only, reject stale or foreign files, and invalidate source approval', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const initial = await engine.inspectFixture()
    const button = initial.composition.children.find(child => child.exportName === 'Button')!
    const patch = await engine.prepareLabelPadding('8px 12px')
    const file = structuredClone(initial.file)
    componentNode(file, button.id).props.children = 'Continue'
    const saved = await engine.saveFile(file, 0)
    expect(saved.file.revision).toBe(1)
    expect(componentNode(saved.file, button.id).props.children).toBe('Continue')
    const bytes = await readFile(documentPath(root), 'utf8')
    const stored = JSON.parse(bytes)
    expect(stored).toMatchObject({ schemaVersion: 7, fileId: initial.projectId, revision: 1 })
    expect(stored.nodes[button.id].props.children).toBe('Continue')
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(originalLabel)
    await expect(engine.savePrepared(patch.id, patch.approvalDigest)).rejects.toThrow('Approval')
    await expect(engine.saveFile(file, 0)).rejects.toThrow('revision changed')
    await expect(engine.saveFile({ ...saved.file, fileId: 'another-project' }, 1)).rejects.toThrow('another project')
    expect(await readFile(documentPath(root), 'utf8')).toBe(bytes)
    const external = JSON.parse(bytes)
    external.nodes[button.id].props.children = 'Edited elsewhere'
    await writeFile(documentPath(root), JSON.stringify(external, null, 2))
    componentNode(saved.file, button.id).props.children = 'Local edit'
    await expect(engine.saveFile(saved.file, 1)).rejects.toThrow('contents changed')
    expect(JSON.parse(await readFile(documentPath(root), 'utf8')).nodes[button.id].props.children).toBe('Edited elsewhere')
    const reopened = await createValidatedEngine(root)
    expect(componentNode((await reopened.inspectFixture()).file, button.id).props.children).toBe('Edited elsewhere')
  })

  it('migrates a stored version 1 document in memory and backs up its bytes once on the first save', async () => {
    const root = await fixture()
    const first = await (await createValidatedEngine(root)).inspectFixture()
    const buttonId = first.atoms.find(atom => atom.exportName === 'Button')!.componentId
    const legacy = {
      version: 1, revision: 3, rootIds: ['legacy-button'],
      nodes: { 'legacy-button': { id: 'legacy-button', componentId: buttonId, exportName: 'Button', props: { children: 'Legacy label' }, children: {} } },
      frame: { name: 'Legacy page', width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false },
      canvas: { elements: [{ id: 'legacy-rect', kind: 'rectangle', name: 'Swatch', x: 10, y: 20, width: 30, height: 40, rotation: 0, fill: '#FF0000' }] },
    }
    const original = JSON.stringify(legacy, null, 2) + '\n'
    await writeFile(documentPath(root), original)
    const engine = await createValidatedEngine(root)
    const opened = await engine.inspectFixture()
    const pageId = `page-${first.projectId}`
    expect(opened.file).toMatchObject({ schemaVersion: 7, fileId: first.projectId, revision: 3, pages: [{ id: pageId, name: 'Legacy page', rootNodeId: `root:${pageId}` }] })
    expect(opened.file.nodes['legacy-button']).toEqual({ id: 'legacy-button', type: 'component', componentId: buttonId, exportName: 'Button', props: { children: 'Legacy label' }, themeMode: 'inherit' })
    expect(opened.file.nodes['legacy-rect']).toEqual({ id: 'legacy-rect', type: 'rectangle', name: 'Swatch', styles: { left: 10, top: 20, width: 30, height: 40 }, appearance: { fills: [{ id: 'legacy-rect:fill:1', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#ff0000' } } }] }, themeMode: 'inherit' })
    expect(opened.file.relationships['legacy-rect']?.parentId).toBe(`root:${pageId}`)
    await engine.refresh()
    expect(await readFile(documentPath(root), 'utf8')).toBe(original)
    await expect(readFile(backupPath(root))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(engine.saveFile(opened.file, 0)).rejects.toThrow('revision changed')
    expect(await readFile(documentPath(root), 'utf8')).toBe(original)
    await expect(readFile(backupPath(root))).rejects.toMatchObject({ code: 'ENOENT' })
    const edited = structuredClone(opened.file)
    componentNode(edited, 'legacy-button').props.children = 'Migrated label'
    const saved = await engine.saveFile(edited, 3)
    expect(saved.file.revision).toBe(4)
    expect(await readFile(backupPath(root), 'utf8')).toBe(original)
    const stored = JSON.parse(await readFile(documentPath(root), 'utf8'))
    expect(stored).toMatchObject({ schemaVersion: 7, fileId: first.projectId, revision: 4 })
    expect(stored).not.toHaveProperty('version')
    expect(stored.nodes['legacy-button'].props.children).toBe('Migrated label')
    const again = structuredClone(saved.file)
    componentNode(again, 'legacy-button').props.children = 'Second save'
    expect((await engine.saveFile(again, 4)).file.revision).toBe(5)
    expect(await readFile(backupPath(root), 'utf8')).toBe(original)
    expect((await readdir(path.join(root, '.design-editor'))).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([])
  })

  it('never replaces an existing version 1 backup', async () => {
    const root = await fixture()
    const first = await (await createValidatedEngine(root)).inspectFixture()
    const legacy = { version: 1, revision: 0, rootIds: [], nodes: {}, frame: { width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false } }
    await writeFile(documentPath(root), JSON.stringify(legacy))
    await writeFile(backupPath(root), 'earlier backup\n')
    const engine = await createValidatedEngine(root)
    const opened = await engine.inspectFixture()
    expect(opened.file.pages).toEqual([{ id: `page-${first.projectId}`, name: 'Page 1', rootNodeId: `root:page-${first.projectId}` }])
    await engine.saveFile(opened.file, 0)
    expect(await readFile(backupPath(root), 'utf8')).toBe('earlier backup\n')
    expect(JSON.parse(await readFile(documentPath(root), 'utf8'))).toMatchObject({ schemaVersion: 7, revision: 1 })
  })

  it('discovers only configured atoms, keeps IDs on source edits and reopen, and reads real prop types', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const first = await engine.inspectFixture()
    expect(first.atoms.map(atom => atom.exportName).sort()).toEqual(['Button', 'Card', 'Input', 'Label'])
    expect(first.atoms.find(atom => atom.name === 'Button')?.props.find(prop => prop.name === 'variant')?.type).toContain('"quiet"')
    const labelId = first.atoms.find(atom => atom.name === 'Label')!.componentId
    await writeFile(path.join(root, 'src/atoms/Label.tsx'), changedLabel)
    const reopened = await createValidatedEngine(root)
    const second = await reopened.inspectFixture()
    expect(second.atoms.find(atom => atom.name === 'Label')!.componentId).toBe(labelId)
    expect(second.atoms.find(atom => atom.name === 'Label')!.sourceHash).not.toBe(first.atoms.find(atom => atom.name === 'Label')!.sourceHash)
    expect(labelId).not.toBe(checksum(changedLabel))
    expect(second.atoms.some(atom => atom.name === 'PreviewLogin')).toBe(false)
  })

  it('AT-SRC-003 changes only the golden Label literal and requires exact approval', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const prepared = await engine.prepareLabelPadding('8px 12px')
    expect(prepared.files).toHaveLength(1)
    expect(prepared.files[0]?.path).toBe('src/atoms/Label.tsx')
    expect(prepared.files[0]?.after).toBe(changedLabel)
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(originalLabel)
    await expect(engine.savePrepared(prepared.id, 'not-the-approved-digest')).rejects.toThrow('Approval')
    prepared.files[0]!.after = 'malicious caller mutation'
    const saved = await engine.savePrepared(prepared.id, prepared.approvalDigest)
    expect(saved.status).toBe('saved')
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(changedLabel)
    await expect(engine.savePrepared(prepared.id, prepared.approvalDigest)).rejects.toThrow('Approval')
  })

  it('preserves CRLF and rejects computed padding rather than guessing', () => {
    expect(patchLabelPadding(originalLabel.replaceAll('\n', '\r\n'), 'Label', '8px 12px')).toBe(changedLabel.replaceAll('\n', '\r\n'))
    expect(() => patchLabelPadding(originalLabel.replace("'4px 0'", 'getPadding()'), 'Label', '8px')).toThrow('Computed')
    expect(() => patchLabelPadding(originalLabel, 'Missing', '8px')).toThrow('provenance')
  })

  it('AT-SRC-001 invalidates the reviewed patch after an external edit, including unrelated input files', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const prepared = await engine.prepareLabelPadding('8px 12px')
    await writeFile(path.join(root, 'src/atoms/Input.tsx'), (await readFile(path.join(root, 'src/atoms/Input.tsx'), 'utf8')) + '\n')
    const result = await engine.savePrepared(prepared.id, prepared.approvalDigest)
    expect(result.status).toBe('conflict')
    expect(result.snapshot.conflict?.paths).toEqual(['src/atoms/Input.tsx'])
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(originalLabel)
  })

  it('explicit refresh abandons stale approval and permits fresh review without replacing external bytes', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const prepared = await engine.prepareLabelPadding('8px 12px')
    const external = originalLabel.replace("'4px 0'", "'6px 0'")
    await writeFile(path.join(root, 'src/atoms/Label.tsx'), external)
    const conflict = await engine.savePrepared(prepared.id, prepared.approvalDigest)
    expect(conflict.status).toBe('conflict')
    expect(conflict.snapshot.conflict?.kind).toBe('external-change')
    const refreshed = await engine.refresh()
    expect(refreshed.conflict).toBeNull()
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(external)
    await expect(engine.savePrepared(prepared.id, prepared.approvalDigest)).rejects.toThrow('Approval')
    const fresh = await engine.prepareLabelPadding('8px 12px')
    expect(fresh.files[0]?.before).toBe(external)
    expect(fresh.files[0]?.after).toBe(changedLabel)
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(external)
  }, 60_000)

  it('refresh retains an unresolved rollback conflict', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root, { afterReplacement: () => { throw new Error('Injected save failure') } })
    const prepared = await engine.prepareLabelPadding('8px 12px')
    expect((await engine.savePrepared(prepared.id, prepared.approvalDigest)).status).toBe('rolled-back')
    const refreshed = await engine.refresh()
    expect(refreshed.conflict?.kind).toBe('rollback')
    await expect(engine.prepareLabelPadding('8px')).rejects.toThrow('Original source was restored')
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(originalLabel)
  }, 60_000)

  it('AT-SRC-004 changes exactly the canonical CSS value', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const before = await readFile(path.join(root, 'src/globals.css'), 'utf8')
    const prepared = await engine.prepareToken('#112233')
    expect(prepared.scope).toBe('Token')
    expect(prepared.files[0]?.after).toBe(before.replace('--accent: #685fff;', '--accent: #112233;'))
    const saved = await engine.savePrepared(prepared.id, prepared.approvalDigest)
    expect(saved.status).toBe('saved')
    expect(saved.snapshot.tokens.find(token => token.name === '--accent')?.value).toBe('#112233')
    await expect(engine.prepareToken('var(--dynamic)')).rejects.toThrow('six-digit')
  })

  it('AT-P0-001 promotes real source, preserves behavior and child IDs, and rebinds the composition', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const initial = await engine.inspectFixture()
    const preview = await readFile(path.join(root, 'src/PreviewLogin.tsx'), 'utf8')
    const prepared = await engine.preparePromotion('LoginForm')
    expect(prepared.files.map(file => file.path)).toEqual(['src/components/LoginForm.tsx', 'src/components/index.ts'])
    expect(prepared.files[0]?.after).toBe(preview.replace("from './atoms'", "from '../atoms'").replace('function PreviewLogin()', 'function LoginForm()'))
    expect(prepared.files[1]?.after).toMatch(/export \{ LoginForm \} from '\.\/LoginForm'/)
    const result = await engine.savePrepared(prepared.id, prepared.approvalDigest)
    expect(result.status).toBe('saved')
    expect(result.snapshot.composition.children).toEqual(initial.composition.children)
    expect(result.snapshot.composition.componentId).toBe(result.snapshot.atoms.find(atom => atom.name === 'LoginForm')!.componentId)
    expect(await readFile(path.join(root, 'src/components/LoginForm.tsx'), 'utf8')).toContain('createPortal')
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(originalLabel)
    await expect(engine.preparePromotion('LoginForm')).rejects.toThrow('already exists')
  })

  it('AT-P0-001 promotes an edited design file from its first page and refuses drawn primitives', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const initial = await engine.inspectFixture()
    const button = initial.composition.children.find(child => child.exportName === 'Button')!
    const unchanged = await engine.saveFile(initial.file, 0)
    expect((await engine.preparePromotion('SameLogin')).files[0]?.after).toContain('createPortal')
    const file = structuredClone(unchanged.file)
    componentNode(file, button.id).props.children = 'Continue'
    const edited = await engine.saveFile(file, 1)
    const prepared = await engine.preparePromotion('EditedLogin')
    expect(prepared.files.map(change => change.path)).toEqual(['src/components/EditedLogin.tsx', 'src/components/index.ts'])
    const source = prepared.files[0]!.after!
    expect(source).toContain('export function EditedLogin()')
    expect(source).toContain("import { Button } from '../atoms/Button'")
    expect(source).toContain('Continue')
    expect(source).not.toContain('Sign in')
    expect(source).not.toContain('createPortal')
    const result = await engine.savePrepared(prepared.id, prepared.approvalDigest)
    expect(result.status).toBe('saved')
    expect(await readFile(path.join(root, 'src/components/EditedLogin.tsx'), 'utf8')).toBe(source)
    expect(result.snapshot.composition.componentId).toBe(result.snapshot.atoms.find(atom => atom.exportName === 'EditedLogin')!.componentId)
    const framed = structuredClone(edited.file)
    const rootId = framed.pages[0]!.rootNodeId
    const [orderKey] = appendOrderKeys(framed, rootId, 1)
    framed.nodes['drawn-frame'] = { id: 'drawn-frame', type: 'frame', name: 'Frame 1', styles: { left: 0, top: 0, width: 100, height: 100, overflow: 'clip' } }
    framed.relationships['drawn-frame'] = { parentId: rootId, orderKey: orderKey! }
    await engine.saveFile(framed, 2)
    await expect(engine.preparePromotion('FramedLogin')).rejects.toThrow('Canvas layout')
    await expect(readFile(path.join(root, 'src/components/FramedLogin.tsx'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('AT-SRC-002 rolls back every file after a real failure between replacements', async () => {
    const root = await fixture()
    const before = await readFile(path.join(root, 'src/components/index.ts'), 'utf8')
    const engine = await createValidatedEngine(root, { afterReplacement: index => { if (index === 1) throw new Error('Injected disk failure') } })
    const prepared = await engine.preparePromotion('LoginForm')
    const result = await engine.savePrepared(prepared.id, prepared.approvalDigest)
    expect(result.status).toBe('rolled-back')
    await expect(readFile(path.join(root, 'src/components/LoginForm.tsx'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(checksum(await readFile(path.join(root, 'src/components/index.ts'), 'utf8'))).toBe(checksum(before))
    const journal = JSON.parse(await readFile(path.join(root, '.design-editor/transaction.json'), 'utf8'))
    expect(journal.status).toBe('rolled-back')
    await writeFile(path.join(root, 'src/components/index.ts'), 'export { Corrupted }\n')
    const deliberatelyBrokenRollback = await readFile(path.join(root, 'src/components/index.ts'), 'utf8')
    expect(() => assert.equal(deliberatelyBrokenRollback, before)).toThrow()
  })

  it('does not overwrite concurrent external content during rollback', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root, { afterReplacement: async () => {
      await writeFile(path.join(root, 'src/atoms/Label.tsx'), changedLabel + '\n')
      throw new Error('External change and disk failure')
    } })
    const prepared = await engine.prepareLabelPadding('8px 12px')
    const result = await engine.savePrepared(prepared.id, prepared.approvalDigest)
    expect(result.status).toBe('rolled-back')
    expect(result.message).toContain('manual recovery')
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(changedLabel + '\n')
    expect(JSON.parse(await readFile(path.join(root, '.design-editor/transaction.json'), 'utf8')).status).toBe('recovery-required')
  })

  it('AT-SRC-006 prepares checked reverse bytes and refuses undo over external edits', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const prepared = await engine.prepareLabelPadding('8px 12px')
    await engine.savePrepared(prepared.id, prepared.approvalDigest)
    const reverse = await engine.prepareUndo(prepared.id)
    expect(reverse.files[0]?.after).toBe(originalLabel)
    await writeFile(path.join(root, 'src/atoms/Label.tsx'), changedLabel + '\n')
    await expect(engine.prepareUndo(prepared.id)).rejects.toThrow('Source changed after Save')
    expect((await engine.savePrepared(reverse.id, reverse.approvalDigest)).status).toBe('conflict')
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toBe(changedLabel + '\n')
  })

  it('AT-ID-002 requires reviewed move and rename evidence and preserves the opaque ID', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const first = await engine.inspectFixture()
    const id = first.atoms.find(atom => atom.name === 'Label')!.componentId
    await engine.saveFile(first.file, 0)
    await rename(path.join(root, 'src/atoms/Label.tsx'), path.join(root, 'src/atoms/Caption.tsx'))
    await writeFile(path.join(root, 'src/atoms/Caption.tsx'), originalLabel.replace('function Label(', 'function Caption('))
    const barrel = await readFile(path.join(root, 'src/atoms/index.ts'), 'utf8')
    await writeFile(path.join(root, 'src/atoms/index.ts'), barrel.replace("{ Label } from './Label'", "{ Caption } from './Caption'"))
    const uncertain = await engine.refresh()
    expect(uncertain.atoms.find(atom => atom.componentId === id)?.status).toBe('ambiguous')
    const confirmed = await engine.confirmIdentity(id, 'src/atoms/Caption.tsx#Caption')
    expect(confirmed.atoms.find(atom => atom.componentId === id)).toMatchObject({ exportName: 'Caption', path: 'src/atoms/Caption.tsx', status: 'bound' })
    const renamed = Object.values(confirmed.file.nodes).filter(node => node.type === 'component' && node.componentId === id)
    expect(renamed.map(node => node.type === 'component' && node.exportName)).toEqual(['Caption', 'Caption'])
    const stored = JSON.parse(await readFile(documentPath(root), 'utf8'))
    expect(stored.revision).toBe(2)
    expect(Object.values(stored.nodes as Record<string, { componentId?: string; exportName?: string }>).filter(node => node.componentId === id).map(node => node.exportName)).toEqual(['Caption', 'Caption'])
  })

  it('AT-ID-003 retains deleted identities and blocks ambiguous replacements', async () => {
    const root = await fixture()
    const engine = await createValidatedEngine(root)
    const initial = await engine.inspectFixture()
    const id = initial.atoms.find(atom => atom.name === 'Label')!.componentId
    await unlink(path.join(root, 'src/atoms/Label.tsx'))
    expect((await engine.refresh()).atoms.find(atom => atom.componentId === id)?.status).toBe('missing')
    await writeFile(path.join(root, 'src/atoms/Caption.tsx'), originalLabel.replace('function Label(', 'function Caption('))
    await writeFile(path.join(root, 'src/atoms/Legend.tsx'), originalLabel.replace('function Label(', 'function Legend('))
    await writeFile(path.join(root, 'src/atoms/index.ts'), "export { Caption } from './Caption'\nexport { Legend } from './Legend'\n")
    const result = await engine.refresh()
    expect(result.atoms.find(atom => atom.componentId === id)).toMatchObject({ status: 'ambiguous', candidates: ['src/atoms/Caption.tsx#Caption', 'src/atoms/Legend.tsx#Legend'] })
    await expect(engine.prepareLabelPadding('8px')).rejects.toThrow('identity')
  })

  it('rejects a canonical source directory junction outside the project grant', async () => {
    const root = await fixture()
    const outside = await mkdtemp(path.join(tmpdir(), 'design-editor-outside-'))
    temporary.push(outside)
    await writeFile(path.join(outside, 'globals.css'), ':root { --accent: #ffffff; }')
    await rename(path.join(root, 'src'), path.join(root, 'src-original'))
    await symlink(outside, path.join(root, 'src'), 'junction')
    const engine = await createRepoEngine(root)
    await expect(engine.prepareToken('#112233')).rejects.toThrow('Symbolic')
    expect(await readFile(path.join(outside, 'globals.css'), 'utf8')).toBe(':root { --accent: #ffffff; }')
  })
})
