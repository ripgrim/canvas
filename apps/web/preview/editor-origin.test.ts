import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { createPreviewContentSecurityPolicy, previewContentSecurityPolicy, previewResponseHeaders } from './csp'

vi.mock('@canvas/preview-runtime/browser', () => ({ startPreview: vi.fn() }))
vi.mock('virtual:canvas-verified-component-registry', () => ({ RegistryEntry: null, RegistryProvider: undefined, registry: [], registryContract: { version: 1, fingerprint: 'sha256-empty', entry: null }, registryProviderProps: {}, registryThemeAdapters: [] }))
vi.stubGlobal('window', { location: { search: '?editorOrigin=design-editor%3A%2F%2Fapp&mode=composition', origin: 'https://preview.canvas.test' } })
vi.stubGlobal('document', { documentElement: { dataset: {} } })

const { startPreview } = await import('@canvas/preview-runtime/browser')
const { requireEditorOrigin } = await import('./main')

describe('bundled preview editor origin', () => {
  it('AT-PRV-001 applies a deny-by-default preview CSP without network, framing, or form capabilities', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1]
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).not.toContain("'unsafe-eval'")
  })
  it('AT-PRV-001 delivers the static preview CSP as an HTTP response header with only intended editor ancestors', async () => {
    const server = await createServer({
      configFile: false,
      root: import.meta.dirname,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: false, headers: previewResponseHeaders },
    })
    try {
      await server.listen()
      const address = server.httpServer?.address()
      expect(address).not.toBeNull()
      expect(typeof address).not.toBe('string')
      if (!address || typeof address === 'string') throw new Error('Preview test server did not bind.')
      const response = await fetch(`http://127.0.0.1:${address.port}/`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toBe(previewContentSecurityPolicy)
      expect(response.headers.get('content-security-policy')).toContain('frame-ancestors design-editor://app http://127.0.0.1:4317 http://localhost:4317')
      expect(response.headers.get('content-security-policy')).toContain('https://canvas.ripgrim.com')
      expect(response.headers.get('content-security-policy')).not.toContain('https://comp-canvas-web.vercel.app')
      expect(response.headers.get('content-security-policy')).not.toContain('*')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    } finally {
      await server.close()
    }
  })
  it('AT-PRV-001 permits one exact loopback editor origin', () => {
    const csp = createPreviewContentSecurityPolicy('http://127.0.0.1:4327')
    expect(csp).toContain('http://127.0.0.1:4327')
    expect(csp).not.toContain('http://127.0.0.1:4328')
  })

  it('AT-PRV-001 permits one exact HTTPS editor origin', () => {
    const csp = createPreviewContentSecurityPolicy('https://desktop.example.ts.net:9443')
    expect(csp).toContain('https://desktop.example.ts.net:9443')
    expect(csp).not.toContain('https://desktop.example.ts.net:9444')
  })

  it('AT-PRV-001 rejects unsafe additional editor origins', () => {
    for (const origin of ['http://example.com', 'https://example.com/path', 'http://127.0.0.1:4327/path', 'http://127.0.0.2:4327']) {
      expect(() => createPreviewContentSecurityPolicy(origin)).toThrow('The preview editor origin must be HTTPS or HTTP loopback.')
    }
  })
  it('accepts the registered desktop origin and canonical remote origins', () => {
    expect(startPreview).toHaveBeenCalledWith(expect.objectContaining({ editorOrigin: 'design-editor://app' }))
    expect(requireEditorOrigin('design-editor://app', 'https://preview.canvas.test')).toBe('design-editor://app')
    expect(requireEditorOrigin('https://app.canvas.test', 'https://preview.canvas.test')).toBe('https://app.canvas.test')
  })

  it('rejects unregistered custom schemes and non-origin URLs', () => {
    for (const origin of ['other-editor://app', 'design-editor://other', 'design-editor://app/', 'design-editor://app.evil', 'https://app.canvas.test/path']) {
      expect(() => requireEditorOrigin(origin, 'https://preview.canvas.test')).toThrow('A separate editor origin is required.')
    }
  })

  it('rejects the preview origin itself', () => {
    expect(() => requireEditorOrigin('https://preview.canvas.test', 'https://preview.canvas.test')).toThrow('A separate editor origin is required.')
  })
})
