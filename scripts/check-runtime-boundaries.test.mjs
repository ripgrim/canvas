import assert from 'node:assert/strict'
import test from 'node:test'

import { checkRuntimeGraph } from './check-runtime-boundaries.mjs'

test('resolves build-time declaration aliases back to browser source', () => {
  const sources = new Map([
    ['packages/editor/src/demo.ts', "import { value } from '@canvas/example/value'; export { value }"],
    ['packages/example/package.json', JSON.stringify({ name: '@canvas/example' })],
    ['packages/example/tsconfig.build.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@canvas/example/value': ['./dist/value.d.ts'] } } })],
    ['packages/example/src/value.ts', 'export const value = 1'],
  ])

  assert.deepEqual(checkRuntimeGraph(sources), [])
})

test('allows the explicit Paper sizing contract but still rejects an unknown repo-engine subpath', () => {
  const allowed = new Map([
    ['packages/editor/src/demo.ts', "import { snapshotPaperSizing } from '@canvas/repo-engine/paper-sizing'; export { snapshotPaperSizing }"],
    ['packages/repo-engine/src/paper-sizing.ts', "import { valid } from './layout.js'; export const snapshotPaperSizing = valid"],
    ['packages/repo-engine/src/layout.ts', 'export const valid = true'],
  ])
  const rejected = new Map([
    ['packages/editor/src/demo.ts', "import { unsafe } from '@canvas/repo-engine/not-a-contract'; export { unsafe }"],
  ])

  assert.deepEqual(checkRuntimeGraph(allowed), [])
  assert.deepEqual(checkRuntimeGraph(rejected), [
    'packages/editor/src/demo.ts:1: Use a browser-safe repo-engine contract subpath: @canvas/repo-engine/not-a-contract',
  ])
})

test('traverses the Paper sizing source mapping and rejects a forbidden transitive runtime import', () => {
  const sources = new Map([
    ['packages/editor/src/demo.ts', "import { snapshotPaperSizing } from '@canvas/repo-engine/paper-sizing'; export { snapshotPaperSizing }"],
    ['packages/repo-engine/src/paper-sizing.ts', "import { readFileSync } from 'node:fs'; export const snapshotPaperSizing = readFileSync"],
  ])

  assert.deepEqual(checkRuntimeGraph(sources), [
    'packages/repo-engine/src/paper-sizing.ts:1: Node built-in import is forbidden in browser code: node:fs',
  ])
})
