import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorHostedRepositoryConnection, EditorProjectApi, EditorRepositoryDocsReview } from '../../capabilities'
import { editorStore } from './store'
import { createHostedRepositoryService } from './hosted-repository-service'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { createDocumentStore } from './document-store'

const repository = Object.freeze({ id: '42', ownerLogin: 'canvas', name: 'editor', fullName: 'canvas/editor', isPrivate: true })
const connection: EditorHostedRepositoryConnection = Object.freeze({ installationId: '7', repository })
const componentId = 'shadcn:Button:1234567890abcdef'
const scanResult = Object.freeze({
  jobId: '00000000-0000-4000-8000-000000000092',
  adapterId: 'shadcn-v1',
  sourceRevision: 'a'.repeat(40),
  componentCount: 1,
  registry: {
    fingerprint: `github:${'a'.repeat(40)}`,
    components: [{ componentId, symbolKey: componentId, path: 'components/ui/button.tsx', exportName: 'Button', packageName: '@acme/ui', sourceHash: 'b'.repeat(64), fingerprint: 'c'.repeat(64), props: [{ name: 'tone', type: "'quiet' | 'solid'", optional: false }], slots: [] }],
  },
})

function source() {
  let projectId: string | null = null
  const listeners = new Set<() => void>()
  return {
    store: {
      subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
      getSnapshot: () => ({ snapshot: projectId ? { projectId } : null } as ReturnType<typeof editorStore.getSnapshot>),
    },
    open(next: string) { projectId = next; listeners.forEach(listener => listener()) },
  }
}

function project(hostedRepository: Partial<NonNullable<EditorProjectApi['hostedRepository']>>, hostedExecution?: EditorProjectApi['hostedExecution']): EditorProjectApi {
  return {
    hostedRepository: {
      getLatestDocsReview: vi.fn(async () => null),
      prepareDocs: vi.fn(),
      getDocsReview: vi.fn(),
      ...hostedRepository,
    } as NonNullable<EditorProjectApi['hostedRepository']>,
    ...(hostedExecution ? { hostedExecution } : {}),
  } as EditorProjectApi
}

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

