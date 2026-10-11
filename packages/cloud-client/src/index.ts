export type CloudUser = Readonly<{
  id: string
  name: string
  email: string
  image: string | null
}>

export type CloudFileSummary = Readonly<{
  id: string
  projectId: string | null
  name: string
  headRevision: number
  thumbnailKey: string | null
  createdAt: string
  updatedAt: string
}>

export type CloudDocument<TDocument> = Readonly<{
  fileId: string
  revision: number
  document: TDocument
}>

export type CloudThumbnailMetadata = Readonly<{
  fileId: string
  revision: number
  thumbnailKey: string | null
}>

export type CloudFileShare = Readonly<{
  fileId: string
  access: 'private' | 'view'
  updatedAt: string
}>

export type CloudSharedFile<TDocument> = Readonly<{
  file: Readonly<{ id: string; name: string; headRevision: number; updatedAt: string }>
  fileId: string
  revision: number
  document: TDocument
}>

export class CloudApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly requestId: string

  constructor(message: string, status: number, code: string | null = null, requestId: string = crypto.randomUUID(), options?: ErrorOptions) {
    super(message, options)
    this.name = 'CloudApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export type CloudApiClientOptions<TDocument> = Readonly<{
  apiOrigin: string
  fetch?: typeof fetch
  validateDocument(value: unknown): TDocument
}>

type JsonObject = Record<string, unknown>

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value as JsonObject
}

function exact(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  if (!required.every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Unexpected response fields.')
}

function string(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(`Invalid ${label}.`)
  return value
}

function identifier(value: unknown, label: string): string {
  const result = string(value, label, 80)
  if (!idPattern.test(result)) throw new Error(`Invalid ${label}.`)
  return result
}

function accountIdentifier(value: unknown): string {
  const result = string(value, 'user id', 200)
  if (/\s|[\u0000-\u001f\u007f]/u.test(result)) throw new Error('Invalid user id.')
  return result
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}.`)
  return value as number
}

function nullableString(value: unknown, label: string, maximum = 512): string | null {
  return value === null ? null : string(value, label, maximum)
}

function instant(value: unknown, label: string): string {
  const result = string(value, label, 64)
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Invalid ${label}.`)
  return result
}

function parseOrigin(value: string): string {
  let result: URL
  try { result = new URL(value) } catch { throw new Error('API origin must be an HTTP or HTTPS origin.') }
  if (!['http:', 'https:'].includes(result.protocol) || result.origin !== value || result.username || result.password) throw new Error('API origin must be an HTTP or HTTPS origin.')
  if (result.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(result.hostname)) throw new Error('API origin must use HTTPS outside loopback.')
  return result.origin
}

function parseSummary(value: unknown): CloudFileSummary {
  const result = object(value, 'file')
  exact(result, ['id', 'projectId', 'name', 'headRevision', 'thumbnailKey', 'createdAt', 'updatedAt'])
  return {
    id: identifier(result.id, 'file id'),
    projectId: result.projectId === null ? null : identifier(result.projectId, 'project id'),
    name: string(result.name, 'file name', 120),
    headRevision: integer(result.headRevision, 'file revision'),
    thumbnailKey: nullableString(result.thumbnailKey, 'thumbnail key', 240),
    createdAt: instant(result.createdAt, 'created time'),
    updatedAt: instant(result.updatedAt, 'updated time'),
  }
}

function parseThumbnail(value: unknown, fileId: string, expectedRevision: number): CloudThumbnailMetadata {
  const result = object(value, 'thumbnail')
  exact(result, ['fileId', 'revision', 'thumbnailKey'])
  const responseFileId = identifier(result.fileId, 'file id')
  const revision = integer(result.revision, 'thumbnail revision')
  if (responseFileId !== fileId) throw new Error('The server returned a thumbnail for another file.')
  if (revision !== expectedRevision) throw new Error('The server returned a thumbnail for another revision.')
  const thumbnailKey = nullableString(result.thumbnailKey, 'thumbnail key', 512)
  if (thumbnailKey !== null && thumbnailKey !== `thumbnails/${fileId}/thumbnail.avif`) throw new Error('The server returned an invalid thumbnail key.')
  return { fileId: responseFileId, revision, thumbnailKey }
}

