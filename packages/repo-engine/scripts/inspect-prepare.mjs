import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRepoEngine } from '../dist/index.js'
import { validatePreviewFiles } from '../../preview-runtime/dist/index.js'

const fixture = fileURLToPath(new URL('../../../fixtures/component-repo/', import.meta.url))
const root = await mkdtemp(path.join(tmpdir(), 'design-editor-native-smoke-'))
try {
  await cp(path.join(fixture, 'src'), path.join(root, 'src'), { recursive: true })
  await cp(path.join(fixture, 'package.json'), path.join(root, 'package.json'))
  await symlink(path.join(fixture, 'node_modules'), path.join(root, 'node_modules'), 'junction')
  const engine = await createRepoEngine(root, {
    validatePreview: input => validatePreviewFiles({ repositoryRoot: input.root, editorOrigin: 'design-editor://app', executionTrust: 'fixture-only' }, { ...input.binding, styles: ['src/globals.css'] }, input.files),
  })
  const before = await engine.inspectFixture()
  const prepared = await engine.prepareLabelPadding('12px 16px')
  const after = await engine.refresh()
  assert.deepEqual(before.atoms.map(atom => atom.name).sort(), ['Button', 'Card', 'Input', 'Label'])
  assert.deepEqual(after.sourceHashes, before.sourceHashes)
  assert.deepEqual(prepared.validation.map(check => check.status), ['passed', 'passed', 'passed'])
  console.info(JSON.stringify({ atoms: before.atoms.map(atom => atom.name), scope: prepared.scope, files: prepared.files.map(file => file.path), validation: prepared.validation, sourceUnchanged: true }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
