import { contextBridge, ipcRenderer } from 'electron'
import { repositoryChannel } from './contracts'
import type { DesignEditorApi, DesktopProjectSnapshot, DesktopSaveResult, RepositoryRequest, RepositoryResponse } from './contracts'
import type { PreparedChange } from '@canvas/repo-engine'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { mayExposeLocalCapabilities } from '../main/web-target'

async function invoke<T>(request: RepositoryRequest): Promise<T> {
  const response: RepositoryResponse = await ipcRenderer.invoke(repositoryChannel, request)
  if (!response.ok) throw new Error(response.error)
  return response.value as T
}

const api: DesignEditorApi = Object.freeze({
  inspectFixture: () => invoke<DesktopProjectSnapshot>({ method: 'inspectFixture', args: [] }),
  prepareLabelPadding: (padding: string) => invoke<PreparedChange>({ method: 'prepareLabelPadding', args: [padding] }),
  prepareToken: (value: string) => invoke<PreparedChange>({ method: 'prepareToken', args: [value] }),
  preparePromotion: (name: string) => invoke<PreparedChange>({ method: 'preparePromotion', args: [name] }),
  prepareUndo: (transactionId: string) => invoke<PreparedChange>({ method: 'prepareUndo', args: [transactionId] }),
  prepareRedo: (transactionId: string) => invoke<PreparedChange>({ method: 'prepareRedo', args: [transactionId] }),
  saveFile: (file: FileDocument, expectedRevision: number) => invoke<DesktopProjectSnapshot>({ method: 'saveFile', args: [file, expectedRevision] }),
  savePrepared: (id: string, approvalDigest: string) => invoke<DesktopSaveResult>({ method: 'savePrepared', args: [id, approvalDigest] }),
  refresh: () => invoke<DesktopProjectSnapshot>({ method: 'refresh', args: [] }),
})

if (mayExposeLocalCapabilities(process.isMainFrame, process.argv, location.href)) contextBridge.exposeInMainWorld('designEditor', api)