function parseShare(value: unknown, expectedFileId: string): CloudFileShare {
  const result = object(value, 'share')
  exact(result, ['fileId', 'access', 'updatedAt'])
  const fileId = identifier(result.fileId, 'file id')
  if (fileId !== expectedFileId) throw new Error('The server returned sharing for another file.')
  if (result.access !== 'private' && result.access !== 'view') throw new Error('Invalid share access.')
  return { fileId, access: result.access, updatedAt: instant(result.updatedAt, 'updated time') }
}

async function responseJson(response: Response, requestId: string): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) throw new CloudApiError('The server returned an invalid response.', response.status, 'invalid_response', requestId)
  try { return await response.json() as unknown } catch (error) { throw new CloudApiError('The server returned invalid JSON.', response.status, 'invalid_response', requestId, { cause: error }) }
}

async function checked(response: Response, fallbackRequestId: string): Promise<unknown> {
  const headerRequestId = response.headers.get('X-Canvas-Request-Id')
  const requestId = headerRequestId && idPattern.test(headerRequestId) ? headerRequestId : fallbackRequestId
  const value = await responseJson(response, requestId)
  if (response.ok) return value
  const body = object(value, 'error response')
  const error = object(body.error, 'error response')
  const message = typeof error.message === 'string' && error.message.length <= 300 ? error.message : 'The request could not be completed.'
  const code = typeof error.code === 'string' && error.code.length <= 80 ? error.code : null
  throw new CloudApiError(message, response.status, code, requestId)
}

