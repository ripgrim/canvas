import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HmacRoomTicketVerifier } from '../src/tickets.js'
import { claims, clientId, connectionNonce, fileId, generationId } from './support.js'

function signed(secret: Buffer, value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  return Buffer.concat([payload, createHmac('sha256', secret).update(payload).digest()]).toString('base64url')
}

function tampered(token: string): string {
  const index = Math.floor(token.length / 2)
  const replacement = token[index] === 'A' ? 'B' : 'A'
  return `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`
}

describe('room capability verification', () => {
  it('checks signature, room scope, expiry, role, and durable access epoch', async () => {
    const secret = Buffer.alloc(32, 7)
    const verifier = new HmacRoomTicketVerifier(secret, { async resolve() { return { role: 'owner', accessEpoch: 1n } } })
    const token = signed(secret, claims())
    const context = { token, fileId, generationId, clientId, connectionNonce, nowUnixMs: Date.now() }
    await expect(verifier.verify(context)).resolves.toMatchObject({ claims: { fileId, generationId, role: 'owner', buildId: 'test-build' } })
    await expect(verifier.isCurrent(claims(), Date.now())).resolves.toBe(true)
    await expect(verifier.verify({ ...context, token: tampered(token) })).resolves.toBeNull()
    await expect(verifier.verify({ ...context, generationId: 'aa7d739c-7eae-4552-b2af-928312531c7e' })).resolves.toBeNull()
    const revoked = new HmacRoomTicketVerifier(secret, { async resolve() { return { role: 'owner', accessEpoch: 2n } } })
    await expect(revoked.verify(context)).resolves.toBeNull()
    await expect(revoked.isCurrent(claims(), Date.now())).resolves.toBe(false)
  })

  it('CLOUD-SYNC-AUTH-001 consumes a capability once and binds the admitted browser build', async () => {
    const secret = Buffer.alloc(32, 8)
    const verifier = new HmacRoomTicketVerifier(secret, { async resolve() { return { role: 'owner', accessEpoch: 1n } } })
    const token = signed(secret, claims())
    const context = { token, fileId, generationId, clientId, connectionNonce, nowUnixMs: Date.now() }
    const authorization = await verifier.verify(context)
    expect(authorization).not.toBeNull()
    await expect(verifier.consume(authorization!, { nowUnixMs: Date.now(), buildId: 'stale-build' })).resolves.toBeNull()

    const burnedReplay = await verifier.verify(context)
    expect(burnedReplay).not.toBeNull()
    await expect(verifier.consume(burnedReplay!, { nowUnixMs: Date.now(), buildId: 'test-build' })).resolves.toBeNull()

    const alternateNonce = 'Z'.repeat(24)
    const alternateClaims = { ...claims(), connectionNonce: alternateNonce }
    const alternateContext = { ...context, connectionNonce: alternateNonce, token: signed(secret, alternateClaims) }
    const valid = await verifier.verify(alternateContext)
    expect(valid).not.toBeNull()
    await expect(verifier.consume(valid!, { nowUnixMs: Date.now(), buildId: 'test-build' })).resolves.toMatchObject({ clientId, connectionNonce: alternateNonce })
    const secondReplay = await verifier.verify(alternateContext)
    expect(secondReplay).not.toBeNull()
    await expect(verifier.consume(secondReplay!, { nowUnixMs: Date.now(), buildId: 'test-build' })).resolves.toBeNull()
  })

  it('CLOUD-SYNC-AUTH-001 rejects signed identity that is invalid or carries private fields', async () => {
    const secret = Buffer.alloc(32, 9)
    const verifier = new HmacRoomTicketVerifier(secret, { async resolve() { return { role: 'owner', accessEpoch: 1n } } })
    const context = { token: '', fileId, generationId, clientId, connectionNonce, nowUnixMs: Date.now() }
    const invalid = [
      { ...claims(), displayName: ' Alpha ' },
      { ...claims(), avatarUrl: 'http://images.example/alpha.png' },
      { ...claims(), email: 'alpha@example.test' },
    ]
    for (const value of invalid) {
      await expect(verifier.verify({ ...context, token: signed(secret, value) })).resolves.toBeNull()
    }
  })
})
