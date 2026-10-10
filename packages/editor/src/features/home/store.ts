import { createStore } from 'zustand/vanilla'
import { readAppearance } from '../application/appearance'
import type { EditorFile, EditorProjectApi } from '../../capabilities'
import { unavailableCapabilities } from '../../capabilities'
import { editorStore } from '../editor/store'
import type { HomeStatus } from './home-types'

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The action could not be completed.'
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
    if (current === generation) backing.setState({ status: { kind: 'error', operation: 'list', message: errorMessage(error) } })
  }
}

/** Creates a file exactly once and returns its persistent id; the caller navigates to it. */
async function createFile(): Promise<string | null> {
  const api = projectApi
  const current = ++generation
  backing.setState({ status: { kind: 'creating', phases: [{ name: 'Creating local file', state: 'active' }] } })
  retry = () => { void createFile() }
  try {
    if (!api?.createFile) throw new Error(api?.capabilities?.files.create.reason ?? 'File creation is unavailable.')
    const file = await api.createFile()
    if (current !== generation) return null
    backing.setState({ files: [file, ...backing.getState().files], status: { kind: 'ready' } })
    return file.id
  } catch (error) {
    if (current === generation) backing.setState({ status: { kind: 'error', operation: 'create', message: errorMessage(error) } })
    return null
  }
}

export const homeStore = {
  getSnapshot: backing.getState,
  subscribe: backing.subscribe,
  configure(api: EditorProjectApi | undefined) {
    projectApi = api
    generation += 1
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
  dispose() { generation += 1; retry = null; projectApi = undefined },
}
