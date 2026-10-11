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
