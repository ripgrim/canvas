import { describe, expect, it } from 'vitest'
import type { HostedAuth, HostedSessionUser } from '../packages/auth/src/server'
import { createCloudApiClient } from '../packages/cloud-client/src/index'
import { createMemoryControlPlane } from '../packages/database/src/memory'
import { reconcileShareUpdate } from '../packages/editor/src/features/editor/store'
import { createApiApp } from '../apps/api/src/app'

const user = Object.freeze({ id: 'user-alpha', name: 'Alpha', email: 'alpha@example.test', image: null }) satisfies HostedSessionUser
const auth: HostedAuth = Object.freeze({
  handler: async () => new Response(null, { status: 404 }),
  getSession: async request => request.headers.get('Authorization') === 'Bearer alpha' ? user : null,
})

describe('share access reconciliation across the HTTP boundary', () => {
  it('AT-SHARE-003 re-reads committed access after the PUT response is lost', async () => {
    const store = createMemoryControlPlane()
    const file = await store.createFile(user.id, 'Shared file', null)
    const app = createApiApp({ auth, store, serviceToken: '0123456789abcdef0123456789abcdef', registryFingerprint: `sha256-${'A'.repeat(43)}=` })
    let dropCommittedResponse = true
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const incoming = new Request(input, init)
      const headers = new Headers(incoming.headers)
      headers.set('Authorization', 'Bearer alpha')
      const request = new Request(incoming, { headers })
      const response = await app(request)
      if (dropCommittedResponse && request.method === 'PUT' && new URL(request.url).pathname.endsWith('/share') && response.ok) {
        dropCommittedResponse = false
        throw new TypeError('Connection closed after commit.')
      }
      return response
    }
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher, validateDocument: value => value })

    expect((await client.getFileShare(file.id)).access).toBe('private')
    const result = await reconcileShareUpdate({
      requestedAccess: 'view',
      setAccess: () => client.setFileShare(file.id, 'view'),
      readAccess: () => client.getFileShare(file.id),
    })

    expect(result).toMatchObject({ status: 'confirmed', requested: true, share: { fileId: file.id, access: 'view' } })
    expect((await client.getFileShare(file.id)).access).toBe('view')
  })
})
