import type { AnyRouter } from '@tanstack/react-router'
import { fileSelection, filePageState } from '@canvas/editor/file'

const fileRouteId = '/file/$fileId'
type FileMatch = { routeId: string; params: Record<string, string>; search: Record<string, unknown>; loaderData?: unknown }

/**
 * Mirrors the open page into `pageId` and the single selected canvas node into `nodeId`, so a copied link reopens the same
 * page with that node selected and undo that lands on another page keeps the address honest.
 * Writes replace the current entry, so Back and Forward still move between pages and files rather than selections.
 * Nothing is written while the router is loading: selection churn during a page or file load belongs to the outgoing document.
 */
export function createSelectionUrlSync(router: AnyRouter) {
  let stops: Array<() => void> = []
  const sync = () => {
    if (router.state.status !== 'idle') return
    const match = (router.state.matches as FileMatch[]).find(candidate => candidate.routeId === fileRouteId)
    const result = match?.loaderData as { status?: string } | undefined
    if (!match || result?.status !== 'ok') return
    const fileId = match.params.fileId
    const nodeId = fileSelection.getNodeId()
    const pageId = filePageState.getPageId()
    const currentNode = typeof match.search.nodeId === 'string' ? match.search.nodeId : null
    const currentPage = typeof match.search.pageId === 'string' ? match.search.pageId : null
    if (!fileId || (currentNode === nodeId && (pageId === null || currentPage === pageId))) return
    void router.navigate({ to: fileRouteId, params: { fileId }, search: (previous: Record<string, unknown>) => { const { nodeId: _dropped, pageId: _page, ...rest } = previous; return { ...rest, ...(pageId ? { pageId } : currentPage ? { pageId: currentPage } : {}), ...(nodeId ? { nodeId } : {}) } }, replace: true })
  }
  return {
    start() {
      this.stop()
      stops = [fileSelection.subscribe(sync), filePageState.subscribe(sync), router.subscribe('onResolved', sync)]
    },
    stop() { for (const stop of stops) stop(); stops = [] },
  }
}
