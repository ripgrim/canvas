import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, hostedContentSecurityPolicy, isTrustedSender, parseAuthRequest, parseRepositoryConnectionRequest, parseRepositoryRequest, secureWebPreferences } from '../src/main/policy'

describe('Electron policy', () => {
  it('requires the expected main frame, the editor origin (any route path), and the owning window', () => {
    const editorUrl = 'design-editor://app/'
    const valid = { webContentsId: 7, isMainFrame: true, url: editorUrl }
    expect(isTrustedSender(valid, 7, editorUrl)).toBe(true)
    // File routes keep the same origin after reload: design-editor://app/file/<id>?pageId=<id>
    expect(isTrustedSender({ ...valid, url: 'design-editor://app/file/01M38YBDDRJSMJ5M4VRYVV8E4Z?pageId=abc' }, 7, editorUrl)).toBe(true)
    expect(isTrustedSender({ ...valid, webContentsId: 8 }, 7, editorUrl)).toBe(false)
    expect(isTrustedSender({ ...valid, isMainFrame: false }, 7, editorUrl)).toBe(false)
    for (const url of ['design-editor://apps/', 'design-editor://app.evil/', 'file:///other/index.html', 'https://editor.example.test/file/x', 'about:blank']) expect(isTrustedSender({ ...valid, url }, 7, editorUrl)).toBe(false)
    const development = 'http://127.0.0.1:4317/'
    expect(isTrustedSender({ ...valid, url: 'http://127.0.0.1:4317/file/abc' }, 7, development)).toBe(true)
    expect(isTrustedSender({ ...valid, url: 'http://127.0.0.1:43170/' }, 7, development)).toBe(false)
    expect(isTrustedSender({ ...valid, url: 'http://localhost:4317/' }, 7, development)).toBe(false)
    // A grant that is not a directory URL can never match a nested path by accident.
    expect(isTrustedSender({ ...valid, url: 'file:///app/index.html' }, 7, 'file:///app/index.html')).toBe(false)
  })

  it('locks down window settings independently of Electron defaults', () => {
    expect(secureWebPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false })
    const policy = contentSecurityPolicy(false)
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("script-src 'self';")
    expect(policy).toContain("object-src 'none'")
    expect(policy).not.toContain('unsafe-eval')
    expect(policy).not.toContain('*')
    expect(policy).toContain("frame-src 'none'")
    expect(contentSecurityPolicy(false, 'http://127.0.0.1:48217')).toContain('frame-src http://127.0.0.1:48217;')
    expect(() => contentSecurityPolicy(false, 'http://127.0.0.1:48217; script-src *')).toThrow('Invalid preview origin.')
  })

  it('permits narrowly typed source operations', () => {
    expect(parseRepositoryRequest({ method: 'listFiles', args: [] })).toEqual({ method: 'listFiles', args: [] })
    expect(parseRepositoryRequest({ method: 'createFile', args: [] })).toEqual({ method: 'createFile', args: [] })
    expect(parseRepositoryRequest({ method: 'openFile', args: ['fixture-project'] })).toEqual({ method: 'openFile', args: ['fixture-project'] })
    expect(parseRepositoryRequest({ method: 'inspectFixture', args: [] })).toEqual({ method: 'inspectFixture', args: [] })
    expect(parseRepositoryRequest({ method: 'scanShadcn', args: [] })).toEqual({ method: 'scanShadcn', args: [] })
    expect(parseRepositoryRequest({ method: 'prepareLabelPadding', args: ['12px'] })).toEqual({ method: 'prepareLabelPadding', args: ['12px'] })
    expect(parseRepositoryRequest({ method: 'prepareToken', args: ['#ff00aa'] })).toEqual({ method: 'prepareToken', args: ['#ff00aa'] })
    expect(parseRepositoryRequest({ method: 'preparePromotion', args: ['LoginPanel'] })).toEqual({ method: 'preparePromotion', args: ['LoginPanel'] })
    expect(parseRepositoryRequest({ method: 'savePrepared', args: ['transaction-1', 'a'.repeat(64)] })).toEqual({ method: 'savePrepared', args: ['transaction-1', 'a'.repeat(64)] })
    expect(parseRepositoryRequest({ method: 'refresh', args: [] })).toEqual({ method: 'refresh', args: [] })
    expect(parseRepositoryRequest({ method: 'prepareUndo', args: ['transaction-1'] })).toEqual({ method: 'prepareUndo', args: ['transaction-1'] })
    expect(parseRepositoryRequest({ method: 'prepareRedo', args: ['transaction-2'] })).toEqual({ method: 'prepareRedo', args: ['transaction-2'] })
  })

  it('permits only bounded repository connection operations', () => {
    expect(parseRepositoryConnectionRequest({ method: 'pickLocal', args: [] })).toEqual({ method: 'pickLocal', args: [] })
    expect(parseRepositoryConnectionRequest({ method: 'getCurrent', args: [] })).toEqual({ method: 'getCurrent', args: [] })
    expect(parseRepositoryConnectionRequest({ method: 'scanCurrent', args: [] })).toEqual({ method: 'scanCurrent', args: [] })
    expect(parseRepositoryConnectionRequest({ method: 'cloneGitHub', args: [{ owner: 'shadcn-ui', name: 'ui' }] })).toEqual({ method: 'cloneGitHub', args: [{ owner: 'shadcn-ui', name: 'ui' }] })
    for (const input of [
      { method: 'pickLocal', args: ['C:\\private'] },
      { method: 'cloneGitHub', args: [{ owner: '../escape', name: 'repo' }] },
      { method: 'cloneGitHub', args: [{ owner: 'owner', name: 'repo', url: 'https://attacker.test' }] },
      { method: 'cloneGitHub', args: [{ owner: 'owner', name: 'repo;calc' }] },
      { method: 'cloneGitHub', args: [{ owner: 'owner', name: 'repo' }], root: 'C:\\private' },
    ]) expect(() => parseRepositoryConnectionRequest(input)).toThrow()
  })

  it('permits only renderer-safe auth commands without payloads', () => {
    for (const method of ['getSession', 'signInWithGitHub', 'signOut'] as const) expect(parseAuthRequest({ method, args: [] })).toEqual({ method, args: [] })
    for (const input of [
      { method: 'authenticate', args: ['token'] },
      { method: 'signInWithGitHub', args: ['https://attacker.test'] },
      { method: 'getCookie', args: [] },
      { method: 'getSession', args: [], extra: true },
    ]) expect(() => parseAuthRequest(input)).toThrow('Invalid auth command.')
  })

  it('allows only canonical SHA-256 script hashes in the production policy', () => {
    const emptyScriptHash = '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='
    const policy = contentSecurityPolicy(false, null, [emptyScriptHash])
    expect(policy).toContain("script-src 'self' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';")
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
    for (const invalid of ['sha256-' + emptyScriptHash, "'unsafe-inline'", emptyScriptHash + '; script-src *', 'a'.repeat(43) + '=', 'AAAA', 'a'.repeat(44)]) {
      expect(() => contentSecurityPolicy(false, null, [invalid])).toThrow('Invalid inline script hash.')
    }
  })

  it('keeps hosted scripts, styles, and frames closed without an inline policy', () => {
    const policy = hostedContentSecurityPolicy()
    expect(policy).toContain("script-src 'self';")
    expect(policy).toContain("style-src 'self';")
    expect(policy).toContain("frame-src 'none';")
    expect(policy).not.toContain('unsafe-inline')
    expect(policy).not.toContain('unsafe-eval')
    expect(policy).not.toContain('sha256-')
    expect(policy).not.toContain('127.0.0.1')
  })

  it('bounds design file IPC before the worker validates file semantics', () => {
    const file = {
      schemaVersion: 2, fileId: 'project-1', revision: 3,
      pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root:page-1' }],
      nodes: { 'root:page-1': { id: 'root:page-1', type: 'root' }, frame: { id: 'frame', type: 'frame', name: 'Frame', styles: { left: 0, top: 0, width: 100, height: 100 }, fills: [] } },
      relationships: { frame: { parentId: 'root:page-1', orderKey: 'a0' } },
      theme: { tokens: {} },
    }
    expect(parseRepositoryRequest({ method: 'saveFile', args: [file, 3] })).toEqual({ method: 'saveFile', args: [file, 3] })
    const { theme: _theme, ...withoutTheme } = file
    const legacyDocument = { version: 1, revision: 0, nodes: {}, rootIds: [], frame: { width: 400, height: 500, direction: 'column', gap: 16, padding: 24, clip: false } }
    let deep: Record<string, unknown> = {}
    const deepRoot = deep
    for (let level = 0; level < 80; level++) { const next = {}; deep.child = next; deep = next }
    for (const args of [
      [file, -1], [file, 0.5], [file, Number.MAX_SAFE_INTEGER], [file, '3'], [file], [file, 3, 'extra'],
      [{ ...file, extra: true }, 3], [withoutTheme, 3], [legacyDocument, 0], [[file], 3], [null, 3],
      [{ ...file, nodes: { oversized: 'x'.repeat(4_000_001) } }, 3],
      [{ ...file, theme: { tokens: Object.fromEntries(Array.from({ length: 400_001 }, (_, index) => [`t${index}`, 0])) } }, 3],
      [{ ...file, relationships: deepRoot }, 3],
      [{ ...file, theme: { tokens: { bad: Number.NaN } } }, 3],
      [{ ...file, theme: { tokens: { fn: () => undefined } } }, 3],
      [{ ...file, theme: JSON.parse('{"tokens":{},"__proto__":{"polluted":true}}') }, 3],
      [{ ...file, nodes: new Map() }, 3],
    ]) expect(() => parseRepositoryRequest({ method: 'saveFile', args })).toThrow('Invalid command.')
    const cyclic = { ...file, nodes: {} as Record<string, unknown> }
    cyclic.nodes.self = cyclic
    expect(() => parseRepositoryRequest({ method: 'saveFile', args: [cyclic, 3] })).toThrow('Invalid command.')
  })

  it('no longer accepts the retired document and preview theme commands', () => {
    const legacyDocument = { version: 1, revision: 0, nodes: {}, rootIds: [], frame: { width: 400, height: 500, direction: 'column', gap: 16, padding: 24, clip: false } }
    expect(() => parseRepositoryRequest({ method: 'saveDocument', args: [legacyDocument, 0] })).toThrow('Invalid command.')
    expect(() => parseRepositoryRequest({ method: 'setPreviewTheme', args: ['dark'] })).toThrow('Invalid command.')
    expect(() => parseRepositoryRequest({ method: 'setPreviewTheme', args: ['default'] })).toThrow('Invalid command.')
  })

  it.each([
    null,
    [],
    { method: 'readFile', args: ['C:\\private.txt'] },
    { method: 'inspectFixture', args: [], root: '../private' },
    { method: 'inspectFixture', args: ['../private'] },
    { method: 'prepareLabelPadding', args: ['1px; background: url(https://attacker.test)'] },
    { method: 'prepareLabelPadding', args: ['x'.repeat(10_000)] },
    { method: 'prepareToken', args: ['url(file:///private)'] },
    { method: 'preparePromotion', args: ['../../Escape'] },
    { method: 'savePrepared', args: ['../transaction', 'a'.repeat(64)] },
    { method: 'savePrepared', args: ['transaction-1', 'wrong-digest'] },
    { method: 'prepareUndo', args: ['../transaction'] },
    { method: 'prepareRedo', args: ['transaction', 'approval'] },
    { method: 'prepareUndo', args: [{ transactionId: 'transaction' }] },
  ])('rejects malformed, oversized, path, and executable input: %j', (input) => {
    expect(() => parseRepositoryRequest(input)).toThrow('Invalid command.')
  })
})
