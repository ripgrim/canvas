import type { SourceBindingReconcileCommand, SourceBindingSnapshot } from '@canvas/repository'
import { createStore } from 'zustand/vanilla'
import type { EditorHostedRepositoryApi } from '../../capabilities'
import type { EditorState } from './store'
import { editorStore } from './store'
import { projectHostedSourceBindings } from './hosted-source-binding-projection'
import type { HostedSourceBindingProjection } from './hosted-source-binding-projection'

export type HostedSourceBindingContext = Readonly<{ projectId: string; fileId: string }>
export type HostedSourceBindingStatus = 'idle' | 'loading' | 'empty' | 'ready' | 'stale' | 'error' | 'access-removed'
export type HostedSourceBindingState = Readonly<{
  status: HostedSourceBindingStatus
  context: HostedSourceBindingContext | null
  projection: HostedSourceBindingProjection | null
  error: string | null
}>
export type HostedSourceBindingRefreshOutcome = 'ready' | 'empty' | 'stale' | 'error' | 'access-removed' | 'cancelled'
export type HostedSourceBindingReconcileOutcome = Readonly<{
  status: 'projected' | 'committed-projection-stale' | 'conflict' | 'access-removed' | 'cancelled'
}>

type ProjectSource = Readonly<{
  getSnapshot(): Pick<EditorState, 'snapshot'>
  subscribe(listener: () => void): () => void
}>

const genericError = 'Source bindings are unavailable.'
const idleState: HostedSourceBindingState = Object.freeze({ status: 'idle', context: null, projection: null, error: null })

function sourceContext(source: ProjectSource): HostedSourceBindingContext | null {
  const snapshot = source.getSnapshot().snapshot
  if (!snapshot || typeof snapshot.projectId !== 'string' || snapshot.projectId.length === 0
    || typeof snapshot.fileId !== 'string' || snapshot.fileId.length === 0) return null
  return Object.freeze({ projectId: snapshot.projectId, fileId: snapshot.fileId })
}

function sameContext(left: HostedSourceBindingContext | null, right: HostedSourceBindingContext | null): boolean {
  return left === right || left !== null && right !== null && left.projectId === right.projectId && left.fileId === right.fileId
}

function bindingBytes(snapshot: SourceBindingSnapshot): string {
  return JSON.stringify({ authority: snapshot.authority, records: snapshot.records })
}

