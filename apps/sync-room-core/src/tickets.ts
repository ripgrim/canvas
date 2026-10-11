import { createHmac, timingSafeEqual } from 'node:crypto'
import { validateVerifiedRoomTicketClaimsShape } from '@canvas/sync-protocol'
import type { VerifiedRoomRole, VerifiedRoomTicketClaims } from '@canvas/sync-protocol'
import type { RoomAuthorization, RoomTicketContext, RoomTicketVerifier } from './contracts.js'

export interface RoomAccessResolver {
  resolve(input: Readonly<{ subjectId: string; fileId: string }>): Promise<Readonly<{ role: VerifiedRoomRole; accessEpoch: bigint }> | null>
}

function decodeToken(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 8_192) return null
  try { return Buffer.from(value, 'base64url') } catch { return null }
}

export class HmacRoomTicketVerifier implements RoomTicketVerifier {
  readonly #secret: Buffer
  readonly #access: RoomAccessResolver
  readonly #authorizations = new WeakSet<RoomAuthorization>()
  readonly #consumedNonces = new Map<string, number>()

  constructor(secret: Uint8Array, access: RoomAccessResolver) {
    if (secret.byteLength < 32) throw new Error('Room ticket secret must contain at least 32 bytes.')
    this.#secret = Buffer.from(secret)
    this.#access = access
  }

  async verify(context: RoomTicketContext): Promise<RoomAuthorization | null> {
    const token = decodeToken(context.token)
    if (!token || token.byteLength <= 32) return null
    const payload = token.subarray(0, token.byteLength - 32)
    const signature = token.subarray(token.byteLength - 32)
    const expected = createHmac('sha256', this.#secret).update(payload).digest()
    if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) return null
    let claims: VerifiedRoomTicketClaims
    try { claims = validateVerifiedRoomTicketClaimsShape(JSON.parse(payload.toString('utf8'))) } catch { return null }
    if (claims.expiresAtUnixMs <= context.nowUnixMs
      || claims.fileId !== context.fileId
      || claims.generationId !== context.generationId
      || claims.clientId !== context.clientId
      || claims.connectionNonce !== context.connectionNonce) return null
    const access = await this.#access.resolve({ subjectId: claims.subjectId, fileId: claims.fileId })
    if (!access || access.role !== claims.role || access.accessEpoch.toString() !== claims.accessEpoch) return null
    const authorization = Object.freeze({ claims })
    this.#authorizations.add(authorization)
    return authorization
  }

  async consume(authorization: RoomAuthorization, input: Readonly<{ nowUnixMs: number; buildId: string }>): Promise<VerifiedRoomTicketClaims | null> {
    if (!this.#authorizations.delete(authorization)) return null
    for (const [nonce, expiresAtUnixMs] of this.#consumedNonces) {
      if (expiresAtUnixMs <= input.nowUnixMs) this.#consumedNonces.delete(nonce)
    }
    const claims = authorization.claims
    if (claims.expiresAtUnixMs <= input.nowUnixMs || this.#consumedNonces.has(claims.connectionNonce)) return null
    if (this.#consumedNonces.size >= 16_384) return null
    this.#consumedNonces.set(claims.connectionNonce, claims.expiresAtUnixMs)
    if (claims.buildId !== input.buildId) return null
    return await this.isCurrent(claims, input.nowUnixMs) ? claims : null
  }

  async isCurrent(claims: VerifiedRoomTicketClaims, nowUnixMs: number): Promise<boolean> {
    if (claims.expiresAtUnixMs <= nowUnixMs) return false
    const access = await this.#access.resolve({ subjectId: claims.subjectId, fileId: claims.fileId })
    return access?.role === claims.role && access.accessEpoch.toString() === claims.accessEpoch
  }
}
