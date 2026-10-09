import { useNavigate } from '@tanstack/react-router'
import { FilePage } from '@canvas/editor/file'
import type { FileLocationResult } from '@canvas/editor/file'

/** Persistent ids are browser-safe tokens; anything else is rejected before storage is touched. */
export const isValidRouteId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
/** Node ids follow the document model's identity rule (letters, digits, `:` `.` `_` `-`, up to 128 characters). */
export const isValidNodeRouteId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value)

export function FileRoute({ fileId, result }: { fileId: string; result: FileLocationResult }) {
  const navigate = useNavigate()
  const home = () => { void navigate({ to: '/' }) }
  const changePage = (pageId: string) => { void navigate({ to: '/file/$fileId', params: { fileId }, search: { pageId } }) }
  const defaultPage = () => { void navigate({ to: '/file/$fileId', params: { fileId }, search: {}, replace: true }) }
  return <FilePage result={result} onHome={home} onPageChange={changePage} onOpenDefaultPage={defaultPage} />
}
