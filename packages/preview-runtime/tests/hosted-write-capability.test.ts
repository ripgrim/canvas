import { describe, expect, it } from 'vitest'
import { issueHostedPreviewWriteCapability, verifyHostedPreviewWriteCapability } from '../src/hosted-write-capability'

const identity = Object.freeze({
  jobId: '00000000-0000-4000-8000-000000000101',
  leaseId: '00000000-0000-4000-8000-000000000102',
  artifactId: '00000000-0000-4000-8000-000000000103',
  stagingId: '00000000-0000-4000-8000-000000000104',
})
const secret = 'hosted-preview-write-secret-0123456789abcdef'
const audience = 'https://assets.canvas.test'

describe('hosted preview write capability', () => {
  it('binds one short-lived token to every server-owned write identity', async () => {
    const token = await issueHostedPreviewWriteCapability({ ...identity, audience, secret, now: 100, lifetimeSeconds: 60 })
    await expect(verifyHostedPreviewWriteCapability({ ...identity, token, audience, secret, now: 159 })).resolves.toMatchObject({ ...identity, audience, issuedAt: 100, expiresAt: 160 })
    await expect(verifyHostedPreviewWriteCapability({ ...identity, artifactId: crypto.randomUUID(), token, audience, secret, now: 159 })).rejects.toThrow('invalid')
    await expect(verifyHostedPreviewWriteCapability({ ...identity, leaseId: crypto.randomUUID(), token, audience, secret, now: 159 })).rejects.toThrow('invalid')
    await expect(verifyHostedPreviewWriteCapability({ ...identity, token, audience: 'https://other.test', secret, now: 159 })).rejects.toThrow('invalid')
    await expect(verifyHostedPreviewWriteCapability({ ...identity, token, audience, secret, now: 160 })).rejects.toThrow('invalid')
  })
})
