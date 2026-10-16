import type { SourceBindingSnapshot } from '@canvas/repository'
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

  const publishFailure = (expectedGeneration: number, expectedContext: HostedSourceBindingContext, request: number) => {
    if (generation !== expectedGeneration || request !== requestSequence || !sameContext(context, expectedContext)) return
    const projection = backing.getState().projection
    backing.setState(Object.freeze({ status: projection ? 'stale' : 'error', context: expectedContext, projection, error: genericError }), true)
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

  const refresh = () => {
    const currentApi = api
    const expectedContext = context
    if (!currentApi || !expectedContext) return
    const expectedGeneration = generation
    const request = ++requestSequence
    const current = backing.getState()
    backing.setState(Object.freeze({ status: 'loading', context: expectedContext, projection: current.projection, error: null }), true)

    void (async () => {
      try {
        const read = await currentApi.readSourceBindings()
        if (generation !== expectedGeneration || request !== requestSequence || !sameContext(context, expectedContext)) return
        if (read.status === 'access-removed') {
          generation += 1
          requestSequence += 1
          acceptedSnapshot = null
          acceptedBytes = null
          backing.setState(Object.freeze({ status: 'access-removed', context: expectedContext, projection: null, error: null }), true)
          return
        }
        if (read.snapshot === null) {
          acceptedSnapshot = null
          acceptedBytes = null
          backing.setState(Object.freeze({ status: 'empty', context: expectedContext, projection: null, error: null }), true)
          return
        }

        const candidate = read.snapshot
        const prior = acceptedSnapshot
        const candidateBytes = bindingBytes(candidate)
        if (prior && candidate.version < prior.version) {
          backing.setState(Object.freeze({ status: 'ready', context: expectedContext, projection: backing.getState().projection, error: null }), true)
          return
        }
        if (prior && candidate.version === prior.version && candidateBytes !== acceptedBytes) {
          publishFailure(expectedGeneration, expectedContext, request)
          return
        }
        if (prior && candidate.version > prior.version && candidate.authority.grantGeneration < prior.authority.grantGeneration) {
          publishFailure(expectedGeneration, expectedContext, request)
          return
        }

        const scan = await currentApi.getScan(candidate.authority.scanId)
        if (generation !== expectedGeneration || request !== requestSequence || !sameContext(context, expectedContext)) return
        const projection = projectHostedSourceBindings({ projectId: expectedContext.projectId, snapshot: candidate, scan })
        if (!projection) {
          publishFailure(expectedGeneration, expectedContext, request)
          return
        }
        acceptedSnapshot = candidate
        acceptedBytes = candidateBytes
        backing.setState(Object.freeze({ status: 'ready', context: expectedContext, projection, error: null }), true)
      } catch {
        publishFailure(expectedGeneration, expectedContext, request)
      }
    })()
  }

  const reconcileContext = () => {
    const next = sourceContext(projectSource)
    if (sameContext(context, next)) return
    clearForContext(next)
    if (next) refresh()
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
    stop,
    dispose: stop,
  }
}

export const hostedSourceBindingService = createHostedSourceBindingService()
