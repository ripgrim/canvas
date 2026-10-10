import { createHmac, timingSafeEqual } from 'node:crypto'
import type { GitHubGrantStore, InstallationInvalidationReason, WebhookDeliveryStore } from './contracts.js'
import { GitHubAppError, githubId } from './validation.js'

export type GitHubLifecycleEvent =
  | Readonly<{ type: 'installation.invalidated'; installationId: string; reason: InstallationInvalidationReason }>
  | Readonly<{ type: 'repositories.removed'; installationId: string; repositoryIds: readonly string[] }>

const signaturePattern = /^sha256=([a-f0-9]{64})$/
const deliveryPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

function bytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : body
}

export function verifyWebhookSignature(input: Readonly<{
  secret: string | Uint8Array
  body: string | Uint8Array
  signature: string
}>): boolean {
  const match = signaturePattern.exec(input.signature.toLocaleLowerCase('en-US'))
  const secret = bytes(input.secret)
  if (!match || secret.byteLength < 16) return false
  const supplied = Buffer.from(match[1] ?? '', 'hex')
  const expected = createHmac('sha256', secret).update(bytes(input.body)).digest()
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubAppError('INVALID_WEBHOOK', 'Invalid GitHub webhook.')
  return value as Record<string, unknown>
}

function installationId(payload: Record<string, unknown>): string {
  return githubId(record(payload.installation).id)
}

export function parseLifecycleWebhook(eventName: string, body: string | Uint8Array): GitHubLifecycleEvent | null {
  let payload: Record<string, unknown>
  try {
    payload = record(JSON.parse(Buffer.from(bytes(body)).toString('utf8')))
  } catch (error) {
    if (error instanceof GitHubAppError) throw error
    throw new GitHubAppError('INVALID_WEBHOOK', 'Invalid GitHub webhook.')
  }
  if (eventName === 'installation' && (payload.action === 'suspend' || payload.action === 'deleted')) {
    return { type: 'installation.invalidated', installationId: installationId(payload), reason: payload.action === 'suspend' ? 'suspended' : 'deleted' }
  }
  if (eventName === 'installation_repositories' && payload.action === 'removed') {
    if (!Array.isArray(payload.repositories_removed) || payload.repositories_removed.length === 0 || payload.repositories_removed.length > 1_000) throw new GitHubAppError('INVALID_WEBHOOK', 'Invalid GitHub webhook.')
    const repositoryIds = payload.repositories_removed.map(repository => githubId(record(repository).id))
    if (new Set(repositoryIds).size !== repositoryIds.length) throw new GitHubAppError('INVALID_WEBHOOK', 'Invalid GitHub webhook.')
    return { type: 'repositories.removed', installationId: installationId(payload), repositoryIds }
  }
  return null
}

export class GitHubWebhookService {
  constructor(
    private readonly secret: string | Uint8Array,
    private readonly deliveries: WebhookDeliveryStore,
    private readonly grants: GitHubGrantStore,
    private readonly now: () => number = Date.now,
  ) {}

  async handle(input: Readonly<{
    deliveryId: string
    eventName: string
    signature: string
    body: string | Uint8Array
  }>): Promise<Readonly<{ status: 'applied' | 'ignored'; event: GitHubLifecycleEvent | null }>> {
    if (!verifyWebhookSignature({ secret: this.secret, body: input.body, signature: input.signature })) throw new GitHubAppError('INVALID_WEBHOOK_SIGNATURE', 'GitHub webhook could not be verified.')
    if (!deliveryPattern.test(input.deliveryId) || input.eventName.length < 1 || input.eventName.length > 100) throw new GitHubAppError('INVALID_WEBHOOK', 'Invalid GitHub webhook.')
    const event = parseLifecycleWebhook(input.eventName, input.body)
    const receivedAt = this.now()
    if (!await this.deliveries.claimDelivery({ deliveryId: input.deliveryId, receivedAt })) throw new GitHubAppError('DUPLICATE_DELIVERY', 'GitHub webhook was already received.')
    try {
      if (event?.type === 'installation.invalidated') {
        await this.grants.invalidateInstallation({ installationId: event.installationId, reason: event.reason, invalidatedAt: receivedAt })
      } else if (event) {
        await this.grants.invalidateRepositories({ installationId: event.installationId, repositoryIds: event.repositoryIds, reason: 'removed', invalidatedAt: receivedAt })
      }
      await this.deliveries.completeDelivery({ deliveryId: input.deliveryId, completedAt: this.now() })
    } catch (error) {
      await this.deliveries.releaseDelivery({ deliveryId: input.deliveryId })
      throw error
    }
    return event ? { status: 'applied', event } : { status: 'ignored', event: null }
  }
}
