import { describe, expect, it } from 'vitest'
import { checkRuntimeGraph, readRuntimeSources } from '../scripts/check-runtime-boundaries.mjs'

const entry = 'packages/editor/src/Feature.tsx'
const check = (source: string) => checkRuntimeGraph({ [entry]: source })

describe('AT-CODE-003 browser runtime import graph', () => {
  it('keeps authored shared editor, web and desktop browser graphs away from privileged modules', async () => {
    const sources = await readRuntimeSources()
    expect(sources.has('packages/editor/src/features/editor/document-store.ts')).toBe(true)
    expect(sources.has('apps/web/src/router.tsx')).toBe(true)
    expect(checkRuntimeGraph(sources)).toEqual([])
  })

  it.each([
    ["import { readFile } from 'node:fs/promises'", 'Node built-in'],
    ["import fs from 'fs'", 'Node built-in'],
    ["export { readFile } from 'fs/promises'", 'Node built-in'],
    ["import type { IpcRenderer } from 'electron'", 'Electron import'],
    ["type Stats = import('node:fs').Stats", 'Node built-in'],
    ["import type { Atom } from '@canvas/repo-engine'", 'contract subpath'],
    ["export * from '@canvas/preview-runtime'", 'browser-safe preview-runtime'],
    ["export * from '@canvas/repo-engine/dist/index'", 'contract subpath'],
    ["import db from 'pg'", 'database or auth'],
    ["import { betterAuth } from 'better-auth'", 'database or auth'],
    ["import 'server-only'", 'Server-only module'],
  ])('rejects privileged static and type-only edge %s', (source, reason) => {
    expect(check(source).join('\n')).toContain(reason)
    expect(check("export const value = 'local browser state'")).toEqual([])
  })

  it.each([
    "const fs = await import('node:fs')",
    "const name = 'node:' + 'fs'; const fs = import(name)",
    "const name = 'fs'; const fs = import(`node:${name}`)",
    "const read = require; const fs = read('node:fs')",
    "const second = first; const first = require; second('fs/promises')",
    "const { require: load } = module; load('node:fs')",
    "const load = module.require.bind(module); load('fs')",
    "require.call(null, 'node:fs')",
    "require.apply(null, ['node:fs'])",
    "const read = globalThis['require']; read('node:fs')",
    "import fs = require('node:fs')",
  ])('rejects dynamic or aliased loader %s', source => {
    expect(check(source).join('\n')).toContain('Node built-in')
  })

  it('fails closed for unknown, mutated and shadowed dynamic import targets', () => {
    expect(check('const module = import(runtimePath)').join('\n')).toContain('Nonliteral dynamic import')
    expect(check("let target = 'react'; target = 'node:fs'; import(target)").join('\n')).toContain('Nonliteral dynamic import')
    expect(check("const target = 'react'; function load(target: string) { return import(target) }").join('\n')).toContain('Nonliteral dynamic import')
    expect(check("const target = 'react'; import(target)")).toEqual([])
    expect(check("const pages = import.meta.glob('./**/*.ts')").join('\n')).toContain('Nonliteral glob import')
  })

  it('traverses multiple re-export barrels into a server module', () => {
    const sources = {
      [entry]: "import { secret } from './barrel'",
      'packages/editor/src/barrel.ts': "export { secret } from '../../shared/src/index.js'",
      'packages/shared/src/index.ts': "export * from './credentials.server.js'",
      'packages/shared/src/credentials.server.ts': "export const secret = 'server owned'",
    }
    const diagnostic = checkRuntimeGraph(sources).join('\n')
    expect(diagnostic).toContain('Server-only module')
    expect(diagnostic).toContain('packages/shared/src/index.ts')
    expect(diagnostic).toContain('credentials.server.js')
    const safe = { ...sources, 'packages/shared/src/index.ts': "export const secret = 'public display value'" }
    expect(checkRuntimeGraph(safe)).toEqual([])
  })

  it('recognizes server and desktop boundaries after an alias resolver hides their names', () => {
    const sources = { [entry]: "import { api } from '@runtime/adapter'", 'apps/desktop/src/preload/contracts.ts': 'export type api = string', 'packages/shared/src/server/access.ts': 'export const api = true' }
    expect(checkRuntimeGraph(sources, { resolve: () => 'apps/desktop/src/preload/contracts.ts' }).join('\n')).toContain('Privileged desktop')
    expect(checkRuntimeGraph(sources, { resolve: () => 'packages/shared/src/server/access.ts' }).join('\n')).toContain('Server-only module reached')
  })

  it('resolves configured TypeScript aliases and reports an unresolved alias target', () => {
    const sources = {
      [entry]: "import { value } from '@data/access'",
      'tsconfig.base.json': '{"compilerOptions":{"baseUrl":".","paths":{"@data/*":["packages/shared/src/*"]}}}',
      'packages/shared/src/access.ts': "export { value } from './server/database'",
      'packages/shared/src/server/database.ts': 'export const value = 1',
    }
    expect(checkRuntimeGraph(sources).join('\n')).toContain('Server-only module')
    expect(checkRuntimeGraph({ ...sources, [entry]: "import { value } from '@data/missing'" }).join('\n')).toContain('Unresolved browser entry')
  })

  it('traverses allowed pure contract subpaths and rejects contamination behind their safe name', () => {
    const sources = {
      [entry]: "import type { Atom } from '@canvas/repo-engine/contracts'; import { run } from '@canvas/repo-engine/document'; import type { Event } from '@canvas/preview-runtime/browser-contracts'; import { protocol } from '@canvas/preview-runtime/protocol'; import { mount } from '@canvas/preview-runtime/browser'",
      'packages/repo-engine/src/contracts.ts': "export type { Atom } from './types.js'",
      'packages/repo-engine/src/types.ts': 'export type Atom = { id: string }',
      'packages/repo-engine/src/document.ts': "import type { Atom } from './types.js'; export const run = (atom: Atom) => atom.id",
      'packages/preview-runtime/src/browser-contracts.ts': 'export type Event = { ready: boolean }',
      'packages/preview-runtime/src/protocol.ts': 'export const protocol = 1',
      'packages/preview-runtime/src/browser-runtime.mjs': "import { protocol } from './protocol.js'; export const mount = () => protocol",
    }
    expect(checkRuntimeGraph(sources)).toEqual([])
    expect(checkRuntimeGraph({ ...sources, 'packages/repo-engine/src/types.ts': "export type { Stats as Atom } from 'node:fs'" }).join('\n')).toContain('Node built-in')
  })

  it('resolves workspace export barrels and handles cyclic pure modules', () => {
    const sources = {
      [entry]: "export { value } from '@canvas/shared'",
      'packages/shared/package.json': '{"name":"@canvas/shared","exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.js"}}}',
      'packages/shared/src/index.ts': "export { value } from './value.js'",
      'packages/shared/src/value.ts': "import type { Value } from './index.js'; export const value = 1",
    }
    expect(checkRuntimeGraph(sources)).toEqual([])
    expect(checkRuntimeGraph({ ...sources, 'packages/shared/src/value.ts': "export { value } from './data.server.js'", 'packages/shared/src/data.server.ts': 'export const value = 1' }).join('\n')).toContain('Server-only module')
  })

  it('excludes test modules as runtime roots but rejects production imports of tests', () => {
    const sources = { [entry]: 'export const value = 1', 'packages/editor/src/Feature.test.ts': "import { readFile } from 'node:fs'" }
    expect(checkRuntimeGraph(sources)).toEqual([])
    expect(checkRuntimeGraph({ ...sources, [entry]: "import './Feature.test'" }).join('\n')).toContain('test-only code')
  })

  it('checks trusted fixture runtime source reached from the separate preview origin', () => {
    const sources = { 'apps/web/preview/main.ts': "import { Button } from '../../../tests/fixtures/component-repo-seed/src/Button'", 'tests/fixtures/component-repo-seed/src/Button.tsx': 'export const Button = () => <button />' }
    expect(checkRuntimeGraph(sources)).toEqual([])
    expect(checkRuntimeGraph({ ...sources, 'tests/fixtures/component-repo-seed/src/Button.tsx': "import 'node:fs'; export const Button = () => <button />" }).join('\n')).toContain('Node built-in')
  })

  it('does not assume a Start server-function call makes module imports server-only', () => {
    const source = "import { createServerFn } from '@tanstack/react-start'; import { db } from './server/db'; export const query = createServerFn().handler(() => db.read())"
    expect(check(source).join('\n')).toContain('Server-only module')
    expect(check("import { createServerFn } from '@tanstack/react-start'; export const query = createServerFn().handler(() => 'public')")).toEqual([])
  })

  it('allows only the generated TanStack route-tree edge to the hosted auth handler', () => {
    const serverRoute = 'apps/web/src/routes/api.auth.$.ts'
    const sources = {
      'apps/web/src/routeTree.gen.ts': "import { Route } from './routes/api.auth.$'; export const routeTree = Route",
      [serverRoute]: "import database from 'pg'; export const Route = database",
    }
    expect(checkRuntimeGraph(sources, { entries: ['apps/web/src/routeTree.gen.ts'] })).toEqual([])
    expect(checkRuntimeGraph({ ...sources, [entry]: "import { Route } from '../../../apps/web/src/routes/api.auth.$'; export const leaked = Route" }, { entries: [entry] }).join('\n')).toContain('Server-only module reached')
  })
})
