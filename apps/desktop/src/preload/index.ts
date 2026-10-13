import { contextBridge, ipcRenderer } from 'electron'
import { authChannel, authSessionChangedChannel, collaborationChangedChannel, collaborationChannel, fileChangedChannel, repositoryChannel, repositoryConnectionChannel, updateChangedChannel, updateChannel } from './contracts'
import type { AuthRequest, AuthResponse, CollaborationRequest, CollaborationResponse, ConnectedRepositoryScan, DesignEditorApi, DesktopFileSummary, DesktopProjectSnapshot, DesktopSaveResult, RepositoryConnectionRequest, RepositoryConnectionResponse, RepositoryRequest, RepositoryResponse, UpdateRequest, UpdateResponse } from './contracts'
import type { PreparedChange } from '@canvas/repo-engine'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { ShadcnScan } from '@canvas/scanner/contracts'
import { mayExposeLocalCapabilities } from '../main/web-target'
import type { GitHubCloneRequest } from '@canvas/repository'
import type { AuthSessionView } from '@canvas/auth'
import type { EditorCollaborationPatch, EditorCollaborationSnapshot, EditorPersistenceIntent } from '@canvas/editor/capabilities'
import type { ApplicationUpdateSnapshot } from '@canvas/editor/updates'

function responseError(response: Readonly<{ error: string; reference?: string }>): Error {
  const error = new Error(response.error) as Error & { reference?: string }
  if (response.reference) error.reference = response.reference
  return error
}

async function invoke<T>(request: RepositoryRequest): Promise<T> {
  const response: RepositoryResponse = await ipcRenderer.invoke(repositoryChannel, request)
  if (!response.ok) throw responseError(response)
  return response.value as T
}

async function invokeRepository<T>(request: RepositoryConnectionRequest): Promise<T> {
  const response: RepositoryConnectionResponse = await ipcRenderer.invoke(repositoryConnectionChannel, request)
  if (!response.ok) throw responseError(response)
  return response.value as T
}

async function invokeAuth(request: AuthRequest): Promise<AuthSessionView> {
  const response: AuthResponse = await ipcRenderer.invoke(authChannel, request)
  if (!response.ok) throw responseError(response)
  return response.value
}

async function invokeCollaboration(request: CollaborationRequest): Promise<EditorCollaborationSnapshot | null> {
  const response: CollaborationResponse = await ipcRenderer.invoke(collaborationChannel, request)
  if (!response.ok) throw responseError(response)
  return response.value
}

async function invokeUpdate(request: UpdateRequest): Promise<ApplicationUpdateSnapshot> {
  const response: UpdateResponse = await ipcRenderer.invoke(updateChannel, request)
  if (!response.ok) throw responseError(response)
  return response.value
}

const api: DesignEditorApi = Object.freeze({
  allowUnauthenticatedWorkspace: process.argv.filter(argument => argument === '--design-editor-unauthenticated-workspace').length === 1,
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
  saveFile: (file: FileDocument, expectedRevision: number, intent?: EditorPersistenceIntent) => invoke<DesktopProjectSnapshot>(intent ? { method: 'saveFile', args: [file, expectedRevision, intent] } : { method: 'saveFile', args: [file, expectedRevision] }),
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
  getCollaborationSnapshot: async () => (await invokeCollaboration({ method: 'getSnapshot', args: [] }))!,
  updateCollaborationAwareness: async (patch: EditorCollaborationPatch, options?: Readonly<{ immediate?: boolean }>) => { await invokeCollaboration({ method: 'updateAwareness', args: [patch, options] }) },
  retryCollaboration: async () => { await invokeCollaboration({ method: 'retry', args: [] }) },
  leaveCollaboration: async () => { await invokeCollaboration({ method: 'leave', args: [] }) },
  onCollaborationChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: EditorCollaborationSnapshot) => listener(snapshot)
    ipcRenderer.on(collaborationChangedChannel, handler)
    return () => ipcRenderer.removeListener(collaborationChangedChannel, handler)
  },
  onFileChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DesktopProjectSnapshot) => listener(snapshot)
    ipcRenderer.on(fileChangedChannel, handler)
    return () => ipcRenderer.removeListener(fileChangedChannel, handler)
  },
  getUpdateSnapshot: () => invokeUpdate({ method: 'getSnapshot', args: [] }),
  checkForUpdate: () => invokeUpdate({ method: 'check', args: [] }),
  downloadUpdate: () => invokeUpdate({ method: 'download', args: [] }),
  installUpdate: () => invokeUpdate({ method: 'install', args: [] }),
  onUpdateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: ApplicationUpdateSnapshot) => listener(snapshot)
    ipcRenderer.on(updateChangedChannel, handler)
    return () => ipcRenderer.removeListener(updateChangedChannel, handler)
  },
})

if (mayExposeLocalCapabilities(process.isMainFrame, process.argv, location.href)) contextBridge.exposeInMainWorld('designEditor', api)
