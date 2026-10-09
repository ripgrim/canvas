import { createFileRoute, redirect } from '@tanstack/react-router'
import { FileLoadingPage, fileLocationStore, fileRouteCopy } from '@canvas/editor/file'
import type { FileLocationResult } from '@canvas/editor/file'
import { FileRoute, isValidNodeRouteId, isValidRouteId } from '../shell/FileRoute'
import { appCopy } from '../shell/copy'

export const Route = createFileRoute('/file/$fileId')({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { pageId?: string; nodeId?: string } => ({
    ...(isValidRouteId(search.pageId) ? { pageId: search.pageId } : {}),
    ...(isValidNodeRouteId(search.nodeId) ? { nodeId: search.nodeId } : {}),
  }),
  // Only the page is a load dependency. The selected node is read from the location so selection changes never reload the file.
  loaderDeps: ({ search }) => ({ pageId: search.pageId ?? null }),
  loader: async ({ params, deps, location }): Promise<FileLocationResult> => {
    if (!isValidRouteId(params.fileId)) return { status: 'error', message: fileRouteCopy.invalidFileId }
    const nodeId = (location.search as { nodeId?: string }).nodeId ?? null
    const result = await fileLocationStore.openLocation(params.fileId, deps.pageId, nodeId)
    // A file URL without a page resolves to the file's saved page and is canonicalized so every history entry names its page.
    if (result.status === 'ok' && deps.pageId === null && result.pageId) throw redirect({ to: '/file/$fileId', params: { fileId: params.fileId }, search: nodeId ? { pageId: result.pageId, nodeId } : { pageId: result.pageId }, replace: true })
    return result
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.status === 'ok' ? `${loaderData.fileName} · ${appCopy.title}` : appCopy.title }] }),
  pendingComponent: FileLoadingPage,
  component: FileRouteComponent,
})

function FileRouteComponent() { return <FileRoute fileId={Route.useParams().fileId} result={Route.useLoaderData()} /> }
