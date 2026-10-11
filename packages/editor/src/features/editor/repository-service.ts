import { createStore } from 'zustand/vanilla'
import type { EditorProjectApi, EditorRepositoryConnection } from '../../capabilities'
import { documentStore } from './document-store'
import { editorStore } from './store'
import { connectedRegistryAtoms, documentRegistryAtoms } from './component-registry'

type RepositoryConnectionState = Readonly<{
  status: 'idle' | 'busy' | 'ready' | 'error'
  operation: 'loading' | 'local' | 'clone' | 'scan' | null
  connection: EditorRepositoryConnection | null
  error: string | null
}>

const initialState: RepositoryConnectionState = { status: 'idle', operation: null, connection: null, error: null }
const backing = createStore<RepositoryConnectionState>(() => initialState)
let api: EditorProjectApi | undefined
let generation = 0
let retry: (() => Promise<EditorRepositoryConnection | null>) | null = null
let retryKind: Exclude<RepositoryConnectionState['operation'], null> = 'scan'

const message = (error: unknown) => error instanceof Error ? error.message : 'The repository could not be connected.'

async function run(kind: Exclude<RepositoryConnectionState['operation'], null>, operation: () => Promise<EditorRepositoryConnection | null>) {
  const current = ++generation
  retry = operation
  retryKind = kind
  backing.setState({ status: 'busy', operation: kind, error: null })
  try {
    const connection = await operation()
    if (current !== generation) return
    if (connection) {
      const active = connectedRegistryAtoms(connection)
      const document = documentStore.getSnapshot()
      documentStore.setAtoms(documentRegistryAtoms(document.file, active, document.atoms))
      if (editorStore.getSnapshot().snapshot) await editorStore.refresh()
      if (current !== generation) return
      backing.setState({ status: 'ready', operation: null, connection, error: null })
    }
    else backing.setState({ status: backing.getState().connection ? 'ready' : 'idle', operation: null, error: null })
  } catch (error) {
    if (current === generation) backing.setState({ status: 'error', operation: null, error: message(error) })
  }
}

export const repositoryConnectionService = {
  subscribe: backing.subscribe,
  getSnapshot: backing.getState,
  configure(next: EditorProjectApi | undefined) {
    api = next
    generation += 1
    backing.setState(initialState, true)
  },
  load() {
    const currentApi = api
    if (currentApi?.getConnectedRepository) void run('loading', () => currentApi.getConnectedRepository!())
  },
  pickLocal() {
    const currentApi = api
    if (!currentApi?.pickLocalRepository) return
    void run('local', () => currentApi.pickLocalRepository!())
  },
  cloneGitHub(owner: string, name: string) {
    const currentApi = api
    if (!currentApi?.cloneGitHubRepository) return
    void run('clone', () => currentApi.cloneGitHubRepository!({ owner, name }))
  },
  rescan() {
    const currentApi = api
    if (!currentApi?.rescanConnectedRepository) return
    void run('scan', () => currentApi.rescanConnectedRepository!())
  },
  retry() {
    if (retry) void run(retryKind, retry)
  },
  dispose() {
    generation += 1
    api = undefined
    retry = null
    retryKind = 'scan'
    backing.setState(initialState, true)
  },
}
