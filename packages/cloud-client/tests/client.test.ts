import { describe, expect, it, vi } from 'vitest'
import { CloudApiError, createCloudApiClient } from '../src/index'

const file = {
  id: '11111111-2222-4333-8444-555555555555', projectId: null, name: 'Untitled 1', headRevision: 0, thumbnailKey: null,
  createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
}

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('cloud api client', () => {
  it('accepts the opaque account ids issued by the auth service', async () => {
    const user = { id: 'better-auth-user_01', name: 'Ada', email: 'ada@example.test', image: null }
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ user })) as typeof fetch, validateDocument: value => value })

    await expect(client.session()).resolves.toEqual(user)
  })

  it('rejects unsafe account ids returned by the auth service', async () => {
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ user: { id: 'user\nforeign', name: 'Ada', email: 'ada@example.test', image: null } })) as typeof fetch, validateDocument: value => value })

    await expect(client.session()).rejects.toThrow('Invalid user id')
  })

  it('uses fixed credentialed routes for file metadata and revisioned documents', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      if (String(url).endsWith('/api/files')) return response(init?.method === 'POST' ? { file } : { files: [file] }, init?.method === 'POST' ? 201 : 200)
      if (String(url).endsWith('/document')) return response({ fileId: file.id, revision: init?.method === 'PUT' ? 1 : 0, document: { schemaVersion: 2 } })
      return response({ file })
    })
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value as { schemaVersion: number } })
    expect(await client.listFiles()).toEqual([file])
    expect(await client.createFile()).toEqual(file)
    expect(await client.openFile(file.id)).toEqual(file)
    expect(await client.openDocument(file.id)).toEqual({ fileId: file.id, revision: 0, document: { schemaVersion: 2 } })
    expect(await client.saveDocument(file.id, { schemaVersion: 2 }, 0)).toEqual({ fileId: file.id, revision: 1, document: { schemaVersion: 2 } })
    expect(requests.map(item => item.url)).toEqual([
      'https://api.canvas.test/api/files',
      'https://api.canvas.test/api/files',
      'https://api.canvas.test/api/files/11111111-2222-4333-8444-555555555555',
      'https://api.canvas.test/api/files/11111111-2222-4333-8444-555555555555/document',
      'https://api.canvas.test/api/files/11111111-2222-4333-8444-555555555555/document',
    ])
    expect(requests.every(item => item.init?.credentials === 'include')).toBe(true)
  })

  it('rejects non-loopback HTTP origins and path-like ids before fetch', async () => {
    expect(() => createCloudApiClient({ apiOrigin: 'http://api.canvas.test', validateDocument: value => value })).toThrow('HTTPS')
    const fetcher = vi.fn()
    const client = createCloudApiClient({ apiOrigin: 'http://127.0.0.1:4320', fetch: fetcher as typeof fetch, validateDocument: value => value })
    await expect(client.openFile('../foreign')).rejects.toThrow('Invalid file id')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('surfaces stale revisions without accepting malformed success payloads', async () => {
    const conflict = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ error: { code: 'stale_revision', message: 'Document conflict.' } }, 409)) as typeof fetch, validateDocument: value => value })
    await expect(conflict.saveDocument(file.id, {}, 0)).rejects.toMatchObject({ status: 409, code: 'stale_revision' } satisfies Partial<CloudApiError>)
    const wrongFile = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ fileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', revision: 1, document: {} })) as typeof fetch, validateDocument: value => value })
    await expect(wrongFile.openDocument(file.id)).rejects.toThrow('another file')
  })

  it('ERROR-VISIBILITY-001 carries one request id through the request and public API failure', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requestId = new Headers(init?.headers).get('X-Canvas-Request-Id')
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
      return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Request could not be completed.', requestId } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'X-Canvas-Request-Id': requestId! },
      })
    })
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value })
    await expect(client.listFiles()).rejects.toMatchObject({ status: 500, code: 'internal_error', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) } satisfies Partial<CloudApiError>)
  })

  it('ERROR-VISIBILITY-001 assigns a request id when the network fails before a response', async () => {
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch, validateDocument: value => value })
    await expect(client.listFiles()).rejects.toMatchObject({ status: 0, code: 'network_error', message: 'The service could not be reached.', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) } satisfies Partial<CloudApiError>)
  })

  it('AT-THUMB-001 sets and clears only the stable thumbnail key for the expected revision', async () => {
    const key = `thumbnails/${file.id}/thumbnail.avif`
    const requests: Array<{ url: string; body: unknown }> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)) as { expectedRevision: number; thumbnailKey: string | null }
      requests.push({ url: String(url), body: input })
      return response({ thumbnail: { fileId: file.id, revision: input.expectedRevision, thumbnailKey: input.thumbnailKey } })
    })
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value })

    expect(await client.setThumbnail(file.id, 3, key)).toEqual({ fileId: file.id, revision: 3, thumbnailKey: key })
    expect(await client.clearThumbnail(file.id, 3)).toEqual({ fileId: file.id, revision: 3, thumbnailKey: null })
    expect(requests).toEqual([
      { url: `https://api.canvas.test/api/files/${file.id}/thumbnail`, body: { expectedRevision: 3, thumbnailKey: key } },
      { url: `https://api.canvas.test/api/files/${file.id}/thumbnail`, body: { expectedRevision: 3, thumbnailKey: null } },
    ])
    expect(fetcher.mock.calls.every(([, init]) => init?.credentials === 'include' && init.method === 'PUT')).toBe(true)

    await expect(client.setThumbnail(file.id, 3, '../thumbnail.avif')).rejects.toThrow('Invalid thumbnail key')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('AT-THUMB-001 rejects thumbnail metadata for another file or revision', async () => {
    const key = `thumbnails/${file.id}/thumbnail.avif`
    const wrongRevision = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ thumbnail: { fileId: file.id, revision: 4, thumbnailKey: key } })) as typeof fetch, validateDocument: value => value })
    await expect(wrongRevision.setThumbnail(file.id, 3, key)).rejects.toThrow('another revision')
    const wrongFile = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ thumbnail: { fileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', revision: 3, thumbnailKey: key } })) as typeof fetch, validateDocument: value => value })
    await expect(wrongFile.setThumbnail(file.id, 3, key)).rejects.toThrow('another file')
  })

  it('AT-SHARE-003 uses exact credentialed share routes and validates the read snapshot', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const input = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: String(url), method, body: input })
      if (String(url).endsWith('/share')) return response({ share: { fileId: file.id, access: input?.access ?? 'private', updatedAt: file.updatedAt } })
      return response({ file: { id: file.id, name: file.name, headRevision: 0, updatedAt: file.updatedAt }, fileId: file.id, revision: 0, document: { schemaVersion: 9 } })
    })
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value as { schemaVersion: number } })

    expect(await client.getFileShare(file.id)).toMatchObject({ access: 'private' })
    expect(await client.setFileShare(file.id, 'view')).toMatchObject({ access: 'view' })
    expect(await client.openSharedFile(file.id)).toMatchObject({ file: { id: file.id, name: file.name }, fileId: file.id, revision: 0, document: { schemaVersion: 9 } })
    expect(calls).toEqual([
      { url: `https://api.canvas.test/api/files/${file.id}/share`, method: 'GET', body: null },
      { url: `https://api.canvas.test/api/files/${file.id}/share`, method: 'PUT', body: { access: 'view' } },
      { url: `https://api.canvas.test/api/shared/files/${file.id}`, method: 'GET', body: null },
    ])
    expect(fetcher.mock.calls.every(([, init]) => init?.credentials === 'include')).toBe(true)
  })

  it('AT-REPO-LINK-001 validates GitHub handoff, choices, and the exact linked repository', async () => {
    const projectId = file.id
    const repository = { id: '4001', ownerLogin: 'canvas-team', name: 'design-system', fullName: 'canvas-team/design-system', isPrivate: true }
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const input = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: String(url), method, body: input })
      if (String(url).endsWith('/api/github/installations/start')) return response({ installationUrl: 'https://github.com/apps/comp-canvas/installations/new?state=opaque', expiresAt: file.updatedAt }, 201)
      if (String(url).includes('/repositories?')) return response({ installationId: '2001', repositories: [repository] })
      return response({ installationId: '2001', repository })
    })
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value })

    expect(await client.startGitHubInstallation('https://editor.canvas.test/file/current?pageId=page-1')).toMatchObject({ installationUrl: expect.stringContaining('github.com/apps/comp-canvas') })
    expect(await client.listGitHubRepositories(projectId, '2001')).toEqual([repository])
    expect(await client.getGitHubRepository(projectId)).toEqual({ installationId: '2001', repository })
    expect(await client.linkGitHubRepository(projectId, '2001', '4001')).toEqual({ installationId: '2001', repository })
    expect(calls).toEqual([
      { url: 'https://api.canvas.test/api/github/installations/start', method: 'POST', body: { returnTo: 'https://editor.canvas.test/file/current?pageId=page-1' } },
      { url: `https://api.canvas.test/api/projects/${projectId}/repositories?installationId=2001`, method: 'GET', body: null },
      { url: `https://api.canvas.test/api/projects/${projectId}/repository`, method: 'GET', body: null },
      { url: `https://api.canvas.test/api/projects/${projectId}/repository`, method: 'PUT', body: { installationId: '2001', repositoryId: '4001' } },
    ])
  })

  it('AT-REPO-LINK-001 rejects a mismatched repository response', async () => {
    const client = createCloudApiClient({
      apiOrigin: 'https://api.canvas.test',
      fetch: (async () => response({ installationId: '2001', repository: { id: '4999', ownerLogin: 'other', name: 'repo', fullName: 'other/repo', isPrivate: false } })) as typeof fetch,
      validateDocument: value => value,
    })
    await expect(client.linkGitHubRepository(file.id, '2001', '4001')).rejects.toThrow('another repository')
  })

  it('AT-REPO-SCAN-001 starts and reads a completed hosted scan without exposing credentials', async () => {
    const jobId = '00000000-0000-4000-8000-000000000021'
    const artifact = { sourceRevision: 'a'.repeat(40), scan: { adapterId: 'shadcn-v1', components: [] }, request: { version: 1 } }
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => response(String(url).endsWith('/repository/jobs') && init?.method === 'POST'
      ? { job: { id: jobId, operation: 'scan', status: 'queued', attempt: 0 } }
      : { job: { id: jobId, operation: 'scan', status: 'completed', attempt: 1, result: artifact, completedAt: file.updatedAt } }))
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value })

    expect(await client.startGitHubRepositoryScan(file.id)).toEqual({ id: jobId, status: 'queued', attempt: 0, result: null })
    expect(await client.getGitHubRepositoryScan(jobId)).toEqual({ id: jobId, status: 'completed', attempt: 1, result: artifact })
    expect(await client.getLatestGitHubRepositoryScan(file.id)).toEqual({ id: jobId, status: 'completed', attempt: 1, result: artifact })
    const empty = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ job: null })) as typeof fetch, validateDocument: value => value })
    expect(await empty.getLatestGitHubRepositoryScan(file.id)).toBeNull()
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('accessToken')
  })

  it('AT-REPO-SCAN-001 preserves a safe terminal scan error id', async () => {
    const jobId = '00000000-0000-4000-8000-000000000022'
    const client = createCloudApiClient({
      apiOrigin: 'https://api.canvas.test',
      fetch: (async () => response({ job: { id: jobId, operation: 'scan', status: 'failed', attempt: 3, errorId: 'repository-scan-failed', failedAt: file.updatedAt } })) as typeof fetch,
      validateDocument: value => value,
    })
    await expect(client.getGitHubRepositoryScan(jobId)).resolves.toEqual({ id: jobId, status: 'failed', attempt: 3, errorId: 'repository-scan-failed', result: null })
  })

  it('COMP-V2-DOCS-005 prepares and reads a repository-owned documentation review without a client adapter', async () => {
    const projectId = file.id
    const reviewId = '00000000-0000-4000-8000-000000000031'
    const scanJobId = '00000000-0000-4000-8000-000000000032'
    const digest = 'd'.repeat(64)
    const bundle = {
      version: 1, projectId, fileId: file.id, fileRevision: 3, fileDocumentSha256: 'b'.repeat(64), scanJobId,
      installationId: '2001', repositoryId: '4001', repositoryGrantId: '00000000-0000-4000-8000-000000000033', repositoryLinkedAt: 1,
      baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), baseTreeSha: 'c'.repeat(40),
      adapter: { version: 1, renderer: 'blume', layout: {}, components: [] },
      files: [{ path: 'apps/docs/content/docs/button.mdx', beforeSha256: null, after: '# Button\n', diff: '+# Button\n' }],
      omissions: [], validation: [{ name: 'Documentation build', detail: 'Passed.' }],
    }
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const input = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: String(url), method, body: input })
      const saving = String(url).endsWith('/save')
      return response({ review: {
        id: reviewId, projectId, fileId: file.id, fileRevision: 3,
        status: method === 'POST' && !saving ? 'queued_prepare' : saving ? 'queued_save' : 'prepared',
        baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40),
        approvalDigest: method === 'POST' && !saving ? null : digest,
        preparedBundle: method === 'POST' && !saving ? null : bundle,
        committedSha: null,
        errorId: null,
      } }, method === 'GET' ? 200 : 202)
    })
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value })

    await expect(client.startRepositoryDocsReview({ projectId, fileId: file.id, fileRevision: 3, scanJobId })).resolves.toMatchObject({ id: reviewId, status: 'queued_prepare' })
    await expect(client.getLatestRepositoryDocsReview(projectId, file.id)).resolves.toMatchObject({ id: reviewId, status: 'prepared' })
    await expect(client.getRepositoryDocsReview(reviewId)).resolves.toMatchObject({ status: 'prepared', approvalDigest: digest, preparedBundle: { files: [{ path: 'apps/docs/content/docs/button.mdx' }] } })
    await expect(client.saveRepositoryDocsReview(reviewId, digest)).resolves.toMatchObject({ status: 'queued_save', approvalDigest: digest })
    expect(calls).toEqual([
      { url: `https://api.canvas.test/api/projects/${projectId}/repository/docs/reviews`, method: 'POST', body: { fileId: file.id, fileRevision: 3, scanJobId } },
      { url: `https://api.canvas.test/api/projects/${projectId}/repository/docs/reviews?fileId=${file.id}`, method: 'GET', body: null },
      { url: `https://api.canvas.test/api/repository-doc-reviews/${reviewId}`, method: 'GET', body: null },
      { url: `https://api.canvas.test/api/repository-doc-reviews/${reviewId}/save`, method: 'POST', body: { approvalDigest: digest } },
    ])
    expect(JSON.stringify(calls)).not.toContain('adapter')
  })

  it.each([
    ['project', { projectId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', fileId: file.id }],
    ['file', { projectId: file.id, fileId: 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb' }],
  ])('COMP-V2-DOCS-NEG-002 rejects a latest review for another %s', async (_scope, identity) => {
    const review = {
      id: '00000000-0000-4000-8000-000000000035',
      ...identity,
      fileRevision: 3,
      status: 'queued_prepare',
      baseRef: 'refs/heads/main',
      baseCommitSha: 'a'.repeat(40),
      approvalDigest: null,
      preparedBundle: null,
      committedSha: null,
      errorId: null,
    }
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ review })) as typeof fetch, validateDocument: value => value })

    await expect(client.getLatestRepositoryDocsReview(file.id, file.id)).rejects.toThrow('The server returned another repository documentation review.')
  })

  it('COMP-V2-DOCS-005 requires an exact commit identity for a saved documentation review', async () => {
    const reviewId = '00000000-0000-4000-8000-000000000034'
    const saved = {
      id: reviewId, projectId: file.id, fileId: file.id, fileRevision: 3, status: 'saved',
      baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), approvalDigest: 'd'.repeat(64),
      preparedBundle: {
        version: 1, projectId: file.id, fileId: file.id, fileRevision: 3, fileDocumentSha256: 'b'.repeat(64), scanJobId: '00000000-0000-4000-8000-000000000032',
        installationId: '2001', repositoryId: '4001', repositoryGrantId: '00000000-0000-4000-8000-000000000033', repositoryLinkedAt: 1,
        baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), baseTreeSha: 'c'.repeat(40), adapter: { version: 1, renderer: 'blume', layout: {}, components: [] },
        files: [{ path: 'apps/docs/content/docs/button.mdx', beforeSha256: null, after: '# Button\n', diff: '+# Button\n' }], omissions: [], validation: [{ name: 'Documentation build', detail: 'Passed.' }],
      },
      committedSha: 'e'.repeat(40), errorId: null,
    }
    const valid = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ review: saved })) as typeof fetch, validateDocument: value => value })
    await expect(valid.getRepositoryDocsReview(reviewId)).resolves.toMatchObject({ status: 'saved', committedSha: 'e'.repeat(40) })

    const missingCommit = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ review: { ...saved, committedSha: null } })) as typeof fetch, validateDocument: value => value })
    await expect(missingCommit.getRepositoryDocsReview(reviewId)).rejects.toThrow('Incomplete repository documentation save result.')
  })

  it('COMP-V2-CODE-008 returns one exact short-lived hosted preview capability', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000801'
    const previewUrl = `https://preview.canvas.test/hosted/${artifactId}/header.payload/index.html`
    const fetcher = vi.fn(async () => response({ preview: { artifactId, url: previewUrl, expiresAt: 1_800_000_120 } }, 201))
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', hostedPreviewOrigin: 'https://preview.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value })

    await expect(client.getHostedPreview(file.id, artifactId)).resolves.toEqual({ artifactId, url: previewUrl, expiresAt: 1_800_000_120 })
    expect(fetcher).toHaveBeenCalledWith(`https://api.canvas.test/api/files/${file.id}/hosted-preview-capability`, expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ artifactId }),
    }))
  })

  it('COMP-V2-CODE-011 starts and reads only the exact file-scoped hosted build', async () => {
    const jobId = '00000000-0000-4000-8000-000000000811'
    const artifactId = '00000000-0000-4000-8000-000000000812'
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const input = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: String(url), method, body: input })
      return response({ job: method === 'POST'
        ? { id: jobId, fileId: file.id, fileRevision: 3, status: 'queued', attempts: 0, createdAt: file.updatedAt }
        : { id: jobId, fileId: file.id, fileRevision: 3, status: 'completed', attempts: 1, createdAt: file.updatedAt, artifactId, completedAt: file.updatedAt } })
    })
    const client = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: fetcher as typeof fetch, validateDocument: value => value })

    await expect(client.startHostedPreviewBuild(file.id)).resolves.toMatchObject({ id: jobId, fileId: file.id, status: 'queued' })
    await expect(client.getHostedPreviewBuild(jobId)).resolves.toMatchObject({ id: jobId, fileId: file.id, status: 'completed', artifactId })
    expect(calls).toEqual([
      { url: `https://api.canvas.test/api/files/${file.id}/hosted-preview-builds`, method: 'POST', body: {} },
      { url: `https://api.canvas.test/api/hosted-preview-builds/${jobId}`, method: 'GET', body: null },
    ])
  })

  it('COMP-V2-CODE-011 rejects a hosted build for another file or job', async () => {
    const jobId = '00000000-0000-4000-8000-000000000813'
    const other = '00000000-0000-4000-8000-000000000814'
    const wrongFile = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ job: { id: jobId, fileId: other, fileRevision: 0, status: 'queued', attempts: 0, createdAt: file.updatedAt } })) as typeof fetch, validateDocument: value => value })
    await expect(wrongFile.startHostedPreviewBuild(file.id)).rejects.toThrow('another hosted preview build file')
    const wrongJob = createCloudApiClient({ apiOrigin: 'https://api.canvas.test', fetch: (async () => response({ job: { id: other, fileId: file.id, fileRevision: 0, status: 'queued', attempts: 0, createdAt: file.updatedAt } })) as typeof fetch, validateDocument: value => value })
    await expect(wrongJob.getHostedPreviewBuild(jobId)).rejects.toThrow('another hosted preview build')
  })

  it('COMP-V2-CODE-008 rejects redirected or mismatched hosted preview locations', async () => {
    const artifactId = 'a0000000-0000-4000-8000-000000000802'
    const create = (preview: object) => createCloudApiClient({
      apiOrigin: 'https://api.canvas.test',
      hostedPreviewOrigin: 'https://preview.canvas.test',
      fetch: (async () => response({ preview }, 201)) as typeof fetch,
      validateDocument: value => value,
    })
    await expect(create({ artifactId, url: `https://other.test/hosted/${artifactId}/header.payload/index.html`, expiresAt: 1 }).getHostedPreview(file.id, artifactId)).rejects.toThrow('Invalid hosted preview URL')
    await expect(create({ artifactId, url: `https://preview.canvas.test/hosted/${artifactId}/header.payload/index.html?token=leak`, expiresAt: 1 }).getHostedPreview(file.id, artifactId)).rejects.toThrow('Invalid hosted preview URL')
    await expect(create({ artifactId: '00000000-0000-4000-8000-000000000803', url: `https://preview.canvas.test/hosted/${artifactId}/header.payload/index.html`, expiresAt: 1 }).getHostedPreview(file.id, artifactId)).rejects.toThrow('another hosted preview artifact')
    await expect(create({ artifactId, url: `https://preview.canvas.test/hosted/${artifactId}/header.payload/../secret.js`, expiresAt: 1 }).getHostedPreview(file.id, artifactId)).rejects.toThrow('Invalid hosted preview URL')
    await expect(create({ artifactId, url: `https://preview.canvas.test/hosted/${artifactId}/header.payload/assets//component.js`, expiresAt: 1 }).getHostedPreview(file.id, artifactId)).rejects.toThrow('Invalid hosted preview URL')
    await expect(create({ artifactId, url: `https://preview.canvas.test/hosted/${artifactId}/header.payload/index.html/`, expiresAt: 1 }).getHostedPreview(file.id, artifactId)).rejects.toThrow('Invalid hosted preview URL')
    await expect(create({ artifactId, url: `https://preview.canvas.test/hosted/${artifactId.toUpperCase()}/header.payload/index.html`, expiresAt: 1 }).getHostedPreview(file.id, artifactId)).rejects.toThrow('Invalid hosted preview URL')
  })
})
