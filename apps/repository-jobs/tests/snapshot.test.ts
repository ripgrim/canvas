import { gzipSync } from 'node:zlib'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGitHubRepositorySnapshotPort, createHostedRepositoryScanner } from '../src/index.js'

const token = 'github-installation-token'
const revision = 'a'.repeat(40)
const archiveUrl = `https://codeload.github.com/canvas/editor/legacy.tar.gz/${revision}`
const temporary: string[] = []

type TarEntry = Readonly<{ path: string; source?: string; type?: '0' | '1' | '2' | '3' | '5'; link?: string; mode?: number }>

const fixture = (marker: string): TarEntry[] => [
  { path: 'canvas-editor/', type: '5' },
  { path: 'canvas-editor/components.json', source: JSON.stringify({ aliases: { ui: '@/components/ui' }, tailwind: { css: 'src/globals.css', cssVariables: true } }) },
  { path: 'canvas-editor/package.json', source: JSON.stringify({ name: 'hosted-fixture', private: true, scripts: { postinstall: executionScript(marker) } }) },
  { path: 'canvas-editor/tsconfig.json', source: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }) },
  { path: 'canvas-editor/src/components/ui/button.tsx', source: `type ButtonProps = { children?: unknown; variant?: 'default' | 'quiet' }\nexport function Button({ children }: ButtonProps) { return <button>{children}</button> }\n` },
  { path: 'canvas-editor/src/globals.css', source: ':root { --background: oklch(1 0 0); }\n.dark { --background: oklch(0.2 0 0); }\n' },
]

function repositoryFetch(entries: readonly TarEntry[], overrides: Readonly<{ repository?: unknown; redirect?: string; commit?: unknown; jsonBody?: string; archiveContentLength?: number }> = {}) {
  const archive = tar(entries)
  const requests: { url: string; authorization: string | null }[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, authorization: new Headers(init?.headers).get('Authorization') })
    if (url === 'https://api.github.com/repositories/42') {
      const body = overrides.jsonBody ?? JSON.stringify(overrides.repository ?? { id: 42, default_branch: 'main', full_name: 'canvas/editor' })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } })
    }
    if (url === 'https://api.github.com/repositories/42/commits/main') return json(overrides.commit ?? { sha: revision })
    if (url === `https://api.github.com/repositories/42/tarball/${revision}`) return new Response(null, { status: 302, headers: { Location: overrides.redirect ?? archiveUrl } })
    if (url === archiveUrl) return new Response(Buffer.from(archive), { status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(overrides.archiveContentLength ?? archive.byteLength) } })
    return json({ message: 'Not found' }, 404)
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