function jsonRequest(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export function createCloudApiClient<TDocument>(options: CloudApiClientOptions<TDocument>) {
  const origin = parseOrigin(options.apiOrigin)
  const request = options.fetch ?? fetch
  const call = async (path: string, init?: RequestInit) => {
    const requestId = crypto.randomUUID()
    const headers = new Headers(init?.headers)
    headers.set('X-Canvas-Request-Id', requestId)
    try {
      return await checked(await request(`${origin}${path}`, { credentials: 'include', ...init, headers }), requestId)
    } catch (error) {
      if (error instanceof CloudApiError) throw error
      throw new CloudApiError('The service could not be reached.', 0, 'network_error', requestId, { cause: error })
    }
  }

  return Object.freeze({
    async session(): Promise<CloudUser> {
      const body = object(await call('/api/session'), 'session response')
      exact(body, ['user'])
      const user = object(body.user, 'user')
      exact(user, ['id', 'name', 'email', 'image'])
      return { id: accountIdentifier(user.id), name: string(user.name, 'user name', 120), email: string(user.email, 'user email', 320), image: nullableString(user.image, 'user image', 2_048) }
    },
    async listFiles(): Promise<readonly CloudFileSummary[]> {
      const body = object(await call('/api/files'), 'files response')
      exact(body, ['files'])
      if (!Array.isArray(body.files) || body.files.length > 10_000) throw new Error('Invalid files response.')
      return body.files.map(parseSummary)
    },
    async createFile(input: Readonly<{ name?: string; projectId?: string | null }> = {}): Promise<CloudFileSummary> {
      if (input.name !== undefined && (input.name.trim().length === 0 || input.name.length > 120)) throw new Error('Invalid file name.')
      if (input.projectId !== undefined && input.projectId !== null) identifier(input.projectId, 'project id')
      const body = object(await call('/api/files', jsonRequest('POST', input)), 'file response')
      exact(body, ['file'])
      return parseSummary(body.file)
    },
    async openFile(fileId: string): Promise<CloudFileSummary> {
      const id = identifier(fileId, 'file id')
      const body = object(await call(`/api/files/${encodeURIComponent(id)}`), 'file response')
      exact(body, ['file'])
      return parseSummary(body.file)
    },
    async openDocument(fileId: string): Promise<CloudDocument<TDocument>> {
      const id = identifier(fileId, 'file id')
      const body = object(await call(`/api/files/${encodeURIComponent(id)}/document`), 'document response')
      exact(body, ['fileId', 'revision', 'document'])
      const responseFileId = identifier(body.fileId, 'file id')
      if (responseFileId !== id) throw new Error('The server returned a document for another file.')
      return { fileId: responseFileId, revision: integer(body.revision, 'document revision'), document: options.validateDocument(body.document) }
    },
    async saveDocument(fileId: string, document: TDocument, expectedRevision: number): Promise<CloudDocument<TDocument>> {
      const id = identifier(fileId, 'file id')
      integer(expectedRevision, 'expected revision')
      const body = object(await call(`/api/files/${encodeURIComponent(id)}/document`, jsonRequest('PUT', { expectedRevision, document })), 'document response')
      exact(body, ['fileId', 'revision', 'document'])
      const responseFileId = identifier(body.fileId, 'file id')
      if (responseFileId !== id) throw new Error('The server returned a document for another file.')
      return { fileId: responseFileId, revision: integer(body.revision, 'document revision'), document: options.validateDocument(body.document) }
    },
    async setThumbnail(fileId: string, expectedRevision: number, thumbnailKey: string): Promise<CloudThumbnailMetadata> {
      const id = identifier(fileId, 'file id')
      integer(expectedRevision, 'expected revision')
      if (thumbnailKey !== `thumbnails/${id}/thumbnail.avif`) throw new Error('Invalid thumbnail key.')
      return updateThumbnail(id, expectedRevision, thumbnailKey)
    },
    async clearThumbnail(fileId: string, expectedRevision: number): Promise<CloudThumbnailMetadata> {
      const id = identifier(fileId, 'file id')
      integer(expectedRevision, 'expected revision')
      return updateThumbnail(id, expectedRevision, null)
    },
    async getFileShare(fileId: string): Promise<CloudFileShare> {
      const id = identifier(fileId, 'file id')
      const body = object(await call(`/api/files/${encodeURIComponent(id)}/share`), 'share response')
      exact(body, ['share'])
      return parseShare(body.share, id)
    },
    async setFileShare(fileId: string, access: 'private' | 'view'): Promise<CloudFileShare> {
      const id = identifier(fileId, 'file id')
      if (access !== 'private' && access !== 'view') throw new Error('Invalid share access.')
      const body = object(await call(`/api/files/${encodeURIComponent(id)}/share`, jsonRequest('PUT', { access })), 'share response')
      exact(body, ['share'])
      return parseShare(body.share, id)
    },
    async openSharedFile(fileId: string): Promise<CloudSharedFile<TDocument>> {
      const id = identifier(fileId, 'file id')
      const body = object(await call(`/api/shared/files/${encodeURIComponent(id)}`), 'shared file response')
      exact(body, ['file', 'fileId', 'revision', 'document'])
      const file = object(body.file, 'shared file')
      exact(file, ['id', 'name', 'headRevision', 'updatedAt'])
      const responseFileId = identifier(body.fileId, 'file id')
      const metadataId = identifier(file.id, 'file id')
      if (responseFileId !== id || metadataId !== id) throw new Error('The server returned another shared file.')
      const revision = integer(body.revision, 'document revision')
      const headRevision = integer(file.headRevision, 'file revision')
      if (revision !== headRevision) throw new Error('The server returned mismatched shared revisions.')
      return {
        file: { id: metadataId, name: string(file.name, 'file name', 120), headRevision, updatedAt: instant(file.updatedAt, 'updated time') },
        fileId: responseFileId,
        revision,
        document: options.validateDocument(body.document),
      }
    },
  })

  async function updateThumbnail(fileId: string, expectedRevision: number, thumbnailKey: string | null): Promise<CloudThumbnailMetadata> {
    const body = object(await call(`/api/files/${encodeURIComponent(fileId)}/thumbnail`, jsonRequest('PUT', { expectedRevision, thumbnailKey })), 'thumbnail response')
    exact(body, ['thumbnail'])
    return parseThumbnail(body.thumbnail, fileId, expectedRevision)
  }
}
