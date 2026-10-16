import { createStore } from 'zustand/vanilla'
import type { EditorHostedPreview, EditorHostedPreviewBuild, EditorHostedRepository, EditorHostedRepositoryConnection, EditorHostedRepositoryScan, EditorProjectApi, EditorRepositoryDocsReview } from '../../capabilities'
import { editorStore } from './store'
import { documentStore } from './document-store'
import { discoveredRegistryAtoms, discoveredRegistryDefinitions, documentRegistryAtoms } from './component-registry'

export type HostedRepositoryState = Readonly<{
  available: boolean
  executionAvailable: boolean
  status: 'idle' | 'busy' | 'choosing' | 'ready' | 'error'
  operation: 'loading' | 'connecting' | 'listing' | 'linking' | 'scanning' | 'building' | 'preparing-docs' | 'saving-docs' | null
  connection: EditorHostedRepositoryConnection | null
  choices: readonly EditorHostedRepository[]
  installationId: string | null
  scan: EditorHostedRepositoryScan | null
  build: EditorHostedPreviewBuild | null
  preview: EditorHostedPreview | null
  docsReview: EditorRepositoryDocsReview | null
  error: string | null
}>

type ProjectSource = Pick<typeof editorStore, 'subscribe' | 'getSnapshot'>
type DocumentSource = Pick<typeof documentStore, 'subscribe' | 'getSnapshot' | 'commands'>

const initialState: HostedRepositoryState = {
  available: false,
  executionAvailable: false,
  status: 'idle',
  operation: null,
  connection: null,
  choices: [],
  installationId: null,
  scan: null,
  build: null,
  preview: null,
  docsReview: null,
  error: null,
}

const message = (error: unknown) => error instanceof Error ? error.message : 'Repository unavailable.'

function docsReviewError(review: EditorRepositoryDocsReview): string | null {
  if (review.status === 'stale') {
    return review.committedSha || review.approvalDigest
      ? 'The repository changed before the docs could be saved. Scan it and prepare the docs again.'
      : 'The component docs review is stale. Scan the repository and prepare it again.'
  }
  if (review.status !== 'failed') return null
  const phase = review.preparedBundle && review.approvalDigest ? 'save' : 'preparation'
  const fallback = phase === 'save' ? 'component-docs-save-failed' : 'component-docs-prepare-failed'
  return `Component docs ${phase} failed. Error ID: ${review.errorId ?? fallback}`
}

function syncScan(documents: DocumentSource, scan: EditorHostedRepositoryScan): void {
  const discovered = discoveredRegistryAtoms(scan.registry)
  const document = documents.getSnapshot()
  const atoms = documentRegistryAtoms(document.file, discovered, document.atoms)
  if (!documents.commands.components.reconcileCodeDefinitions(discoveredRegistryDefinitions(scan.registry), atoms)) {
    throw new Error('The discovered components could not be added to this file.')
  }
}

