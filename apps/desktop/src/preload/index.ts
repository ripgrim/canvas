import { contextBridge, ipcRenderer } from 'electron'
import { authChannel, authSessionChangedChannel, repositoryChannel, repositoryConnectionChannel } from './contracts'
import type { AuthRequest, AuthResponse, ConnectedRepositoryScan, DesignEditorApi, DesktopFileSummary, DesktopProjectSnapshot, DesktopSaveResult, RepositoryConnectionRequest, RepositoryConnectionResponse, RepositoryRequest, RepositoryResponse } from './contracts'
import type { PreparedChange } from '@canvas/repo-engine'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { ShadcnScan } from '@canvas/scanner/contracts'
import { mayExposeLocalCapabilities } from '../main/web-target'
import type { GitHubCloneRequest } from '@canvas/repository'
import type { AuthSessionView } from '@canvas/auth'

async function invoke<T>(request: RepositoryRequest): Promise<T> {
  const response: RepositoryResponse = await ipcRenderer.invoke(repositoryChannel, request)
  if (!response.ok) throw new Error(response.error)
  return response.value as T
}

async function invokeRepository<T>(request: RepositoryConnectionRequest): Promise<T> {
  const response: RepositoryConnectionResponse = await ipcRenderer.invoke(repositoryConnectionChannel, request)
  if (!response.ok) throw new Error(response.error)
  return response.value as T
}

async function invokeAuth(request: AuthRequest): Promise<AuthSessionView> {
  const response: AuthResponse = await ipcRenderer.invoke(authChannel, request)
  if (!response.ok) throw new Error(response.error)
  return response.value
}

const api: DesignEditorApi = Object.freeze({
  listFiles: () => invoke<readonly DesktopFileSummary[]>({ method: 'listFiles', args: [] }),
  createFile: () => invoke<DesktopFileSummary>({ method: 'createFile', args: [] }),
  openFile: (fileId: string) => invoke<DesktopProjectSnapshot>({ method: 'openFile', args: [fileId] }),
  inspectFixture: () => invoke<DesktopProjectSnapshot>({ method: 'inspectFixture', args: [] }),
  scanShadcn: () => invoke<ShadcnScan>({ method: 'scanShadcn', args: [] }),
  pickLocalRepository: () => invokeRepository<ConnectedRepositoryScan | null>({ method: 'pickLocal', args: [] }),
  cloneGitHubRepository: (input: GitHubCloneRequest) => invokeRepository<ConnectedRepositoryScan>({ method: 'cloneGitHub', args: [input] }),
  getConnectedRepository: () => invokeRepository<ConnectedRepositoryScan | null>({ method: 'getCurrent', args: [] }),
  rescanConnectedRepository: () => invokeRepository<ConnectedRepositoryScan>({ method: 'scanCurrent', args: [] }),
  prepareLabelPadding: (padding: string) => invoke<PreparedChange>({ method: 'prepareLabelPadding', args: [padding] }),
  prepareToken: (value: string) => invoke<PreparedChange>({ method: 'prepareToken', args: [value] }),
  preparePromotion: (name: string) => invoke<PreparedChange>({ method: 'preparePromotion', args: [name] }),
  prepareUndo: (transactionId: string) => invoke<PreparedChange>({ method: 'prepareUndo', args: [transactionId] }),
  prepareRedo: (transactionId: string) => invoke<PreparedChange>({ method: 'prepareRedo', args: [transactionId] }),
  saveFile: (file: FileDocument, expectedRevision: number) => invoke<DesktopProjectSnapshot>({ method: 'saveFile', args: [file, expectedRevision] }),
  savePrepared: (id: string, approvalDigest: string) => invoke<DesktopSaveResult>({ method: 'savePrepared', args: [id, approvalDigest] }),
  refresh: () => invoke<DesktopProjectSnapshot>({ method: 'refresh', args: [] }),
  getAuthSession: () => invokeAuth({ method: 'getSession', args: [] }),
  signInWithGitHub: () => invokeAuth({ method: 'signInWithGitHub', args: [] }),
  signOut: () => invokeAuth({ method: 'signOut', args: [] }),
  onAuthSessionChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, session: AuthSessionView) => listener(session)
    ipcRenderer.on(authSessionChangedChannel, handler)
    return () => ipcRenderer.removeListener(authSessionChangedChannel, handler)
  },
})

if (mayExposeLocalCapabilities(process.isMainFrame, process.argv, location.href)) contextBridge.exposeInMainWorld('designEditor', api)
