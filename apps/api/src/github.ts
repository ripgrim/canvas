import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes, sign } from 'node:crypto'
import type { HostedSessionUser } from '@canvas/auth/server'
import { createPostgresGitHubPersistence } from '@canvas/database/github'
import {
  GitHubGrantService,
  GitHubWebhookService,
  InstallationStateService,
  RepositoryJobService,
  type GitHubActor,
  type GitHubInstallationIdentity,
  type GitHubProviderPort,
  type GitHubRepositoryIdentity,
  type InstallationAccessToken,
  type InstallationTokenPort,
  type RepositoryContentsPermission,
} from '@canvas/github-app'
import type { Pool, PoolClient, QueryResultRow } from 'pg'

export type GitHubApiServices = Readonly<{
  states: InstallationStateService
  grants: GitHubGrantService
  webhooks: GitHubWebhookService
  jobs: RepositoryJobService
  resolveActor(user: HostedSessionUser): Promise<GitHubActor | null>
  authorizeUser(input: Readonly<{ accountId: string; code: string; codeVerifierCiphertext: string }>): Promise<GitHubActor>
  issueAuthorization(input: Readonly<{ accountId: string; tenantId: string; installationId: string }>): Promise<Readonly<{ authorizationUrl: string; expiresAt: number }>>
  resolveProjectTenant(projectId: string, userId: string): Promise<string | null>
  installationUrl(state: string): string
}>

export type GitHubRuntimeOptions = Readonly<{
  appId: string
  appSlug: string
  clientId: string
  clientSecret: string
  privateKey: string
  webhookSecret: string
  credentialEncryptionKey: string
  authorizationCallbackUrl: string
  fetch?: typeof fetch
  now?: () => number
}>

type CredentialRow = QueryResultRow & Readonly<{
  account_id: string; provider_user_id: string; access_token_ciphertext: string; refresh_token_ciphertext: string
  access_expires_at: Date | string; refresh_expires_at: Date | string; token_version: string | number
}>
type TokenPair = Readonly<{ accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number }>

const appSlugPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98})$/
const statePattern = /^[A-Za-z0-9_-]{32,256}$/
const codePattern = /^[A-Za-z0-9_\-.]{8,1024}$/

export function createPostgresGitHubApiServices(pool: Pool, options: GitHubRuntimeOptions): GitHubApiServices {
  validateOptions(options)
  const request = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const cipher = credentialCipher(options.credentialEncryptionKey)
  const credentials = createCredentialStore(pool, cipher, request, options, now)
  const persistence = createPostgresGitHubPersistence(pool)
  const provider = createGitHubUserProvider(credentials, request)
  const states = new InstallationStateService(persistence.states, { now })
  const grants = new GitHubGrantService(provider, persistence.grants, states, persistence.projectAuthorization, now)
  const tokens = createInstallationTokenProvider(options, request, now)
  return Object.freeze({
    states,
    grants,
    webhooks: new GitHubWebhookService(options.webhookSecret, persistence.deliveries, persistence.grants, now),
    jobs: new RepositoryJobService(grants, persistence.jobs, tokens, now),
    async resolveActor(user) {
      const credential = await credentials.getFresh(user.id)
      return credential ? Object.freeze({ accountId: user.id, providerUserId: credential.providerUserId }) : null
    },
    async authorizeUser(input) {
      if (!codePattern.test(input.code)) throw new Error('GitHub authorization code is invalid.')
      const verifier = cipher.decrypt(input.codeVerifierCiphertext)
      const pair = await exchangeCode(request, options, input.code, verifier, now())
      const user = record(await githubJson(request, pair.accessToken, '/user'))
      const providerUserId = githubId(user.id)
      await credentials.save(input.accountId, providerUserId, pair)
      return Object.freeze({ accountId: input.accountId, providerUserId })
    },
    async issueAuthorization(input) {
      const verifier = randomBytes(48).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const issued = await states.issue({ accountId: input.accountId, tenantId: input.tenantId, purpose: 'authorize-user', installationId: input.installationId, codeVerifierCiphertext: cipher.encrypt(verifier) })
      const url = new URL('https://github.com/login/oauth/authorize')
      url.searchParams.set('client_id', options.clientId)
      url.searchParams.set('redirect_uri', options.authorizationCallbackUrl)
      url.searchParams.set('state', issued.state)
      url.searchParams.set('scope', 'offline_access')
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return Object.freeze({ authorizationUrl: url.toString(), expiresAt: issued.expiresAt })
    },
    resolveProjectTenant(projectId, userId) { return persistence.projectTenancy.resolveTenantForMember(projectId, userId) },
    installationUrl(state) {
      if (!statePattern.test(state)) throw new Error('GitHub installation state is invalid.')
      const url = new URL(`https://github.com/apps/${options.appSlug}/installations/new`)
      url.searchParams.set('state', state)
      return url.toString()
    },
  })
}