export function createHostedSourceBindingService(projectSource: ProjectSource = editorStore) {
  const backing = createStore<HostedSourceBindingState>(() => idleState)
  let api: EditorHostedRepositoryApi | undefined
  let stopProjectSource: (() => void) | null = null
  let context: HostedSourceBindingContext | null = null
  let generation = 0
  let requestSequence = 0
  let acceptedSnapshot: SourceBindingSnapshot | null = null
  let acceptedBytes: string | null = null

  const currentRequest = (expectedGeneration: number, expectedContext: HostedSourceBindingContext, request: number) => (
    generation === expectedGeneration && request === requestSequence && sameContext(context, expectedContext)
  )

  const publishFailure = (expectedGeneration: number, expectedContext: HostedSourceBindingContext, request: number): 'stale' | 'error' | 'cancelled' => {
    if (!currentRequest(expectedGeneration, expectedContext, request)) return 'cancelled'
    const projection = backing.getState().projection
    const status = projection ? 'stale' : 'error'
    backing.setState(Object.freeze({ status, context: expectedContext, projection, error: genericError }), true)
    return status
  }

  const clearForContext = (next: HostedSourceBindingContext | null) => {
    generation += 1
    requestSequence += 1
    context = next
    acceptedSnapshot = null
    acceptedBytes = null
    backing.setState(next
      ? Object.freeze({ status: 'loading', context: next, projection: null, error: null })
      : idleState, true)
  }

  const refresh = async (): Promise<HostedSourceBindingRefreshOutcome> => {
    const currentApi = api
    const expectedContext = context
    if (!currentApi || !expectedContext) return 'cancelled'
    const expectedGeneration = generation
    const request = ++requestSequence
    const current = backing.getState()
    backing.setState(Object.freeze({ status: 'loading', context: expectedContext, projection: current.projection, error: null }), true)

    try {
      const read = await currentApi.readSourceBindings()
      if (!currentRequest(expectedGeneration, expectedContext, request)) return 'cancelled'
      if (read.status === 'access-removed') {
        generation += 1
        requestSequence += 1
        acceptedSnapshot = null
        acceptedBytes = null
        backing.setState(Object.freeze({ status: 'access-removed', context: expectedContext, projection: null, error: null }), true)
        return 'access-removed'
      }
      if (read.snapshot === null) {
        acceptedSnapshot = null
        acceptedBytes = null
        backing.setState(Object.freeze({ status: 'empty', context: expectedContext, projection: null, error: null }), true)
        return 'empty'
      }

      const candidate = read.snapshot
      const prior = acceptedSnapshot
      const candidateBytes = bindingBytes(candidate)
      if (prior && candidate.version < prior.version) {
        backing.setState(Object.freeze({ status: 'ready', context: expectedContext, projection: backing.getState().projection, error: null }), true)
        return 'ready'
      }
      if (prior && candidate.version === prior.version && candidateBytes !== acceptedBytes) {
        return publishFailure(expectedGeneration, expectedContext, request)
      }
      if (prior && candidate.version > prior.version && candidate.authority.grantGeneration < prior.authority.grantGeneration) {
        return publishFailure(expectedGeneration, expectedContext, request)
      }

      const scan = await currentApi.getScan(candidate.authority.scanId)
      if (!currentRequest(expectedGeneration, expectedContext, request)) return 'cancelled'
      const projection = projectHostedSourceBindings({ projectId: expectedContext.projectId, snapshot: candidate, scan })
      if (!projection) return publishFailure(expectedGeneration, expectedContext, request)
      acceptedSnapshot = candidate
      acceptedBytes = candidateBytes
      backing.setState(Object.freeze({ status: 'ready', context: expectedContext, projection, error: null }), true)
      return 'ready'
    } catch {
      return publishFailure(expectedGeneration, expectedContext, request)
    }
  }

  const reconcileScan = async (scan: Parameters<typeof projectHostedSourceBindings>[0]['scan']): Promise<HostedSourceBindingReconcileOutcome> => {
    const currentApi = api
    const expectedContext = context
    if (!currentApi || !expectedContext) return Object.freeze({ status: 'cancelled' })
    const expectedGeneration = generation
    const request = ++requestSequence
    const current = backing.getState()
    backing.setState(Object.freeze({ status: 'loading', context: expectedContext, projection: current.projection, error: null }), true)

    try {
      const read = await currentApi.readSourceBindings()
      if (!currentRequest(expectedGeneration, expectedContext, request)) return Object.freeze({ status: 'cancelled' })
      if (read.status === 'access-removed') {
        generation += 1
        requestSequence += 1
        acceptedSnapshot = null
        acceptedBytes = null
        backing.setState(Object.freeze({ status: 'access-removed', context: expectedContext, projection: null, error: null }), true)
        return Object.freeze({ status: 'access-removed' })
      }
      const baseline = read.snapshot
      const command: SourceBindingReconcileCommand = Object.freeze({
        scanJobId: scan.jobId,
        expectedVersion: baseline?.version ?? null,
        expectedAuthority: baseline?.authority ?? null,
        rebinds: Object.freeze([]),
      })
      const result = await currentApi.reconcileSourceBindings(command)
      if (!currentRequest(expectedGeneration, expectedContext, request)) return Object.freeze({ status: 'cancelled' })
      if (result.status === 'access-removed') {
        generation += 1
        requestSequence += 1
        acceptedSnapshot = null
        acceptedBytes = null
        backing.setState(Object.freeze({ status: 'access-removed', context: expectedContext, projection: null, error: null }), true)
        return Object.freeze({ status: 'access-removed' })
      }
      if (result.status === 'conflict') {
        const refreshOutcome = await refresh()
        if (refreshOutcome === 'access-removed') return Object.freeze({ status: 'access-removed' })
        if (generation !== expectedGeneration || !sameContext(context, expectedContext)) return Object.freeze({ status: 'cancelled' })
        return Object.freeze({ status: 'conflict' })
      }

      const committed = result.snapshot
      const expectedVersion = (baseline?.version ?? 0) + 1
      const validAdvance = committed.version === expectedVersion
        && (acceptedSnapshot === null || committed.version > acceptedSnapshot.version)
      const validProject = committed.authority.repository.projectId === expectedContext.projectId
      const validGrant = (baseline === null || committed.authority.grantGeneration >= baseline.authority.grantGeneration)
        && (acceptedSnapshot === null || committed.authority.grantGeneration >= acceptedSnapshot.authority.grantGeneration)
      const projection = validAdvance && validProject && validGrant
        ? projectHostedSourceBindings({ projectId: expectedContext.projectId, snapshot: committed, scan })
        : null
      if (!currentRequest(expectedGeneration, expectedContext, request)) return Object.freeze({ status: 'cancelled' })
      if (!projection) {
        publishFailure(expectedGeneration, expectedContext, request)
        return Object.freeze({ status: 'committed-projection-stale' })
      }
      acceptedSnapshot = committed
      acceptedBytes = bindingBytes(committed)
      backing.setState(Object.freeze({ status: 'ready', context: expectedContext, projection, error: null }), true)
      return Object.freeze({ status: 'projected' })
    } catch (error) {
      if (!currentRequest(expectedGeneration, expectedContext, request)) return Object.freeze({ status: 'cancelled' })
      publishFailure(expectedGeneration, expectedContext, request)
      throw error
    }
  }

  const reconcileContext = () => {
    const next = sourceContext(projectSource)
    if (sameContext(context, next)) return
    clearForContext(next)
    if (next) void refresh()
  }

  const stop = () => {
    stopProjectSource?.()
    stopProjectSource = null
    api = undefined
    clearForContext(null)
  }

  return {
    getSnapshot: backing.getState,
    subscribe: backing.subscribe,
    start(hostedApi: EditorHostedRepositoryApi | undefined) {
      stop()
      api = hostedApi
      if (!api) return
      stopProjectSource = projectSource.subscribe(reconcileContext)
      reconcileContext()
    },
    refresh,
    reconcileScan,
    stop,
    dispose: stop,
  }
}

export const hostedSourceBindingService = createHostedSourceBindingService()
