import { createStore } from 'zustand/vanilla'
import { readAppearance } from '../application/appearance'
import type { EditorFile, EditorProjectApi } from '../../capabilities'
import { unavailableCapabilities } from '../../capabilities'
import { editorStore } from '../editor/store'
import type { HomeStatus } from './home-types'
import { failureDetails } from '../application/failure'
import { trackCanvasEvent } from '@canvas/tracking'

type HomeState = Readonly<{
  mode: 'light' | 'dark'
  files: readonly EditorFile[]
  status: HomeStatus
}>

const initialPhase = { name: 'Reading local files', state: 'active' as const }
const backing = createStore<HomeState>(() => ({ mode: readAppearance(), files: [], status: { kind: 'starting', phases: [initialPhase] } }))
let projectApi: EditorProjectApi | undefined
let generation = 0
let retry: (() => void) | null = null
let createOperation: { generation: number; promise: Promise<string | null> } | null = null

function operationFailure(operation: 'list' | 'create' | 'open', error: unknown) {
  const failure = failureDetails(error, 'The action could not be completed.')
  trackCanvasEvent('operation_failed', { operation, error_code: failure.code, error_reference: failure.reference })
  return { kind: 'error', operation, message: failure.message, reference: failure.reference } as const
}

async function listFiles() {
  const api = projectApi
  if (!api?.listFiles) {
    backing.setState({ files: [], status: { kind: 'ready' } })
    return
  }
  const current = ++generation
  backing.setState({ status: { kind: 'starting', phases: [initialPhase] } })
  retry = () => { void listFiles() }
  try {
    const files = await api.listFiles()
    if (current === generation) backing.setState({ files, status: { kind: 'ready' } })
  } catch (error) {
    if (current === generation) backing.setState({ status: operationFailure('list', error) })
  }
}

/** Creates a file exactly once and returns its persistent id; the caller navigates to it. */
function createFile(): Promise<string | null> {
  if (createOperation?.generation === generation) return createOperation.promise
  const api = projectApi
  const current = ++generation
  backing.setState({ status: { kind: 'creating', phases: [{ name: 'Creating local file', state: 'active' }] } })
  retry = () => { void createFile() }
  const operation: { generation: number; promise: Promise<string | null> } = { generation: current, promise: Promise.resolve(null) }
  const promise = (async () => {
    try {
      if (!api?.createFile) throw new Error(api?.capabilities?.files.create.reason ?? 'File creation is unavailable.')
      const file = await api.createFile()
      if (current !== generation) return null
      backing.setState({ files: [file, ...backing.getState().files], status: { kind: 'ready' } })
      return file.id
    } catch (error) {
      if (current === generation) backing.setState({ status: operationFailure('create', error) })
      return null
    } finally {
      if (createOperation === operation) createOperation = null
    }
  })()
  operation.promise = promise
  createOperation = operation
  return promise
}

export const homeStore = {
  getSnapshot: backing.getState,
  subscribe: backing.subscribe,
  configure(api: EditorProjectApi | undefined) {
    projectApi = api
    generation += 1
    createOperation = null
    const canList = Boolean(api?.listFiles && api.capabilities?.files.list.available)
    backing.setState({ files: [], status: canList ? { kind: 'starting', phases: [initialPhase] } : { kind: 'ready' } })
  },
  start() { void listFiles() },
  create: () => createFile(),
  retry() { retry?.() },
  back() { backing.setState({ status: { kind: 'ready' } }) },
  showHome() {
    backing.setState({ mode: editorStore.getSnapshot().mode })
    void listFiles()
  },
  toggleMode() {
    const mode = backing.getState().mode === 'light' ? 'dark' : 'light'
    backing.setState({ mode })
    editorStore.setAppearance(mode)
  },
  capabilities() { return projectApi?.capabilities?.files ?? unavailableCapabilities.files },
  dispose() { generation += 1; createOperation = null; retry = null; projectApi = undefined },
}
