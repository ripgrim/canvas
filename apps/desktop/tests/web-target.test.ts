import { describe, expect, it } from 'vitest'
import { allowedHostedEditorOrigins, localCapabilityArguments, mayExposeLocalCapabilities, resolveEditorTarget } from '../src/main/web-target'

const fixtureOrigins = ['https://editor.example.test'] as const

describe('desktop editor target', () => {
  it('defaults to local targets and an empty hosted allowlist', () => {
    expect(allowedHostedEditorOrigins).toEqual([])
    expect(Object.isFrozen(allowedHostedEditorOrigins)).toBe(true)
    expect(resolveEditorTarget(undefined, false)).toEqual({ kind: 'local', url: 'design-editor://app/', origin: 'design-editor://app', development: false, localCapabilities: true })
    expect(resolveEditorTarget(undefined, true)).toEqual({ kind: 'local', url: 'http://127.0.0.1:4317/', origin: 'http://127.0.0.1:4317', development: true, localCapabilities: true })
    expect(() => resolveEditorTarget('https://editor.example.test/', false)).toThrow('not allowed')
  })

  it('retains the exact canonical hosted path without granting local capabilities', () => {
    const target = resolveEditorTarget('https://editor.example.test/workspaces/example?view=design', true, fixtureOrigins)
    expect(target).toEqual({ kind: 'hosted', url: 'https://editor.example.test/workspaces/example?view=design', origin: 'https://editor.example.test', development: false, localCapabilities: false })
    expect(localCapabilityArguments(target)).toEqual([])
  })

  it.each([
    '',
    ' https://editor.example.test/',
    'http://editor.example.test/',
    'https://user:password@editor.example.test/',
    'https://user@editor.example.test/',
    'https://editor.example.test/#section',
    'https://editor.example.test/#',
    'https://editor.example.test:443/',
    'https://editor.example.test:444/',
    'https://editor.example.test.evil.test/',
    'https://editor.example.test@evil.test/',
    'https://editor.example.test/../settings',
    'https://editor.example.test/%2e%2e/settings',
    'https://editor.example.test',
    'https://EDITOR.example.test/',
    'https://editor.example.test\\settings',
    'http://127.0.0.1:4317/',
    'design-editor://app/',
  ])('rejects an invalid or unapproved hosted target: %s', (url) => {
    expect(() => resolveEditorTarget(url, false, fixtureOrigins)).toThrow()
  })

  it('rejects noncanonical or insecure compiled allowlist entries', () => {
    for (const origin of ['https://editor.example.test/', 'http://editor.example.test', 'https://user@editor.example.test', 'https://editor.example.test/editor']) {
      expect(() => resolveEditorTarget('https://editor.example.test/', false, [origin])).toThrow('allowlist is invalid')
    }
  })
})

describe('preload capability gate', () => {
  it('requires a main frame, one explicit grant, and the exact local document', () => {
    const args = ['--design-editor-local-capabilities', '--design-editor-editor-url=design-editor://app/']
    expect(localCapabilityArguments(resolveEditorTarget(undefined, false))).toEqual(args)
    expect(mayExposeLocalCapabilities(true, args, 'design-editor://app/')).toBe(true)
    expect(mayExposeLocalCapabilities(false, args, 'design-editor://app/')).toBe(false)
    expect(mayExposeLocalCapabilities(true, [], 'design-editor://app/')).toBe(false)
    expect(mayExposeLocalCapabilities(true, [args[0]!], 'design-editor://app/')).toBe(false)
    expect(mayExposeLocalCapabilities(true, [args[1]!], 'design-editor://app/')).toBe(false)
    expect(mayExposeLocalCapabilities(true, [...args, args[0]!], 'design-editor://app/')).toBe(false)
    expect(mayExposeLocalCapabilities(true, [...args, args[1]!], 'design-editor://app/')).toBe(false)
    // Nested routes of the bundled document stay granted after reload; other hosts, schemes, and documents do not.
    for (const url of ['design-editor://app/file/01M38YBDDRJSMJ5M4VRYVV8E4Z', 'design-editor://app/file/x?pageId=y']) expect(mayExposeLocalCapabilities(true, args, url)).toBe(true)
    for (const url of ['about:blank', 'design-editor://apps/', 'design-editor://app.example/', 'file:///app/index.html', 'https://editor.example.test/']) {
      expect(mayExposeLocalCapabilities(true, args, url)).toBe(false)
    }
  })

  it('accepts only the development document explicitly granted by main', () => {
    const args = ['--design-editor-local-capabilities', '--design-editor-editor-url=http://127.0.0.1:4317/']
    expect(localCapabilityArguments(resolveEditorTarget(undefined, true))).toEqual(args)
    expect(mayExposeLocalCapabilities(true, args, 'http://127.0.0.1:4317/')).toBe(true)
    expect(mayExposeLocalCapabilities(true, args, 'http://127.0.0.1:4317/file/abc?pageId=p')).toBe(true)
    for (const url of ['http://localhost:4317/', 'http://127.0.0.1:43170/', 'https://127.0.0.1:4317/']) {
      expect(mayExposeLocalCapabilities(true, args, url)).toBe(false)
    }
    const forged = ['--design-editor-local-capabilities', '--design-editor-editor-url=https://editor.example.test/']
    expect(mayExposeLocalCapabilities(true, forged, 'https://editor.example.test/')).toBe(false)
  })
})
