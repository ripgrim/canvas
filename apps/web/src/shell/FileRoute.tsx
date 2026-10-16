import { useSyncExternalStore } from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { FileLoadingPage, FilePage } from '@canvas/editor/file'
import type { FileLocationResult } from '@canvas/editor/file-route'
import { fileOpenProgressService } from '../features/files/file-open-progress-service'

export type FileRouteResult = FileLocationResult

export function FileRoute({ fileId, result }: { fileId: string; result: FileRouteResult }) {
  const navigate = useNavigate()
  const home = () => { void navigate({ to: '/' }) }
  const changePage = (pageId: string) => { void navigate({ to: '/file/$fileId', params: { fileId }, search: { pageId } }) }
  const defaultPage = () => { void navigate({ to: '/file/$fileId', params: { fileId }, search: {}, replace: true }) }
  return <FilePage result={result} onHome={home} onPageChange={changePage} onOpenDefaultPage={defaultPage} />
}

export function FileRoutePending() {
  const navigate = useNavigate()
  const router = useRouter()
  const progress = useSyncExternalStore(fileOpenProgressService.subscribe, fileOpenProgressService.getSnapshot, fileOpenProgressService.getSnapshot)
  const home = () => { fileOpenProgressService.cancel(); void navigate({ to: '/' }) }
  const retry = () => { fileOpenProgressService.cancel(); void router.invalidate() }
  return <FileLoadingPage slow={progress.status === 'slow'} onRetry={retry} onHome={home} />
}
