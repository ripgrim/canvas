import { redirect } from '@tanstack/react-router'
import { fileLocationStore, fileRouteCopy } from '@canvas/editor/file-route'
import type { FileLocationResult } from '@canvas/editor/file-route'
import { appCopy } from '../../shell/copy'
import { isValidRouteId } from './file-route-validation'
import type { FileRouteSearch } from './file-route-validation'
import { fileOpenProgressService } from './file-open-progress-service'

export type FileRouteResult = FileLocationResult
export const fileOpenSlowAfterMs = 15_000

export function fileRouteLoaderDeps({ search }: Readonly<{ search: FileRouteSearch }>): Readonly<{ pageId: string | null }> {
  return { pageId: search.pageId ?? null }
}

export async function loadFileRoute(input: Readonly<{ params: Readonly<{ fileId: string }>; deps: Readonly<{ pageId: string | null }>; location: Readonly<{ search: unknown }> }>, slowAfterMs = fileOpenSlowAfterMs): Promise<FileRouteResult> {
  if (!isValidRouteId(input.params.fileId)) return { status: 'error', message: fileRouteCopy.invalidFileId }
  const nodeId = (input.location.search as FileRouteSearch).nodeId ?? null
  const opening = fileOpenProgressService.begin(input.params.fileId, slowAfterMs)
  let result: FileRouteResult
  try {
    const owned = await fileLocationStore.openLocation(input.params.fileId, input.deps.pageId, nodeId, opening.signal)
    result = owned.status === 'missing-file'
      ? await fileLocationStore.openSharedLocation(input.params.fileId, input.deps.pageId, nodeId, opening.signal)
      : owned
  } finally { fileOpenProgressService.finish(opening.attempt) }
  if (result.status === 'ok' && input.deps.pageId === null && result.pageId) throw redirect({ to: '/file/$fileId', params: { fileId: input.params.fileId }, search: nodeId ? { pageId: result.pageId, nodeId } : { pageId: result.pageId }, replace: true })
  return result
}

export function fileRouteHead({ loaderData }: Readonly<{ loaderData?: FileRouteResult }>) {
  const fileName = loaderData?.status === 'ok' ? loaderData.fileName : null
  return { meta: [{ title: fileName ? `${fileName} · ${appCopy.title}` : appCopy.title }] }
}
