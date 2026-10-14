export type FontPermissionDetails = Readonly<{
  isMainFrame: boolean
  requestingUrl?: string
}>

export function canAccessLocalFonts(permission: string, details: FontPermissionDetails, editorUrl: string): boolean {
  if (permission !== 'local-fonts' || !details.isMainFrame || !details.requestingUrl) return false
  try {
    const request = new URL(details.requestingUrl)
    const editor = new URL(editorUrl)
    return request.protocol === editor.protocol && request.host === editor.host
  } catch {
    return false
  }
}
