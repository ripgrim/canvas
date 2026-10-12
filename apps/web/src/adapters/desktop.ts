import type { EditorAuthApi, EditorCapabilities, EditorCollaborationPatch, EditorCollaborationSnapshot, EditorProjectApi, EditorProjectSnapshot } from '@canvas/editor/capabilities'
import type { ApplicationUpdateBridge } from '@canvas/editor/updates'

export type DesktopBridge = Omit<EditorProjectApi, 'openProject' | 'capabilities' | 'auth' | 'listFiles' | 'createFile' | 'openFile'> & ApplicationUpdateBridge & {
  listFiles: NonNullable<EditorProjectApi['listFiles']>
  createFile: NonNullable<EditorProjectApi['createFile']>
  openFile: NonNullable<EditorProjectApi['openFile']>
  inspectFixture: EditorProjectApi['openProject']
  pickLocalRepository: NonNullable<EditorProjectApi['pickLocalRepository']>
  cloneGitHubRepository: NonNullable<EditorProjectApi['cloneGitHubRepository']>
  getConnectedRepository: NonNullable<EditorProjectApi['getConnectedRepository']>
  rescanConnectedRepository: NonNullable<EditorProjectApi['rescanConnectedRepository']>
  getAuthSession: EditorAuthApi['getSession']
  signInWithGitHub: EditorAuthApi['signInWithGitHub']
  signOut: EditorAuthApi['signOut']
  onAuthSessionChanged(listener: Parameters<EditorAuthApi['subscribe']>[0]): () => void
  getCollaborationSnapshot(): Promise<EditorCollaborationSnapshot>
  updateCollaborationAwareness(patch: EditorCollaborationPatch, options?: Readonly<{ immediate?: boolean }>): Promise<void>
  retryCollaboration(): Promise<void>
  leaveCollaboration(): Promise<void>
  onCollaborationChanged(listener: (snapshot: EditorCollaborationSnapshot) => void): () => void
  onFileChanged(listener: (snapshot: EditorProjectSnapshot) => void): () => void
}
export const desktopCapabilities: EditorCapabilities = {
  runtime: 'desktop', openLabel: 'Open file',
  files: {
    list: { available: true, reason: 'Files are available in the desktop app.' },
    create: { available: true, reason: 'Create a file.' },
    open: { available: true, reason: 'Open a file.' },
  },
  localRepository: { available: true, reason: 'Choose a local repository or connect a managed clone.' },
  sourceWrites: { available: true, reason: 'Reviewed changes can be saved to the trusted local fixture.' },
  hostedExecution: { available: false, reason: 'Hosted repository execution is not connected.' },
  git: { available: true, reason: 'Public GitHub repositories can be cloned into the managed workspace.' },
  mcp: { available: false, reason: 'MCP is deferred.' },
  hostedProjects: { available: false, reason: 'Hosted projects are not connected.' },
}
export function createDesktopAdapter(bridge: DesktopBridge): EditorProjectApi {
  const auth = typeof bridge.getAuthSession === 'function' && typeof bridge.signInWithGitHub === 'function' && typeof bridge.signOut === 'function' && typeof bridge.onAuthSessionChanged === 'function' ? {
    getSession: () => bridge.getAuthSession(),
    signInWithGitHub: () => bridge.signInWithGitHub(),
    signOut: () => bridge.signOut(),
    subscribe: (listener: Parameters<EditorAuthApi['subscribe']>[0]) => bridge.onAuthSessionChanged(listener),
  } satisfies EditorAuthApi : undefined
  const collaborationListeners = new Set<() => void>()
  let collaborationSnapshot: EditorCollaborationSnapshot = { status: 'unavailable', shellState: null, localClientId: null, localProfile: null, canMutate: false, canManageShare: false, participants: [], agents: [], error: null }
  const publishCollaboration = (snapshot: EditorCollaborationSnapshot) => { collaborationSnapshot = snapshot; for (const listener of collaborationListeners) listener() }
  void bridge.getCollaborationSnapshot().then(publishCollaboration)
  bridge.onCollaborationChanged(publishCollaboration)
  const collaboration = {
    getSnapshot: () => collaborationSnapshot,
    subscribe: (listener: () => void) => { collaborationListeners.add(listener); return () => collaborationListeners.delete(listener) },
    updateAwareness: (patch: Parameters<NonNullable<EditorProjectApi['collaboration']>['updateAwareness']>[0], options?: Parameters<NonNullable<EditorProjectApi['collaboration']>['updateAwareness']>[1]) => { void bridge.updateCollaborationAwareness(patch, options) },
    retry: () => { void bridge.retryCollaboration() },
    leave: () => { void bridge.leaveCollaboration() },
  }
  return {
    capabilities: desktopCapabilities,
    ...(auth ? { auth } : {}),
    collaboration,
    listFiles: () => bridge.listFiles(),
    createFile: () => bridge.createFile(),
    openFile: fileId => bridge.openFile(fileId),
    openProject: () => bridge.inspectFixture(), refresh: () => bridge.refresh(),
    subscribeFile: listener => bridge.onFileChanged(snapshot => listener(snapshot)),
    pickLocalRepository: () => bridge.pickLocalRepository(),
    cloneGitHubRepository: input => bridge.cloneGitHubRepository(input),
    getConnectedRepository: () => bridge.getConnectedRepository(),
    rescanConnectedRepository: () => bridge.rescanConnectedRepository(),
    saveFile: (file, revision, intent) => bridge.saveFile(file, revision, intent),
    prepareLabelPadding: value => bridge.prepareLabelPadding(value), prepareToken: value => bridge.prepareToken(value),
    preparePromotion: name => bridge.preparePromotion(name), prepareUndo: id => bridge.prepareUndo(id), prepareRedo: id => bridge.prepareRedo(id),
    savePrepared: (id, digest) => bridge.savePrepared(id, digest),
  }
}
