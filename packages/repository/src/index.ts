export type RepositorySource = 'local' | 'managed-clone'

export type ConnectedRepository = Readonly<{
  id: string
  name: string
  source: RepositorySource
}>

export type GitHubCloneRequest = Readonly<{
  owner: string
  name: string
}>

export type RepositoryConnection = Readonly<{
  repository: ConnectedRepository
  rootPath: string
}>

export function parseGitHubCloneRequest(value: unknown): GitHubCloneRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub repository.')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'name,owner') throw new Error('Invalid GitHub repository.')
  if (typeof record.owner !== 'string' || typeof record.name !== 'string') throw new Error('Invalid GitHub repository.')
  const segment = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/
  if (!segment.test(record.owner) || !segment.test(record.name) || record.owner === '.' || record.name === '.') throw new Error('Invalid GitHub repository.')
  return { owner: record.owner, name: record.name.replace(/\.git$/i, '') }
}
