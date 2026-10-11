import { redirect } from '@tanstack/react-router'
import { fileLocationStore, fileRouteCopy } from '@canvas/editor/file-route'
import type { FileLocationResult } from '@canvas/editor/file-route'
import { appCopy } from '../../shell/copy'
import { isValidRouteId } from './file-route-validation'
import type { FileRouteSearch } from './file-route-validation'

export type FileRouteResult = FileLocationResult

export function fileRouteLoaderDeps({ search }: Readonly<{ search: FileRouteSearch }>): Readonly<{ pageId: string | null }> {
  return { pageId: search.pageId ?? null }
}

export async function loadFileRoute(input: Readonly<{ params: Readonly<{ fileId: string }>; deps: Readonly<{ pageId: string | null }>; location: Readonly<{ search: unknown }> }>): Promise<FileRouteResult> {
  if (!isValidRouteId(input.params.fileId)) return { status: 'error', message: fileRouteCopy.invalidFileId }
  const nodeId = (input.location.search as FileRouteSearch).nodeId ?? null
  const owned = await fileLocationStore.openLocation(input.params.fileId, input.deps.pageId, nodeId)
  const result = owned.status === 'missing-file'
    ? await fileLocationStore.openSharedLocation(input.params.fileId, input.deps.pageId, nodeId)
    : owned
  if (result.status === 'ok' && input.deps.pageId === null && result.pageId) throw redirect({ to: '/file/$fileId', params: { fileId: input.params.fileId }, search: nodeId ? { pageId: result.pageId, nodeId } : { pageId: result.pageId }, replace: true })
  return result
}

export function fileRouteHead({ loaderData }: Readonly<{ loaderData?: FileRouteResult }>) {
  const fileName = loaderData?.status === 'ok' ? loaderData.fileName : null
  return { meta: [{ title: fileName ? `${fileName} · ${appCopy.title}` : appCopy.title }] }
}
