import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// LAY-LOCAL-001 baseline: a static check that the preview runtime browser modules and the editor feature modules
// carry no network or auth capability, and touch persistent browser storage only from the named storage modules.

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const scanned = [
  { directory: 'packages/preview-runtime/src', pattern: /\.mjs$/ },
  { directory: 'packages/editor/src/features/editor', pattern: /\.tsx?$/ },
]
// Test files are not shipped capability, so they are not scanned.
const excluded = /\.test\.tsx?$/

/** The only scanned files allowed to reach `localStorage`: the editor store default and the per-file view state. */
const storageAllowList = new Set([
  'packages/editor/src/features/editor/store.ts',
  'packages/editor/src/features/editor/view-state.ts',
])

const network: [string, RegExp][] = [
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\s*\(/],
  ['sendBeacon', /\bnavigator\s*\.\s*sendBeacon\b/],
  ['EventSource', /\bEventSource\s*\(/],
  ['dynamic import of a URL', /\bimport\s*\(\s*['"`](?:https?:|wss?:|\/\/)/],
  ['static import of a URL', /\bfrom\s*['"](?:https?:|wss?:|\/\/)/],
]
const storage: [string, RegExp][] = [
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
]

/** Every rule a source text breaks, as `rule` names. Storage rules are skipped for allow-listed paths. */
function violations(path: string, text: string): string[] {
  const found = network.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
  if (!storageAllowList.has(path)) found.push(...storage.filter(([, pattern]) => pattern.test(text)).map(([name]) => name))
  return found
}

async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const { directory, pattern } of scanned) {
    for (const entry of await readdir(join(repositoryRoot, directory), { withFileTypes: true })) {
      if (!entry.isFile() || !pattern.test(entry.name) || excluded.test(entry.name)) continue
      const path = `${directory}/${entry.name}`
      files.set(path, await readFile(join(repositoryRoot, path), 'utf8'))
    }
  }
  return files
}

describe('LAY-LOCAL-001 no network or auth capability in preview runtime and editor feature modules', () => {
  it('scans a real, non-empty set of files from both locations', async () => {
    const files = [...(await sources()).keys()]
    expect(files).toContain('packages/preview-runtime/src/browser-runtime.mjs')
    expect(files).toContain('packages/preview-runtime/src/appearance-layer.mjs')
    expect(files).toContain('packages/editor/src/features/editor/store.ts')
    expect(files).toContain('packages/editor/src/features/editor/Editor.tsx')
    expect(files.filter(path => path.endsWith('.test.ts'))).toEqual([])
  })

  it('finds no network primitive, URL import, or storage access outside the allow-list', async () => {
    const found = [...(await sources())].flatMap(([path, text]) => violations(path, text).map(rule => `${path}: ${rule}`))
    expect(found).toEqual([])
  })

  it('keeps every allow-listed storage module present and actually using storage, so the list cannot go stale', async () => {
    const files = await sources()
    for (const path of storageAllowList) {
      expect(files.has(path), path).toBe(true)
      expect(/\blocalStorage\b/.test(files.get(path)!), path).toBe(true)
    }
  })

  it('flags each forbidden pattern in a new file, as the negative control', () => {
    const path = 'packages/editor/src/features/editor/new-feature.ts'
    expect(violations(path, 'const response = await fetch(url)')).toEqual(['fetch'])
    expect(violations(path, 'const request = new XMLHttpRequest()')).toEqual(['XMLHttpRequest'])
    expect(violations(path, "const socket = new WebSocket('ws://127.0.0.1')")).toEqual(['WebSocket'])
    expect(violations(path, 'navigator.sendBeacon(url, body)')).toEqual(['sendBeacon'])
    expect(violations(path, "new EventSource('/events')")).toEqual(['EventSource'])
    expect(violations(path, "await import('https://cdn.example/module.js')")).toEqual(['dynamic import of a URL'])
    expect(violations(path, "import tracker from 'https://cdn.example/tracker.js'")).toEqual(['static import of a URL'])
    expect(violations(path, "window.localStorage.setItem('k', 'v')")).toEqual(['localStorage'])
    expect(violations(path, "sessionStorage.getItem('k')")).toEqual(['sessionStorage'])
    expect(violations(path, "indexedDB.open('db')")).toEqual(['indexedDB'])
    expect(violations('packages/editor/src/features/editor/store.ts', "window.localStorage.getItem('k')")).toEqual([])
    expect(violations('packages/editor/src/features/editor/store.ts', 'fetch(url)')).toEqual(['fetch'])
    expect(violations(path, "await import('./local-module')")).toEqual([])
    expect(violations(path, 'const prefetch = () => prefetchPage()')).toEqual([])
  })
})