describe('hosted repository service', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('loads the connected repository only after a project opens', async () => {
    const projects = source()
    const documents = createDocumentStore()
    documents.load(createBlankFile('restored-file', 'page', 'root', 'Page'), [], { replace: true })
    const getConnection = vi.fn(async () => connection)
    const getLatestScan = vi.fn(async () => scanResult)
    const restoredReview: EditorRepositoryDocsReview = {
      id: '00000000-0000-4000-8000-000000000604', fileId: 'restored-file', fileRevision: 1,
      status: 'saved', baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), approvalDigest: 'b'.repeat(64),
      preparedBundle: { files: [{ path: 'apps/docs/content/docs/components/button.mdx', diff: '+# Button' }], omissions: [], validation: [{ name: 'blume-check', detail: 'Passed' }] },
      committedSha: 'c'.repeat(40), errorId: null,
    }
    const getLatestDocsReview = vi.fn(async () => restoredReview)
    const service = createHostedRepositoryService(projects.store, documents)
    service.configure(project({ returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(), getConnection, getLatestScan, getLatestDocsReview, link: vi.fn(), scan: vi.fn() }))
    expect(service.getSnapshot()).toMatchObject({ available: true, status: 'idle' })
    expect(getConnection).not.toHaveBeenCalled()

    projects.open('project-a')
    await settle()

    expect(getConnection).toHaveBeenCalledOnce()
    expect(getLatestScan).toHaveBeenCalledOnce()
    expect(getLatestDocsReview).toHaveBeenCalledWith('restored-file')
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', connection, scan: { componentCount: 1 }, docsReview: { status: 'saved', committedSha: 'c'.repeat(40) } })
    expect(documents.getSnapshot().file?.componentModel.definitions[componentId]).toMatchObject({ name: 'Button' })
  })

  it('restores the latest docs review when the project opens before its file', async () => {
    const projects = source()
    const documents = createDocumentStore()
    const getLatestDocsReview = vi.fn(async () => null)
    const service = createHostedRepositoryService(projects.store, documents)
    service.configure(project({
      returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(),
      getConnection: vi.fn(async () => connection), getLatestScan: vi.fn(async () => scanResult), getLatestDocsReview, link: vi.fn(), scan: vi.fn(),
    }))
    projects.open('project-a')
    await settle()
    expect(getLatestDocsReview).not.toHaveBeenCalled()

    documents.load(createBlankFile('late-file', 'page', 'root', 'Page'), [], { replace: true })
    await settle()
    expect(getLatestDocsReview).toHaveBeenCalledWith('late-file')
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', connection })
  })

  it('resumes an in-flight docs save after reload until the server returns its commit', async () => {
    const projects = source()
    const documents = createDocumentStore()
    documents.load(createBlankFile('resume-file', 'page', 'root', 'Page'), [], { replace: true })
    const preparedBundle = { files: [{ path: 'apps/docs/content/docs/components/button.mdx', diff: '+# Button' }], omissions: [], validation: [{ name: 'blume-check', detail: 'Passed' }] }
    const queued: EditorRepositoryDocsReview = {
      id: '00000000-0000-4000-8000-000000000605', fileId: 'resume-file', fileRevision: 1,
      status: 'queued_save', baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), approvalDigest: 'b'.repeat(64),
      preparedBundle, committedSha: null, errorId: null,
    }
    const saved: EditorRepositoryDocsReview = { ...queued, status: 'saved', committedSha: 'c'.repeat(40) }
    const getDocsReview = vi.fn(async () => saved)
    const service = createHostedRepositoryService(projects.store, documents, async () => undefined)
    service.configure(project({
      returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(),
      getConnection: vi.fn(async () => connection), getLatestScan: vi.fn(async () => scanResult), getLatestDocsReview: vi.fn(async () => queued), getDocsReview, link: vi.fn(), scan: vi.fn(),
    }))
    projects.open('project-a')
    await settle()

    expect(getDocsReview).toHaveBeenCalledWith(queued.id)
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', operation: null, docsReview: { status: 'saved', committedSha: 'c'.repeat(40) } })
  })

  it.each([
    {
      name: 'preparation',
      review: {
        id: '00000000-0000-4000-8000-000000000606', fileId: 'failed-file', fileRevision: 1,
        status: 'failed' as const, baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), approvalDigest: null,
        preparedBundle: null, committedSha: null, errorId: 'docs-prepare-restored',
      },
      message: 'Component docs preparation failed. Error ID: docs-prepare-restored',
    },
    {
      name: 'save',
      review: {
        id: '00000000-0000-4000-8000-000000000607', fileId: 'failed-file', fileRevision: 1,
        status: 'failed' as const, baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), approvalDigest: 'b'.repeat(64),
        preparedBundle: { files: [{ path: 'apps/docs/content/docs/components/button.mdx', diff: '+# Button' }], omissions: [], validation: [{ name: 'blume-check', detail: 'Passed' }] },
        committedSha: null, errorId: 'docs-save-restored',
      },
      message: 'Component docs save failed. Error ID: docs-save-restored',
    },
  ])('restores a terminal docs $name failure with its stable error id', async ({ review, message }) => {
    const projects = source()
    const documents = createDocumentStore()
    documents.load(createBlankFile('failed-file', 'page', 'root', 'Page'), [], { replace: true })
    const service = createHostedRepositoryService(projects.store, documents)
    service.configure(project({
      returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(),
      getConnection: vi.fn(async () => connection), getLatestScan: vi.fn(async () => scanResult), getLatestDocsReview: vi.fn(async () => review), link: vi.fn(), scan: vi.fn(),
    }))
    projects.open('project-a')
    await settle()

    expect(service.getSnapshot()).toMatchObject({ status: 'error', operation: null, docsReview: { id: review.id, status: 'failed' }, error: message })
  })

  it('shows callback choices and clears the handoff only after they load', async () => {
    const projects = source()
    const clearReturnLocation = vi.fn()
    const listChoices = vi.fn(async () => [repository])
    const service = createHostedRepositoryService(projects.store)
    service.configure(project({ returnInstallationId: () => '7', clearReturnLocation, startConnection: vi.fn(), listChoices, getConnection: vi.fn(), getLatestScan: vi.fn(), link: vi.fn(), scan: vi.fn() }))
    projects.open('project-a')
    await settle()

    expect(listChoices).toHaveBeenCalledWith('7')
    expect(clearReturnLocation).toHaveBeenCalledOnce()
    expect(service.getSnapshot()).toMatchObject({ status: 'choosing', installationId: '7', choices: [repository] })
  })

  it('links the exact repository selected from the callback', async () => {
    const projects = source()
    const documents = createDocumentStore()
    documents.load(createBlankFile('file', 'page', 'root', 'Page'), [], { replace: true })
    const link = vi.fn(async () => connection)
    const service = createHostedRepositoryService(projects.store, documents)
    const scan = vi.fn(async () => scanResult)
    service.configure(project({ returnInstallationId: () => '7', clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(async () => [repository]), getConnection: vi.fn(), getLatestScan: vi.fn(), link, scan }))
    projects.open('project-a')
    await settle()
    service.link('42')
    await settle()

    expect(link).toHaveBeenCalledWith('7', '42')
    expect(scan).toHaveBeenCalledOnce()
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', connection, choices: [], scan: { componentCount: 1 } })
    expect(documents.getSnapshot().file?.componentModel.definitions[componentId]).toMatchObject({
      id: componentId,
      name: 'Button',
      source: { kind: 'code', bindingId: componentId },
      properties: [{ name: 'tone', type: 'variant' }],
    })
    expect(documents.getSnapshot().atoms).toMatchObject([{ componentId, status: 'missing' }])
    expect(documents.commands.components.place(componentId)).toBe(false)
  })

  it('COMP-V2-CODE-008 builds and activates one exact hosted preview capability', async () => {
    const projects = source()
    const documents = createDocumentStore()
    documents.load(createBlankFile('file', 'page', 'root', 'Page'), [], { replace: true })
    const buildId = '00000000-0000-4000-8000-000000000821'
    const artifactId = '00000000-0000-4000-8000-000000000822'
    const createdAt = '2026-10-15T00:00:00.000Z'
    const startBuild = vi.fn(async () => ({ id: buildId, fileId: 'file', fileRevision: 0, status: 'queued' as const, attempts: 0, createdAt }))
    const getBuild = vi.fn(async () => ({ id: buildId, fileId: 'file', fileRevision: 0, status: 'completed' as const, attempts: 1, createdAt, artifactId, completedAt: createdAt }))
    const getPreview = vi.fn(async () => ({ artifactId, url: `https://preview.test/hosted/${artifactId}/capability/index.html`, expiresAt: 1_800_000_000 }))
    const service = createHostedRepositoryService(projects.store, documents, async () => undefined)
    service.configure(project({ returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(), getConnection: vi.fn(async () => connection), getLatestScan: vi.fn(async () => scanResult), link: vi.fn(), scan: vi.fn() }, { startBuild, getBuild, getPreview }))
    projects.open('project-a')
    await settle()

    service.build()
    await settle()
    await settle()

    expect(startBuild).toHaveBeenCalledOnce()
    expect(getBuild).toHaveBeenCalledWith(buildId)
    expect(getPreview).toHaveBeenCalledWith(artifactId)
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', executionAvailable: true, build: { id: buildId, status: 'completed', artifactId }, preview: { artifactId } })
    expect(documents.getSnapshot().atoms).toMatchObject([{ componentId, status: 'missing' }])
    expect(documents.commands.components.place(componentId)).toBe(false)
  })

  it('COMP-V2-DOCS-006 prepares a review from the current file and exact completed scan', async () => {
    const projects = source()
    const documents = createDocumentStore()
    documents.load(createBlankFile('file', 'page', 'root', 'Page'), [], { replace: true })
    const queued: EditorRepositoryDocsReview = {
      id: '00000000-0000-4000-8000-000000000601', fileId: 'file', fileRevision: 1,
      status: 'queued_prepare', baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), approvalDigest: null,
      preparedBundle: null, committedSha: null, errorId: null,
    }
    const prepared: EditorRepositoryDocsReview = {
      ...queued,
      status: 'prepared',
      approvalDigest: 'b'.repeat(64),
      preparedBundle: {
        files: [{ path: 'apps/docs/content/docs/components/button.mdx', diff: '+# Button' }],
        omissions: [],
        validation: [{ name: 'blume-check', detail: 'Passed' }],
      },
    }
    const prepareDocs = vi.fn(async () => queued)
    const getDocsReview = vi.fn(async () => prepared)
    const service = createHostedRepositoryService(projects.store, documents, async () => undefined)
    service.configure(project({
      returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(),
      getConnection: vi.fn(async () => connection), getLatestScan: vi.fn(async () => scanResult), link: vi.fn(), scan: vi.fn(),
      prepareDocs, getDocsReview,
    }))
    projects.open('project-a')
    await settle()
    documents.markSaved(documents.getSnapshot().file!)

    service.prepareDocs()
    await settle()
    await settle()

    expect(prepareDocs).toHaveBeenCalledWith({ fileId: 'file', fileRevision: 1, scanJobId: scanResult.jobId })
    expect(getDocsReview).toHaveBeenCalledWith(queued.id)
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', operation: null, docsReview: { id: queued.id, status: 'prepared' } })
  })

  it('COMP-V2-DOCS-006 surfaces the terminal preparation error id and keeps retry available', async () => {
    const projects = source()
    const documents = createDocumentStore()
    documents.load(createBlankFile('file', 'page', 'root', 'Page'), [], { replace: true })
    const failed: EditorRepositoryDocsReview = {
      id: '00000000-0000-4000-8000-000000000602', fileId: 'file', fileRevision: 1,
      status: 'failed', baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), approvalDigest: null,
      preparedBundle: null, committedSha: null, errorId: 'docs-validator-rejected',
    }
    const prepareDocs = vi.fn(async () => failed)
    const service = createHostedRepositoryService(projects.store, documents, async () => undefined)
    service.configure(project({
      returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(),
      getConnection: vi.fn(async () => connection), getLatestScan: vi.fn(async () => scanResult), link: vi.fn(), scan: vi.fn(), prepareDocs,
    }))
    projects.open('project-a')
    await settle()
    documents.markSaved(documents.getSnapshot().file!)

    service.prepareDocs()
    await settle()

    expect(service.getSnapshot()).toMatchObject({ status: 'error', operation: null, error: 'Component docs preparation failed. Error ID: docs-validator-rejected' })
    service.retry()
    await settle()
    expect(prepareDocs).toHaveBeenCalledTimes(2)
  })

  it('COMP-V2-DOCS-NEG-002 rejects a prepared result when the canvas file changes in flight', async () => {
    const projects = source()
    const documents = createDocumentStore()
    const original = createBlankFile('file', 'page', 'root', 'Page')
    documents.load(original, [], { replace: true })
    const prepared: EditorRepositoryDocsReview = {
      id: '00000000-0000-4000-8000-000000000608', fileId: 'file', fileRevision: original.revision,
      status: 'prepared', baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), approvalDigest: 'b'.repeat(64),
      preparedBundle: { files: [{ path: 'apps/docs/content/docs/components/button.mdx', diff: '+# Button' }], omissions: [], validation: [{ name: 'blume-check', detail: 'Passed' }] },
      committedSha: null, errorId: null,
    }
    let finishPreparation!: (review: EditorRepositoryDocsReview) => void
    const prepareDocs = vi.fn(() => new Promise<EditorRepositoryDocsReview>(resolve => { finishPreparation = resolve }))
    const service = createHostedRepositoryService(projects.store, documents)
    service.configure(project({
      returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(),
      getConnection: vi.fn(async () => connection), getLatestScan: vi.fn(async () => scanResult), link: vi.fn(), scan: vi.fn(), prepareDocs,
    }))
    projects.open('project-a')
    await settle()
    documents.markSaved(documents.getSnapshot().file!)

    service.prepareDocs()
    await settle()
    expect(documents.commands.renamePage('page', 'Changed while preparing')).toBe(true)
    finishPreparation(prepared)
    await settle()

    expect(service.getSnapshot()).toMatchObject({
      status: 'error',
      operation: null,
      docsReview: null,
      error: 'Component docs preparation was cancelled because the file changed.',
    })
  })

  it('COMP-V2-DOCS-NEG-002 refuses prepare and Save commands while canvas input is unsaved', async () => {
    const projects = source()
    const documents = createDocumentStore()
    const original = createBlankFile('file', 'page', 'root', 'Page')
    documents.load(original, [], { replace: true })
    const prepared: EditorRepositoryDocsReview = {
      id: '00000000-0000-4000-8000-000000000609', fileId: 'file', fileRevision: original.revision,
      status: 'prepared', baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), approvalDigest: 'b'.repeat(64),
      preparedBundle: { files: [{ path: 'apps/docs/content/docs/components/button.mdx', diff: '+# Button' }], omissions: [], validation: [{ name: 'blume-check', detail: 'Passed' }] },
      committedSha: null, errorId: null,
    }
    const prepareDocs = vi.fn(async () => prepared)
    const saveDocs = vi.fn(async () => ({ ...prepared, status: 'queued_save' as const }))
    const service = createHostedRepositoryService(projects.store, documents)
    service.configure(project({
      returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(),
      getConnection: vi.fn(async () => connection), getLatestScan: vi.fn(async () => scanResult), getLatestDocsReview: vi.fn(async () => prepared), link: vi.fn(), scan: vi.fn(), prepareDocs, saveDocs,
    }))
    projects.open('project-a')
    await settle()
    expect(service.getSnapshot()).toMatchObject({ docsReview: { id: prepared.id, status: 'prepared' } })
    documents.markSaved(documents.getSnapshot().file!)

    expect(documents.commands.renamePage('page', 'Unsaved')).toBe(true)
    expect(documents.getSnapshot().dirty).toBe(true)
    service.prepareDocs()
    service.saveDocs()
    await settle()

    expect(prepareDocs).not.toHaveBeenCalled()
    expect(saveDocs).not.toHaveBeenCalled()
    expect(service.getSnapshot()).toMatchObject({ docsReview: { id: prepared.id, status: 'prepared' } })
  })

  it('COMP-V2-DOCS-005 saves only the prepared review for the current file revision', async () => {
    const projects = source()
    const documents = createDocumentStore()
    documents.load(createBlankFile('file', 'page', 'root', 'Page'), [], { replace: true })
    const prepared: EditorRepositoryDocsReview = {
      id: '00000000-0000-4000-8000-000000000603', fileId: 'file', fileRevision: 1,
      status: 'prepared', baseRef: 'refs/heads/main', baseCommitSha: 'a'.repeat(40), approvalDigest: 'b'.repeat(64),
      preparedBundle: { files: [{ path: 'apps/docs/content/docs/components/button.mdx', diff: '+# Button' }], omissions: [], validation: [{ name: 'blume-check', detail: 'Passed' }] }, committedSha: null, errorId: null,
    }
    const queued = { ...prepared, status: 'queued_save' as const }
    const saved = { ...prepared, status: 'saved' as const, committedSha: 'c'.repeat(40) }
    const prepareDocs = vi.fn(async () => prepared)
    const saveDocs = vi.fn(async () => queued)
    const getDocsReview = vi.fn(async () => saved)
    const service = createHostedRepositoryService(projects.store, documents, async () => undefined)
    service.configure(project({
      returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(),
      getConnection: vi.fn(async () => connection), getLatestScan: vi.fn(async () => scanResult), link: vi.fn(), scan: vi.fn(),
      prepareDocs, getDocsReview, saveDocs,
    }))
    projects.open('project-a')
    await settle()
    documents.markSaved(documents.getSnapshot().file!)
    service.prepareDocs()
    await settle()

    service.saveDocs()
    await settle()
    await settle()

    expect(saveDocs).toHaveBeenCalledWith(prepared.id, prepared.approvalDigest)
    expect(getDocsReview).toHaveBeenCalledWith(prepared.id)
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', operation: null, docsReview: { status: 'saved', committedSha: 'c'.repeat(40) } })
  })

  it('ignores a stale connection response after the project changes', async () => {
    const projects = source()
    let release!: (value: EditorHostedRepositoryConnection | null) => void
    const first = new Promise<EditorHostedRepositoryConnection | null>(resolve => { release = resolve })
    const getConnection = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(null)
    const service = createHostedRepositoryService(projects.store)
    service.configure(project({ returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(), getConnection, getLatestScan: vi.fn(async () => null), link: vi.fn(), scan: vi.fn() }))
    projects.open('project-a')
    projects.open('project-b')
    await settle()
    release(connection)
    await settle()

    expect(getConnection).toHaveBeenCalledTimes(2)
    expect(service.getSnapshot()).toMatchObject({ status: 'idle', connection: null })
  })

  it('COMP-V2-CODE-002 does not reconcile a stale scan into the next project document', async () => {
    const projects = source()
    const documents = createDocumentStore()
    documents.load(createBlankFile('project-a-file', 'page-a', 'root-a', 'Page A'), [], { replace: true })
    let release!: (value: typeof scanResult) => void
    const pendingScan = new Promise<typeof scanResult>(resolve => { release = resolve })
    const getConnection = vi.fn().mockResolvedValueOnce(connection).mockResolvedValueOnce(null)
    const getLatestScan = vi.fn().mockReturnValueOnce(pendingScan)
    const service = createHostedRepositoryService(projects.store, documents)
    service.configure(project({ returnInstallationId: () => null, clearReturnLocation: vi.fn(), startConnection: vi.fn(), listChoices: vi.fn(), getConnection, getLatestScan, link: vi.fn(), scan: vi.fn() }))

    projects.open('project-a')
    await settle()
    expect(getLatestScan).toHaveBeenCalledOnce()

    documents.load(createBlankFile('project-b-file', 'page-b', 'root-b', 'Page B'), [], { replace: true })
    projects.open('project-b')
    await settle()
    release(scanResult)
    await settle()

    expect(service.getSnapshot()).toMatchObject({ status: 'idle', connection: null, scan: null })
    expect(documents.getSnapshot().file?.fileId).toBe('project-b-file')
    expect(documents.getSnapshot().file?.componentModel.definitions[componentId]).toBeUndefined()
    expect(documents.getSnapshot().atoms).toEqual([])
  })

  it('keeps the callback location when repository loading fails and retries', async () => {
    const projects = source()
    const clearReturnLocation = vi.fn()
    const listChoices = vi.fn().mockRejectedValueOnce(new Error('GitHub is unavailable.')).mockResolvedValueOnce([repository])
    const service = createHostedRepositoryService(projects.store)
    service.configure(project({ returnInstallationId: () => '7', clearReturnLocation, startConnection: vi.fn(), listChoices, getConnection: vi.fn(), getLatestScan: vi.fn(), link: vi.fn(), scan: vi.fn() }))
    projects.open('project-a')
    await settle()
    expect(service.getSnapshot()).toMatchObject({ status: 'error', error: 'GitHub is unavailable.' })
    expect(clearReturnLocation).not.toHaveBeenCalled()

    service.retry()
    await settle()
    expect(service.getSnapshot()).toMatchObject({ status: 'choosing', choices: [repository] })
    expect(clearReturnLocation).toHaveBeenCalledOnce()
  })
})
