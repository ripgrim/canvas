import { createHash, randomBytes } from 'node:crypto'
import type { InstallationStateStore } from './contracts.js'
import { GitHubAppError, opaqueId } from './validation.js'

const statePattern = /^[A-Za-z0-9_-]{32,256}$/

function digestState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex')
}

export class InstallationStateService {
  constructor(
    private readonly store: InstallationStateStore,
    private readonly options: Readonly<{
      now?: () => number
      createState?: () => string
      ttlMs?: number
    }> = {},
  ) {}

  async issue(input: Readonly<{ accountId: string; tenantId: string }>): Promise<Readonly<{ state: string; expiresAt: number }>> {
    const now = this.options.now?.() ?? Date.now()
    const ttlMs = this.options.ttlMs ?? 10 * 60_000
    if (!Number.isSafeInteger(now) || ttlMs < 60_000 || ttlMs > 30 * 60_000) throw new GitHubAppError('INVALID_STATE', 'Unable to start GitHub connection.')
    const state = this.options.createState?.() ?? randomBytes(32).toString('base64url')
    if (!statePattern.test(state)) throw new GitHubAppError('INVALID_STATE', 'Unable to start GitHub connection.')
    const expiresAt = now + ttlMs
    await this.store.put({ digest: digestState(state), accountId: opaqueId(input.accountId), tenantId: opaqueId(input.tenantId), expiresAt })
    return { state, expiresAt }
  }

  async consume(state: string, accountId: string): Promise<Readonly<{ tenantId: string }>> {
    if (!statePattern.test(state)) throw new GitHubAppError('INVALID_STATE', 'GitHub connection could not be verified.')
    const record = await this.store.consumeByDigest(digestState(state))
    if (!record || record.accountId !== opaqueId(accountId)) throw new GitHubAppError('INVALID_STATE', 'GitHub connection could not be verified.')
    const now = this.options.now?.() ?? Date.now()
    if (record.expiresAt <= now) throw new GitHubAppError('EXPIRED_STATE', 'GitHub connection expired.')
    return { tenantId: opaqueId(record.tenantId) }
  }
}
