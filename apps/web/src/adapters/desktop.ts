import type { EditorAuthApi, EditorCapabilities, EditorProjectApi } from '@canvas/editor/capabilities'

export type DesktopBridge = Omit<EditorProjectApi, 'openProject' | 'capabilities' | 'auth' | 'listFiles' | 'openFile'> & {
  listFiles: NonNullable<EditorProjectApi['listFiles']>
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
}
export const desktopCapabilities: EditorCapabilities = {
  runtime: 'desktop', openLabel: 'Open file',
  files: {
    list: { available: true, reason: 'Files are available in the desktop app.' },
    create: { available: false, reason: 'New file is not available yet.' },
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
  return {
    capabilities: desktopCapabilities,
    ...(auth ? { auth } : {}),
    listFiles: () => bridge.listFiles(),
    openFile: fileId => bridge.openFile(fileId),
    openProject: () => bridge.inspectFixture(), refresh: () => bridge.refresh(),
    pickLocalRepository: () => bridge.pickLocalRepository(),
    cloneGitHubRepository: input => bridge.cloneGitHubRepository(input),
    getConnectedRepository: () => bridge.getConnectedRepository(),
    rescanConnectedRepository: () => bridge.rescanConnectedRepository(),
    saveFile: (file, revision) => bridge.saveFile(file, revision),
    prepareLabelPadding: value => bridge.prepareLabelPadding(value), prepareToken: value => bridge.prepareToken(value),
    preparePromotion: name => bridge.preparePromotion(name), prepareUndo: id => bridge.prepareUndo(id), prepareRedo: id => bridge.prepareRedo(id),
    savePrepared: (id, digest) => bridge.savePrepared(id, digest),
  }
}
