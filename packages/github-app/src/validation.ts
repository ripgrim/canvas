import type { GitHubActor, GitHubInstallationIdentity, GitHubRepositoryIdentity } from './contracts.js'

export type GitHubAppErrorCode =
  | 'DUPLICATE_DELIVERY'
  | 'EXPIRED_STATE'
  | 'INSTALLATION_NOT_ACTIVE'
  | 'INSTALLATION_NOT_VISIBLE'
  | 'INVALID_IDENTITY'
  | 'INVALID_STATE'
  | 'INVALID_WEBHOOK'
  | 'INVALID_WEBHOOK_SIGNATURE'
  | 'REPOSITORY_NOT_VISIBLE'

export class GitHubAppError extends Error {
  readonly name = 'GitHubAppError'

  constructor(readonly code: GitHubAppErrorCode, message: string) {
    super(message)
  }
}

const githubIdPattern = /^[1-9][0-9]{0,31}$/
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const repositoryNamePattern = /^[A-Za-z0-9._-]{1,100}$/

export function githubId(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new GitHubAppError('INVALID_IDENTITY', 'Invalid GitHub identity.')
  const result = String(value)
  if (!githubIdPattern.test(result) || (typeof value === 'number' && !Number.isSafeInteger(value))) throw new GitHubAppError('INVALID_IDENTITY', 'Invalid GitHub identity.')
  return result
}

export function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !opaqueIdPattern.test(value)) throw new GitHubAppError('INVALID_IDENTITY', 'Invalid identity.')
  return value
}

export function validateActor(actor: GitHubActor): GitHubActor {
  return { accountId: opaqueId(actor.accountId), providerUserId: githubId(actor.providerUserId) }
}

export function validateInstallation(value: GitHubInstallationIdentity): GitHubInstallationIdentity {
  const id = githubId(value.id)
  const accountId = githubId(value.account.id)
  if (!loginPattern.test(value.account.login) || !['Organization', 'User'].includes(value.account.type)) throw new GitHubAppError('INVALID_IDENTITY', 'Invalid GitHub installation.')
  const contentsPermission = permission(value.contentsPermission)
  return { id, account: { id: accountId, login: value.account.login, type: value.account.type }, contentsPermission }
}

export function validateRepository(value: GitHubRepositoryIdentity): GitHubRepositoryIdentity {
  const id = githubId(value.id)
  const installationId = githubId(value.installationId)
  const ownerId = githubId(value.ownerId)
  if (!loginPattern.test(value.ownerLogin) || !repositoryNamePattern.test(value.name)) throw new GitHubAppError('INVALID_IDENTITY', 'Invalid GitHub repository.')
  if (value.fullName.toLocaleLowerCase('en-US') !== `${value.ownerLogin}/${value.name}`.toLocaleLowerCase('en-US')) throw new GitHubAppError('INVALID_IDENTITY', 'Invalid GitHub repository.')
  return { id, installationId, ownerId, ownerLogin: value.ownerLogin, name: value.name, fullName: value.fullName, isPrivate: value.isPrivate, contentsPermission: permission(value.contentsPermission) }
}

function permission(value: unknown): 'none' | 'read' | 'write' {
  if (value !== 'none' && value !== 'read' && value !== 'write') throw new GitHubAppError('INVALID_IDENTITY', 'Invalid GitHub permission.')
  return value
}

export function assertLiveRepositoryIntersection(input: Readonly<{
  installationId: string
  repositoryId: string
  visibleInstallations: readonly GitHubInstallationIdentity[]
  repository: GitHubRepositoryIdentity | null
}>): Readonly<{ installation: GitHubInstallationIdentity; repository: GitHubRepositoryIdentity }> {
  const installationId = githubId(input.installationId)
  const repositoryId = githubId(input.repositoryId)
  const installation = input.visibleInstallations.map(validateInstallation).find(candidate => candidate.id === installationId)
  if (!installation) throw new GitHubAppError('INSTALLATION_NOT_VISIBLE', 'GitHub installation is not available.')
  if (!input.repository) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
  const repository = validateRepository(input.repository)
  if (repository.id !== repositoryId || repository.installationId !== installationId) throw new GitHubAppError('REPOSITORY_NOT_VISIBLE', 'GitHub repository is not available.')
  return { installation, repository }
}