function createCredentialStore(pool: Pool, cipher: ReturnType<typeof credentialCipher>, request: typeof fetch, options: GitHubRuntimeOptions, now: () => number) {
  return Object.freeze({
    async save(accountId: string, providerUserId: string, pair: TokenPair): Promise<void> {
      await pool.query(
        `INSERT INTO app_github_user_credential
          (account_id, provider_user_id, access_token_ciphertext, refresh_token_ciphertext, access_expires_at, refresh_expires_at, token_version)
         VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), 1)
         ON CONFLICT (account_id) DO UPDATE SET provider_user_id = EXCLUDED.provider_user_id,
           access_token_ciphertext = EXCLUDED.access_token_ciphertext, refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
           access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
           token_version = app_github_user_credential.token_version + 1, updated_at = now()`,
        [accountId, providerUserId, cipher.encrypt(pair.accessToken), cipher.encrypt(pair.refreshToken), pair.accessExpiresAt, pair.refreshExpiresAt],
      )
    },
    async getFresh(accountId: string): Promise<Readonly<{ providerUserId: string; accessToken: string }> | null> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await client.query<CredentialRow>('SELECT account_id, provider_user_id, access_token_ciphertext, refresh_token_ciphertext, access_expires_at, refresh_expires_at, token_version FROM app_github_user_credential WHERE account_id = $1 FOR UPDATE', [accountId])
        const row = result.rows[0]
        if (!row) { await client.query('ROLLBACK'); return null }
        const current = rowPair(row, cipher)
        if (current.accessExpiresAt > now() + 60_000) { await client.query('COMMIT'); return Object.freeze({ providerUserId: row.provider_user_id, accessToken: current.accessToken }) }
        if (current.refreshExpiresAt <= now()) { await client.query('ROLLBACK'); return null }
        const refreshed = await refreshPair(request, options, current.refreshToken, now())
        await updatePair(client, row, refreshed, cipher)
        await client.query('COMMIT')
        return Object.freeze({ providerUserId: row.provider_user_id, accessToken: refreshed.accessToken })
      } catch (error) {
        try { await client.query('ROLLBACK') }
        catch (rollbackError) { console.error(JSON.stringify({ level: 'error', event: 'github_authorization_rollback_failed', message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) })) }
        throw error
      } finally { client.release() }
    },
  })
}

function createGitHubUserProvider(credentials: ReturnType<typeof createCredentialStore>, request: typeof fetch): GitHubProviderPort {
  return Object.freeze({
    async listInstallationsForUser(actor: GitHubActor) {
      const credential = await credentialForActor(credentials, actor)
      const installations: GitHubInstallationIdentity[] = []
      for (let page = 1; page <= 20; page += 1) {
        const payload = record(await githubJson(request, credential.accessToken, `/user/installations?per_page=100&page=${page}`))
        const values = payload.installations
        if (!Array.isArray(values)) throw new Error('GitHub returned invalid installation data.')
        installations.push(...values.map(readInstallation))
        if (values.length < 100) return Object.freeze(installations)
      }
      throw new Error('GitHub installation result exceeded the supported page limit.')
    },
    async getRepositoryForInstallation(input: Readonly<{ actor: GitHubActor; installationId: string; repositoryId: string }>) {
      const credential = await credentialForActor(credentials, input.actor)
      for (let page = 1; page <= 100; page += 1) {
        const payload = await githubJson(request, credential.accessToken, `/user/installations/${input.installationId}/repositories?per_page=100&page=${page}`, true)
        if (payload === null) return null
        const values = record(payload).repositories
        if (!Array.isArray(values)) throw new Error('GitHub returned invalid repository data.')
        for (const value of values) {
          const repository = readRepository(value, input.installationId)
          if (repository.id === input.repositoryId) return repository
        }
        if (values.length < 100) return null
      }
      throw new Error('GitHub repository result exceeded the supported page limit.')
    },
  })
}

