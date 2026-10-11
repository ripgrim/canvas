import { describe, expect, it } from 'vitest'
import { restoreVercelRequestPath } from '../src/runtime'

describe('Vercel API adapter', () => {
  it('DEPLOY-VERCEL-001 restores public API and internal paths without losing method, headers, body, or query', async () => {
    const request = new Request('https://api.example.test/api/handler?__canvas_path=internal%2Fthumbnail-source&keep=yes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test': 'kept' },
      body: JSON.stringify({ fileId: 'file-1' }),
    })
    const restored = restoreVercelRequestPath(request)
    expect(restored.url).toBe('https://api.example.test/internal/thumbnail-source?keep=yes')
    expect(restored.method).toBe('POST')
    expect(restored.headers.get('X-Test')).toBe('kept')
    expect(await restored.json()).toEqual({ fileId: 'file-1' })
  })

  it('DEPLOY-VERCEL-001 leaves direct local requests unchanged', () => {
    const request = new Request('http://127.0.0.1:4320/healthz')
    expect(restoreVercelRequestPath(request)).toBe(request)
  })
})