describe('hosted repository snapshot scanner', () => {
  it('[AT-P0-002][AT-REPO-SCAN-001] scans an immutable archive without executing repository scripts', async () => {
    const markerRoot = await mkdtemp(path.join(tmpdir(), 'canvas-repository-marker-'))
    temporary.push(markerRoot)
    const marker = path.join(markerRoot, 'executed')
    const github = repositoryFetch(fixture(marker))
    let ownedRoot = ''
    const createTemporaryRoot = async () => {
      ownedRoot = await mkdtemp(path.join(tmpdir(), 'canvas-repository-success-'))
      return ownedRoot
    }
    const scanner = createHostedRepositoryScanner(createGitHubRepositorySnapshotPort({ fetch: github.fetch, createTemporaryRoot }))

    const result = await scanner.scan({ repositoryId: '42', accessToken: token })

    expect(result.sourceRevision).toBe(revision)
    expect(result.scan.components.map(component => component.exportName)).toEqual(['Button'])
    expect(result.request.components).toEqual([expect.objectContaining({ exportName: 'Button', props: { variant: { kind: 'enum', values: ['default', 'quiet'], optional: true } }, slots: ['children'] })])
    await expect(access(marker)).rejects.toThrow()
    await expect(access(ownedRoot)).rejects.toThrow()
    expect(github.requests.filter(request => request.url.startsWith('https://api.github.com/')).every(request => request.authorization === `Bearer ${token}`)).toBe(true)
    expect(github.requests.find(request => request.url === archiveUrl)?.authorization).toBeNull()
    expect(github.requests.every(request => !request.url.includes(token))).toBe(true)
  })

  it('[AT-REPO-SCAN-001] rejects redirects outside the exact codeload repository', async () => {
    const github = repositoryFetch([], { redirect: `https://attacker.example/canvas/editor/${revision}` })

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('invalid repository archive redirect')
    expect(github.requests).toHaveLength(3)
  })

  it('[AT-REPO-SCAN-001] rejects a codeload redirect for another revision', async () => {
    const github = repositoryFetch([], { redirect: `https://codeload.github.com/canvas/editor/legacy.tar.gz/${'b'.repeat(40)}` })

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('invalid repository archive redirect')
    expect(github.requests).toHaveLength(3)
  })

  it('[AT-REPO-SCAN-001] rejects repository identity mismatch', async () => {
    const github = repositoryFetch([], { repository: { id: 99, default_branch: 'main', full_name: 'canvas/editor' } })

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('another repository')
    expect(github.requests).toHaveLength(1)
  })

  it('[AT-REPO-SCAN-001] rejects oversized JSON before parsing', async () => {
    const github = repositoryFetch([], { jsonBody: ' '.repeat(1024 * 1024 + 1) })

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('exceeds the supported size')
    expect(github.requests).toHaveLength(1)
  })

  it('[AT-REPO-SCAN-001] rejects symlinks and removes the owned snapshot', async () => {
    const github = repositoryFetch([
      { path: 'canvas-editor/', type: '5' },
      { path: 'canvas-editor/link.ts', type: '2', link: '../secret' },
    ])
    let ownedRoot = ''
    const createTemporaryRoot = async () => {
      ownedRoot = await mkdtemp(path.join(tmpdir(), 'canvas-repository-owned-'))
      return ownedRoot
    }

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch, createTemporaryRoot }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('unsupported source entry')
    await expect(access(ownedRoot)).rejects.toThrow()
  })

  it('[AT-REPO-SCAN-001] rejects traversal paths before extraction', async () => {
    const github = repositoryFetch([
      { path: 'canvas-editor/', type: '5' },
      { path: 'canvas-editor/../../escape.ts', source: 'bad' },
    ])

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('invalid source path')
  })

  it.each([
    ['hardlink', '1' as const],
    ['symlink', '2' as const],
    ['device', '3' as const],
  ])('[AT-REPO-SCAN-001] rejects unsupported %s entries', async (_label, type) => {
    const unsafe = type === '1' || type === '2' ? { path: 'canvas-editor/unsafe', type, link: 'target' } : { path: 'canvas-editor/unsafe', type }
    const github = repositoryFetch([{ path: 'canvas-editor/', type: '5' }, unsafe])

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('unsupported source entry')
  })

  it('[AT-REPO-SCAN-001] rejects case-folded duplicate paths', async () => {
    const github = repositoryFetch([{ path: 'canvas-editor/', type: '5' }, { path: 'canvas-editor/Button.ts', source: 'a' }, { path: 'canvas-editor/button.ts', source: 'b' }])

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('duplicate source paths')
  })

  it('[AT-REPO-SCAN-001] rejects oversized regular files', async () => {
    const github = repositoryFetch([{ path: 'canvas-editor/', type: '5' }, { path: 'canvas-editor/large.ts', source: 'x'.repeat(2 * 1024 * 1024 + 1) }])

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('oversized source file')
  })

  it('[AT-REPO-SCAN-001] rejects unsupported source modes', async () => {
    const github = repositoryFetch([{ path: 'canvas-editor/', type: '5' }, { path: 'canvas-editor/script.ts', source: 'x', mode: 0o4755 }])

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('unsupported source mode')
  })

  it('[AT-REPO-SCAN-001] rejects oversized compressed responses before reading', async () => {
    const github = repositoryFetch([], { archiveContentLength: 50 * 1024 * 1024 + 1 })

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('exceeds the supported size')
  })

  it('[AT-REPO-SCAN-001] rejects oversized expanded archives', async () => {
    const github = repositoryFetch([{ path: 'canvas-editor/', type: '5' }, { path: 'canvas-editor/bomb', source: 'x'.repeat(64 * 1024 * 1024 + 1) }])

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('expanded size')
  })

  it('[AT-REPO-SCAN-001] rejects too many archive entries', async () => {
    const entries: TarEntry[] = [{ path: 'canvas-editor/', type: '5' }]
    for (let index = 0; index < 10_000; index += 1) entries.push({ path: `canvas-editor/d${index}/`, type: '5' })
    const github = repositoryFetch(entries)

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('entry limit')
  })

  it('[AT-REPO-SCAN-001] rejects too many source files', async () => {
    const entries: TarEntry[] = [{ path: 'canvas-editor/', type: '5' }]
    for (let index = 0; index < 5_001; index += 1) entries.push({ path: `canvas-editor/f${index}.ts`, source: '' })
    const github = repositoryFetch(entries)

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('source limits')
  })

  it('[AT-REPO-SCAN-001] rejects aggregate source bytes above the limit', async () => {
    const chunk = 'x'.repeat(2 * 1024 * 1024)
    const entries: TarEntry[] = [{ path: 'canvas-editor/', type: '5' }]
    for (let index = 0; index < 26; index += 1) entries.push({ path: `canvas-editor/f${index}.ts`, source: chunk })
    const github = repositoryFetch(entries)

    await expect(createGitHubRepositorySnapshotPort({ fetch: github.fetch }).open({ repositoryId: '42', accessToken: token })).rejects.toThrow('source limits')
  })
})

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function json(value: unknown, status = 200): Response {
  const body = JSON.stringify(value)
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } })
}

function executionScript(marker: string): string {
  const expression = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`
  return `node -e ${JSON.stringify(expression)}`
}

function tar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const source = Buffer.from(entry.source ?? '')
    const header = Buffer.alloc(512)
    writeText(header, 0, 100, entry.path)
    writeOctal(header, 100, 8, entry.mode ?? (entry.type === '5' ? 0o755 : 0o644))
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, source.byteLength)
    writeOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header.write(entry.type ?? '0', 156, 1, 'ascii')
    if (entry.link) writeText(header, 157, 100, entry.link)
    writeText(header, 257, 6, 'ustar\0')
    writeText(header, 263, 2, '00')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header)
    if (source.byteLength > 0) {
      blocks.push(source)
      const padding = (512 - source.byteLength % 512) % 512
      if (padding) blocks.push(Buffer.alloc(padding))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function writeText(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value)
  if (bytes.byteLength > length) throw new Error('Test tar value is too long.')
  bytes.copy(buffer, offset)
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}