function createInstallationTokenProvider(options: GitHubRuntimeOptions, request: typeof fetch, now: () => number): InstallationTokenPort {
  const key = createPrivateKey(options.privateKey.replace(/\\n/g, '\n'))
  return Object.freeze({
    async mint(input: Readonly<{ installationId: string; repositoryId: string; contentsPermission: 'read' | 'write' }>): Promise<InstallationAccessToken> {
      const jwt = appJwt(options.appId, key, now())
      const response = await request(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
        method: 'POST',
        headers: githubHeaders(jwt),
        body: JSON.stringify({ repository_ids: [Number(input.repositoryId)], permissions: { metadata: 'read', contents: input.contentsPermission } }),
      })
      if (!response.ok) throw new Error(`GitHub installation token request failed with status ${response.status}.`)
      const payload = record(await limitedJson(response))
      if (typeof payload.token !== 'string' || !payload.token.startsWith('ghs_') || typeof payload.expires_at !== 'string') throw new Error('GitHub returned an invalid installation token.')
      const permissions = record(payload.permissions)
      if (permissions.contents !== input.contentsPermission) throw new Error('GitHub returned insufficient repository permissions.')
      const expiresAt = Date.parse(payload.expires_at)
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) throw new Error('GitHub returned an expired installation token.')
      return Object.freeze({ token: payload.token, expiresAt, contentsPermission: input.contentsPermission })
    },
  })
}

async function credentialForActor(credentials: ReturnType<typeof createCredentialStore>, actor: GitHubActor) {
  const credential = await credentials.getFresh(actor.accountId)
  if (!credential || credential.providerUserId !== actor.providerUserId) throw new Error('GitHub account is not available.')
  return credential
}

async function exchangeCode(request: typeof fetch, options: GitHubRuntimeOptions, code: string, verifier: string, requestedAt: number): Promise<TokenPair> {
  return tokenExchange(request, options, new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, code, redirect_uri: options.authorizationCallbackUrl, code_verifier: verifier }), requestedAt)
}

async function refreshPair(request: typeof fetch, options: GitHubRuntimeOptions, refreshToken: string, requestedAt: number): Promise<TokenPair> {
  return tokenExchange(request, options, new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }), requestedAt)
}

async function tokenExchange(request: typeof fetch, options: GitHubRuntimeOptions, body: URLSearchParams, requestedAt: number): Promise<TokenPair> {
  const response = await request('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  if (!response.ok) throw new Error(`GitHub authorization failed with status ${response.status}.`)
  return parseGitHubUserTokenPayload(await limitedJson(response), requestedAt)
}

export function parseGitHubUserTokenPayload(value: unknown, requestedAt: number): TokenPair {
  const payload = record(value)
  if (typeof payload.access_token !== 'string' || !payload.access_token.startsWith('ghu_') || typeof payload.refresh_token !== 'string' || !payload.refresh_token.startsWith('ghr_')) throw new Error('GitHub returned an invalid user token.')
  const expiresIn = seconds(payload.expires_in)
  const refreshExpiresIn = seconds(payload.refresh_token_expires_in)
  return Object.freeze({ accessToken: payload.access_token, refreshToken: payload.refresh_token, accessExpiresAt: requestedAt + expiresIn * 1000, refreshExpiresAt: requestedAt + refreshExpiresIn * 1000 })
}

async function updatePair(client: PoolClient, row: CredentialRow, pair: TokenPair, cipher: ReturnType<typeof credentialCipher>): Promise<void> {
  const result = await client.query(
    `UPDATE app_github_user_credential SET access_token_ciphertext = $3, refresh_token_ciphertext = $4,
       access_expires_at = to_timestamp($5 / 1000.0), refresh_expires_at = to_timestamp($6 / 1000.0), token_version = token_version + 1, updated_at = now()
     WHERE account_id = $1 AND token_version = $2`,
    [row.account_id, Number(row.token_version), cipher.encrypt(pair.accessToken), cipher.encrypt(pair.refreshToken), pair.accessExpiresAt, pair.refreshExpiresAt],
  )
  if (result.rowCount !== 1) throw new Error('GitHub credential changed during refresh.')
}

function rowPair(row: CredentialRow, cipher: ReturnType<typeof credentialCipher>): TokenPair {
  return Object.freeze({ accessToken: cipher.decrypt(row.access_token_ciphertext), refreshToken: cipher.decrypt(row.refresh_token_ciphertext), accessExpiresAt: timestamp(row.access_expires_at), refreshExpiresAt: timestamp(row.refresh_expires_at) })
}

function credentialCipher(encodedKey: string) {
  const key = /^[a-f0-9]{64}$/i.test(encodedKey) ? Buffer.from(encodedKey, 'hex') : Buffer.from(encodedKey, 'base64')
  if (key.byteLength !== 32) throw new Error('GITHUB_APP_CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes.')
  return Object.freeze({
    encrypt(value: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
    },
    decrypt(value: string) {
      const parts = value.split('.')
      if (parts.length !== 3) throw new Error('GitHub credential ciphertext is invalid.')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0]!, 'base64url'))
      decipher.setAuthTag(Buffer.from(parts[1]!, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64url')), decipher.final()]).toString('utf8')
    },
  })
}

