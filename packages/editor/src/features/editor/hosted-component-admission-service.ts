import type { HostedProjectionAdmissionResult } from './document-store'
import { documentStore } from './document-store'
import type { HostedSourceBindingContext, HostedSourceBindingState } from './hosted-source-binding-service'
import { hostedSourceBindingService } from './hosted-source-binding-service'
import type { HostedSourceBindingProjection } from './hosted-source-binding-projection'

type BindingSource = Readonly<{
  getSnapshot(): HostedSourceBindingState
  subscribe(listener: () => void): () => void
}>

type DocumentSource = Readonly<{
  getSnapshot(): Readonly<{ file: Readonly<{ fileId: string; revision: number }> | null }>
  subscribe(listener: () => void): () => void
  commands: Readonly<{
    components: Readonly<{
      reconcileHostedProjection(input: Readonly<{
        expectedFileId: string
        expectedFileRevision: number
        projection: HostedSourceBindingProjection
      }>): HostedProjectionAdmissionResult
      retireHostedProjection(input: Readonly<{
        expectedFileId: string
        expectedFileRevision: number
      }>): HostedProjectionAdmissionResult
    }>
  }>
}>

type AcceptedAdmission = Readonly<{
  context: HostedSourceBindingContext
  authority: string
  file: object
}>

const sameContext = (left: HostedSourceBindingContext | null, right: HostedSourceBindingContext | null): boolean => (
  left === right || left !== null && right !== null && left.projectId === right.projectId && left.fileId === right.fileId
)

const authorityKey = (projection: HostedSourceBindingProjection): string => JSON.stringify(projection.authority)

const exactReadyAdmission = (
  state: HostedSourceBindingState,
  file: Readonly<{ fileId: string; revision: number }> | null,
): Readonly<{ context: HostedSourceBindingContext; projection: HostedSourceBindingProjection; authority: string }> | null => {
  if (state.status !== 'ready' || !state.context || !state.projection || !file
    || state.context.fileId !== file.fileId
    || state.context.projectId !== state.projection.authority.projectId) return null
  return Object.freeze({ context: state.context, projection: state.projection, authority: authorityKey(state.projection) })
}

const retirementIntent = (
  state: HostedSourceBindingState,
  file: Readonly<{ fileId: string; revision: number }> | null,
  accepted: AcceptedAdmission | null,
): string | null => {
  if (!file || exactReadyAdmission(state, file)) return null
  if ((state.status === 'loading' || state.status === 'stale' || state.status === 'error')
    && accepted !== null && sameContext(accepted.context, state.context)) return null
  return JSON.stringify({
    fileId: file.fileId,
    status: state.status,
    context: state.context,
    authority: state.projection?.authority ?? null,
  })
}

export function createHostedComponentAdmissionService(
  bindings: BindingSource = hostedSourceBindingService,
  documents: DocumentSource = documentStore,
) {
  let stopBindings: (() => void) | null = null
  let stopDocuments: (() => void) | null = null
  let accepted: AcceptedAdmission | null = null
  let running = false
  let active = false
  let pendingBinding = false
  let stopRequested = false

  const unchangedReadyAdmission = (
    expected: Readonly<{ context: HostedSourceBindingContext; authority: string }>,
    fileId: string,
  ) => {
    const state = bindings.getSnapshot()
    const file = documents.getSnapshot().file
    const current = exactReadyAdmission(state, file)
    return current !== null
      && file?.fileId === fileId
      && sameContext(current.context, expected.context)
      && current.authority === expected.authority
  }

  const admit = (ready: Readonly<{
    context: HostedSourceBindingContext
    projection: HostedSourceBindingProjection
    authority: string
  }>, file: Readonly<{ fileId: string; revision: number }>) => {
    const input = { expectedFileId: file.fileId, expectedFileRevision: file.revision, projection: ready.projection }
    let result = documents.commands.components.reconcileHostedProjection(input)
    if (result === 'stale' && unchangedReadyAdmission(ready, file.fileId)) {
      const currentFile = documents.getSnapshot().file
      const currentState = bindings.getSnapshot()
      const currentReady = exactReadyAdmission(currentState, currentFile)
      if (currentFile && currentReady) {
        result = documents.commands.components.reconcileHostedProjection({
          expectedFileId: currentFile.fileId,
          expectedFileRevision: currentFile.revision,
          projection: currentReady.projection,
        })
      }
    }
    if (result === 'applied' || result === 'unchanged') {
      const admittedFile = documents.getSnapshot().file
      if (admittedFile?.fileId === file.fileId) accepted = Object.freeze({ context: ready.context, authority: ready.authority, file: admittedFile })
    }
  }

  const retirementStillRequired = (expectedFileId: string, expectedIntent: string, forced: boolean): boolean => {
    const file = documents.getSnapshot().file
    if (!file || file.fileId !== expectedFileId) return false
    if (forced) return true
    return retirementIntent(bindings.getSnapshot(), file, accepted) === expectedIntent
  }

  const retire = (forced = false, expectedIntent = forced ? 'forced' : retirementIntent(bindings.getSnapshot(), documents.getSnapshot().file, accepted)) => {
    const file = documents.getSnapshot().file
    if (!file) { accepted = null; return }
    if (expectedIntent === null) return
    let result = documents.commands.components.retireHostedProjection({ expectedFileId: file.fileId, expectedFileRevision: file.revision })
    if (result === 'stale' && retirementStillRequired(file.fileId, expectedIntent, forced)) {
      const currentFile = documents.getSnapshot().file
      if (currentFile?.fileId === file.fileId) {
        result = documents.commands.components.retireHostedProjection({
          expectedFileId: currentFile.fileId,
          expectedFileRevision: currentFile.revision,
        })
      }
    }
    if (result === 'applied' || result === 'unchanged') accepted = null
  }

  const reconcile = (allowFollowup = true) => {
    if (running || !active) return
    running = true
    try {
      const state = bindings.getSnapshot()
      const file = documents.getSnapshot().file
      const ready = exactReadyAdmission(state, file)
      if (ready && file) {
        if (accepted && accepted.file === file && accepted.authority === ready.authority && sameContext(accepted.context, ready.context)) return
        admit(ready, file)
        return
      }

      retire(false, retirementIntent(state, file, accepted))
    } finally {
      running = false
      if (stopRequested) {
        stopRequested = false
        retire(true)
      } else if (active && allowFollowup && pendingBinding) {
        pendingBinding = false
        reconcile(false)
      }
    }
  }

  const stop = () => {
    if (!active) return
    active = false
    stopBindings?.()
    stopBindings = null
    stopDocuments?.()
    stopDocuments = null
    pendingBinding = false
    if (running) { stopRequested = true; return }
    running = true
    try { retire(true) } finally { running = false }
  }

  return {
    start() {
      if (active) stop()
      active = true
      stopRequested = false
      stopBindings = bindings.subscribe(() => {
        if (running) { pendingBinding = true; return }
        reconcile()
      })
      stopDocuments = documents.subscribe(() => { if (!running) reconcile() })
      reconcile()
    },
    stop,
    dispose: stop,
  }
}

export const hostedComponentAdmissionService = createHostedComponentAdmissionService()
