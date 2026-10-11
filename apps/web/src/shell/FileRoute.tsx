import { useNavigate } from '@tanstack/react-router'
import { FilePage } from '@canvas/editor/file'
import type { FileLocationResult } from '@canvas/editor/file-route'

export type FileRouteResult = FileLocationResult

export function FileRoute({ fileId, result }: { fileId: string; result: FileRouteResult }) {
  const navigate = useNavigate()
  const home = () => { void navigate({ to: '/' }) }
  const changePage = (pageId: string) => { void navigate({ to: '/file/$fileId', params: { fileId }, search: { pageId } }) }
  const defaultPage = () => { void navigate({ to: '/file/$fileId', params: { fileId }, search: {}, replace: true }) }
  return <FilePage result={result} onHome={home} onPageChange={changePage} onOpenDefaultPage={defaultPage} />
}
