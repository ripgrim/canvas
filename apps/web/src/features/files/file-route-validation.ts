export type FileRouteSearch = Readonly<{ pageId?: string; nodeId?: string }>

/** Persistent ids are browser-safe tokens; anything else is rejected before storage is touched. */
export const isValidRouteId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)

/** Node ids follow the document model's identity rule (letters, digits, `:` `.` `_` `-`, up to 128 characters). */
export const isValidNodeRouteId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value)

export function validateFileRouteSearch(search: Record<string, unknown>): FileRouteSearch {
  return {
    ...(isValidRouteId(search.pageId) ? { pageId: search.pageId } : {}),
    ...(isValidNodeRouteId(search.nodeId) ? { nodeId: search.nodeId } : {}),
  }
}
