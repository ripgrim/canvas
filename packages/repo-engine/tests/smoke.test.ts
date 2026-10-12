import { cp, lstat, mkdtemp, readFile, realpath, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createRepoEngine } from '../src/index'
import { validatePreviewFiles } from '../../preview-runtime/src/index'

const fixture = fileURLToPath(new URL('../../../tests/fixtures/component-repo-seed/', import.meta.url))
const fixtureDependencies = fileURLToPath(new URL('../../../fixtures/component-repo/node_modules/', import.meta.url))
const fixtureLockfile = fileURLToPath(new URL('../../../fixtures/component-repo/pnpm-lock.yaml', import.meta.url))

async function removeFixture(root: string) {
  const canonical = await realpath(root)
  const relative = path.relative(await realpath(tmpdir()), canonical)
  if (await lstat(root).then(stat => stat.isSymbolicLink()) || !relative || path.isAbsolute(relative) || relative.includes(path.sep) || !/^design-editor-(?:review-smoke|missing-validator)-[A-Za-z0-9]+$/.test(relative)) throw new Error('Refusing to remove an unexpected temporary fixture path')
  const dependencyLink = path.join(canonical, 'node_modules')
  const stat = await lstat(dependencyLink).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (stat?.isSymbolicLink()) await unlink(dependencyLink)
  await rm(canonical, { recursive: true, force: true })
}

it('independent API smoke: inspect then prepare, without saving source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'design-editor-review-smoke-'))
  try {
    await cp(path.join(fixture, 'src'), path.join(root, 'src'), { recursive: true })
    await cp(path.join(fixture, 'package.json'), path.join(root, 'package.json'))
    await cp(fixtureLockfile, path.join(root, 'pnpm-lock.yaml'))
    await symlink(fixtureDependencies, path.join(root, 'node_modules'), 'junction')
    const engine = await createRepoEngine(root, {
      validatePreview: input => validatePreviewFiles({ repositoryRoot: input.root, editorOrigin: 'design-editor://app', executionTrust: 'fixture-only' }, { ...input.binding, styles: ['src/globals.css'] }, input.files),
    })
    const before = await engine.inspectFixture()
    const prepared = await engine.prepareLabelPadding('12px 16px')
    const after = await engine.refresh()
    expect(before.atoms.map(atom => atom.name).sort()).toEqual(['Button', 'Card', 'Input', 'Label'])
    expect(prepared.scope).toBe('Shared component')
    expect(prepared.files.map(file => file.path)).toEqual(['src/atoms/Label.tsx'])
    expect(prepared.validation.map(check => [check.name, check.status])).toEqual([['Parse', 'passed'], ['Types', 'passed'], ['Preview build', 'passed']])
    expect(after.sourceHashes).toEqual(before.sourceHashes)
    expect(before.file).toMatchObject({ schemaVersion: 9, fileId: before.projectId, revision: 0 })
    expect(before.file.pages).toHaveLength(1)
    expect(after.file).toEqual(before.file)
    expect(before).not.toHaveProperty('previewTheme')
    await expect(readFile(path.join(root, '.design-editor/document.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toContain("padding: '4px 0'")
  } finally {
    await removeFixture(root)
  }
}, 60_000)

it('blocks Save when no real preview validation is available', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'design-editor-missing-validator-'))
  try {
    await cp(path.join(fixture, 'src'), path.join(root, 'src'), { recursive: true })
    await symlink(fixtureDependencies, path.join(root, 'node_modules'), 'junction')
    const engine = await createRepoEngine(root)
    const prepared = await engine.prepareLabelPadding('12px 16px')
    expect(prepared.validation.find(check => check.name === 'Preview build')?.status).toBe('not-run')
    await expect(engine.savePrepared(prepared.id, prepared.approvalDigest)).rejects.toThrow('Complete preview build validation')
    expect(await readFile(path.join(root, 'src/atoms/Label.tsx'), 'utf8')).toContain("padding: '4px 0'")
  } finally {
    await removeFixture(root)
  }
})