function appJwt(appId: string, key: ReturnType<typeof createPrivateKey>, now: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: appId })}`
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`
}

async function githubJson(request: typeof fetch, accessToken: string, path: string, allowNotFound = false): Promise<unknown | null> {
  const response = await request(`https://api.github.com${path}`, { headers: githubHeaders(accessToken) })
  if (allowNotFound && response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub request failed with status ${response.status}.`)
  return limitedJson(response)
}

function githubHeaders(token: string) { return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'comp-canvas-api', 'X-GitHub-Api-Version': '2022-11-28' } }
async function limitedJson(response: Response): Promise<unknown> { const text = await response.text(); if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw new Error('GitHub response is too large.'); try { return JSON.parse(text) as unknown } catch { throw new Error('GitHub returned invalid JSON.') } }

function readInstallation(value: unknown): GitHubInstallationIdentity {
  const input = record(value); const account = record(input.account); const permissions = record(input.permissions)
  if ((account.type !== 'Organization' && account.type !== 'User') || typeof account.login !== 'string' || input.suspended_at) throw new Error('GitHub returned invalid installation data.')
  return Object.freeze({ id: githubId(input.id), account: Object.freeze({ id: githubId(account.id), login: account.login, type: account.type }), contentsPermission: permissionString(permissions.contents) })
}

function readRepository(value: unknown, installationId: string): GitHubRepositoryIdentity {
  const input = record(value); const owner = record(input.owner); const permissions = record(input.permissions)
  if (typeof owner.login !== 'string' || typeof input.name !== 'string' || typeof input.full_name !== 'string' || typeof input.private !== 'boolean') throw new Error('GitHub returned invalid repository data.')
  return Object.freeze({ id: githubId(input.id), installationId, ownerId: githubId(owner.id), ownerLogin: owner.login, name: input.name, fullName: input.full_name, isPrivate: input.private, contentsPermission: repositoryPermission(permissions) })
}

function repositoryPermission(permissions: Record<string, unknown>): RepositoryContentsPermission { return permissions.push === true ? 'write' : permissions.pull === true ? 'read' : 'none' }
function permissionString(value: unknown): RepositoryContentsPermission { return value === 'write' ? 'write' : value === 'read' ? 'read' : 'none' }
function githubId(value: unknown): string { if ((typeof value !== 'number' || !Number.isSafeInteger(value)) && typeof value !== 'string') throw new Error('GitHub returned an invalid identity.'); const result = String(value); if (!/^[1-9][0-9]{0,31}$/.test(result)) throw new Error('GitHub returned an invalid identity.'); return result }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub returned invalid data.'); return value as Record<string, unknown> }
function seconds(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 60 || (value as number) > 366 * 24 * 60 * 60) throw new Error('GitHub returned an invalid token expiry.'); return value as number }
function timestamp(value: Date | string): number { const result = value instanceof Date ? value.getTime() : Date.parse(value); if (!Number.isSafeInteger(result)) throw new Error('Database returned an invalid timestamp.'); return result }

function validateOptions(options: GitHubRuntimeOptions): void {
  if (!/^[1-9][0-9]{0,31}$/.test(options.appId)) throw new Error('GITHUB_APP_ID is invalid.')
  if (!appSlugPattern.test(options.appSlug)) throw new Error('GITHUB_APP_SLUG is invalid.')
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(options.clientId) || options.clientSecret.length < 16) throw new Error('GitHub App OAuth credentials are invalid.')
  if (new TextEncoder().encode(options.webhookSecret).byteLength < 32) throw new Error('GITHUB_APP_WEBHOOK_SECRET must contain at least 32 bytes.')
  const callback = new URL(options.authorizationCallbackUrl)
  if (callback.protocol !== 'https:' && callback.hostname !== 'localhost' && callback.hostname !== '127.0.0.1') throw new Error('GITHUB_APP_AUTHORIZATION_CALLBACK_URL must use HTTPS.')
}