export function createHostedRepositoryService(projectSource: ProjectSource = editorStore, documents: DocumentSource = documentStore, delay: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))) {
  const backing = createStore<HostedRepositoryState>(() => initialState)
  let api: EditorProjectApi['hostedRepository'] | undefined
  let execution: EditorProjectApi['hostedExecution'] | undefined
  let generation = 0
  let projectId: string | null = null
  let retry: (() => Promise<void>) | null = null
  let stopProjectSync: (() => void) | null = null
  let stopDocumentSync: (() => void) | null = null
  let documentFileId: string | null = null

  const run = async (operation: NonNullable<HostedRepositoryState['operation']>, task: () => Promise<Partial<HostedRepositoryState>>) => {
    const current = ++generation
    backing.setState({ available: true, executionAvailable: Boolean(execution), status: 'busy', operation, error: null })
    try {
      const result = await task()
      if (current !== generation) return
      if (result.scan) syncScan(documents, result.scan)
      backing.setState({ available: true, executionAvailable: Boolean(execution), operation: null, error: null, ...result })
    } catch (error) {
      if (current === generation) backing.setState({ available: true, executionAvailable: Boolean(execution), status: 'error', operation: null, error: message(error) })
    }
  }

  const load = () => {
    const currentApi = api
    if (!currentApi || !projectSource.getSnapshot().snapshot?.projectId) return
    const expectedProjectId = projectId
    const installationId = currentApi.returnInstallationId()
    if (installationId) {
      const task = async () => {
        const choices = await currentApi.listChoices(installationId)
        if (choices.length === 0) throw new Error('No repositories available.')
        currentApi.clearReturnLocation()
        return { status: 'choosing' as const, choices, installationId, connection: null }
      }
      retry = async () => { await run('listing', task) }
      void run('listing', task)
      return
    }
    const task = async () => {
      const connection = await currentApi.getConnection()
      const scan = connection ? await currentApi.getLatestScan() : null
      const fileId = documents.getSnapshot().file?.fileId ?? null
      let docsReview = connection && fileId ? await currentApi.getLatestDocsReview(fileId) : null
      while (docsReview && (docsReview.status === 'queued_prepare' || docsReview.status === 'preparing' || docsReview.status === 'queued_save' || docsReview.status === 'saving')) {
        await delay(750)
        if (projectId !== expectedProjectId || documents.getSnapshot().file?.fileId !== fileId) throw new Error('Repository loading was cancelled.')
        docsReview = await currentApi.getDocsReview(docsReview.id)
      }
      const docsError = docsReview ? docsReviewError(docsReview) : null
      return connection
        ? { status: docsError ? 'error' as const : 'ready' as const, connection, choices: [], installationId: connection.installationId, scan, build: null, preview: null, docsReview, error: docsError }
        : { status: 'idle' as const, connection: null, choices: [], installationId: null, scan: null, build: null, preview: null, docsReview: null }
    }
    retry = async () => { await run('loading', task) }
    void run('loading', task)
  }

  const reconcile = () => {
    const nextProjectId = projectSource.getSnapshot().snapshot?.projectId ?? null
    if (nextProjectId === projectId) return
    projectId = nextProjectId
    generation += 1
    retry = null
    backing.setState({ ...initialState, available: Boolean(api), executionAvailable: Boolean(execution) }, true)
    if (nextProjectId) load()
  }

  const reconcileDocument = () => {
    const nextFileId = documents.getSnapshot().file?.fileId ?? null
    if (nextFileId === documentFileId) return
    documentFileId = nextFileId
    if (nextFileId && projectId && api) load()
  }

  return {
    subscribe: backing.subscribe,
    getSnapshot: backing.getState,
    configure(next: EditorProjectApi | undefined) {
      stopProjectSync?.()
      stopDocumentSync?.()
      api = next?.hostedRepository
      execution = next?.hostedExecution
      projectId = null
      documentFileId = documents.getSnapshot().file?.fileId ?? null
      generation += 1
      retry = null
      backing.setState({ ...initialState, available: Boolean(api), executionAvailable: Boolean(execution) }, true)
      stopProjectSync = projectSource.subscribe(reconcile)
      stopDocumentSync = documents.subscribe(reconcileDocument)
      reconcile()
    },
    connect() {
      const currentApi = api
      if (!currentApi || !projectId) return
      const task = async () => { await currentApi.startConnection(); return { status: 'idle' as const } }
      retry = async () => { await run('connecting', task) }
      void run('connecting', task)
    },
    link(repositoryId: string) {
      const currentApi = api
      const installationId = backing.getState().installationId
      if (!currentApi || !projectId || !installationId) return
      const task = async () => {
        const connection = await currentApi.link(installationId, repositoryId)
        const scan = await currentApi.scan()
        return { status: 'ready' as const, connection, choices: [], installationId: connection.installationId, scan, build: null, preview: null, docsReview: null }
      }
      retry = async () => { await run('linking', task) }
      void run('linking', task)
    },
    scan() {
      const currentApi = api
      const connection = backing.getState().connection
      if (!currentApi || !connection) return
      const task = async () => {
        const scan = await currentApi.scan()
        return { status: 'ready' as const, connection, scan, build: null, preview: null, docsReview: null }
      }
      retry = async () => { await run('scanning', task) }
      void run('scanning', task)
    },
    build() {
      const currentExecution = execution
      const state = backing.getState()
      if (!currentExecution || !state.connection || !state.scan || !projectId) return
      const expectedProjectId = projectId
      const task = async () => {
        let build = await currentExecution.startBuild()
        while (build.status === 'queued' || build.status === 'leased') {
          await delay(750)
          if (projectId !== expectedProjectId) throw new Error('Hosted preview build was cancelled.')
          build = await currentExecution.getBuild(build.id)
        }
        if (build.status === 'failed') throw new Error(`Preview build failed. Error ID: ${build.errorId ?? 'hosted-preview-build-failed'}`)
        if (!build.artifactId) throw new Error('Preview build did not return an artifact.')
        const preview = await currentExecution.getPreview(build.artifactId)
        return { status: 'ready' as const, build, preview }
      }
      retry = async () => { await run('building', task) }
      void run('building', task)
    },
    prepareDocs() {
      const currentApi = api
      const state = backing.getState()
      const document = documents.getSnapshot()
      const file = document.file
      if (!currentApi || !state.connection || !state.scan || !projectId || !file || document.dirty || document.saving) return
      const expectedProjectId = projectId
      const expectedFileId = file.fileId
      const expectedFileRevision = file.revision
      const assertCurrentFile = () => {
        const currentFile = documents.getSnapshot().file
        if (projectId !== expectedProjectId || currentFile !== file || currentFile?.fileId !== expectedFileId || currentFile.revision !== expectedFileRevision) {
          throw new Error('Component docs preparation was cancelled because the file changed.')
        }
      }
      const task = async () => {
        let docsReview = await currentApi.prepareDocs({ fileId: file.fileId, fileRevision: file.revision, scanJobId: state.scan!.jobId })
        assertCurrentFile()
        while (docsReview.status === 'queued_prepare' || docsReview.status === 'preparing') {
          await delay(750)
          assertCurrentFile()
          docsReview = await currentApi.getDocsReview(docsReview.id)
          assertCurrentFile()
        }
        const docsError = docsReviewError(docsReview)
        if (docsError) return { status: 'error' as const, docsReview, error: docsError }
        if (docsReview.status !== 'prepared' || !docsReview.preparedBundle || !docsReview.approvalDigest) throw new Error('Component docs preparation did not return a reviewable change.')
        return { status: 'ready' as const, docsReview }
      }
      retry = async () => { await run('preparing-docs', task) }
      void run('preparing-docs', task)
    },
    saveDocs() {
      const currentApi = api
      const state = backing.getState()
      const review = state.docsReview
      const document = documents.getSnapshot()
      const file = document.file
      if (!currentApi || !review || review.status !== 'prepared' || !review.approvalDigest || !file || document.dirty || document.saving || review.fileId !== file.fileId || review.fileRevision !== file.revision || !projectId) return
      const expectedProjectId = projectId
      const task = async () => {
        let docsReview = await currentApi.saveDocs(review.id, review.approvalDigest!)
        while (docsReview.status === 'queued_save' || docsReview.status === 'saving') {
          await delay(750)
          if (projectId !== expectedProjectId) throw new Error('Component docs save was cancelled.')
          docsReview = await currentApi.getDocsReview(docsReview.id)
        }
        const docsError = docsReviewError(docsReview)
        if (docsError) return { status: 'error' as const, docsReview, error: docsError }
        if (docsReview.status !== 'saved') throw new Error('Component docs were not saved.')
        return { status: 'ready' as const, docsReview }
      }
      retry = async () => { await run('saving-docs', task) }
      void run('saving-docs', task)
    },
    retry() { void retry?.() },
    dispose() {
      stopProjectSync?.()
      stopProjectSync = null
      stopDocumentSync?.()
      stopDocumentSync = null
      api = undefined
      execution = undefined
      projectId = null
      documentFileId = null
      generation += 1
      retry = null
      backing.setState(initialState, true)
    },
  }
}

export const hostedRepositoryService = createHostedRepositoryService()
