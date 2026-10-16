import type { InternalClipboardPayload } from './clipboard-codec'
import type { CanvasClipboardWrite } from './clipboard-service'
import type { ImageMime } from '@canvas/repo-engine/appearance'

export type InternalClipboardAssetPreview = Readonly<{ assetId: string; sha256: string; mime: ImageMime; data: string }>
export type InternalClipboardAssetPreviews = Readonly<Record<string, InternalClipboardAssetPreview>>
export type InternalClipboardEntry = Readonly<{ payload: InternalClipboardPayload; value: CanvasClipboardWrite; assets: InternalClipboardAssetPreviews }>

let current: InternalClipboardEntry | null = null

export const internalClipboardBuffer = Object.freeze({
  get: () => current,
  remember: (payload: InternalClipboardPayload, value: CanvasClipboardWrite, assets: InternalClipboardAssetPreviews = {}) => {
    const previews = Object.freeze(Object.fromEntries(Object.entries(assets).map(([id, preview]) => [id, Object.freeze({ ...preview })])))
    current = Object.freeze({ payload, value: Object.freeze({ html: value.html, text: value.text }), assets: previews })
  },
  assetsFor: (payload: InternalClipboardPayload): InternalClipboardAssetPreviews => current && JSON.stringify(current.payload) === JSON.stringify(payload) ? current.assets : {},
  clear: () => { current = null },
})

export function captureInternalClipboardAssets(
  payload: InternalClipboardPayload,
  resolve: (assetId: string) => Readonly<{ mime: ImageMime; data: string }> | null,
): InternalClipboardAssetPreviews {
  return Object.freeze(Object.fromEntries(Object.entries(payload.assets ?? {}).map(([assetId, asset]) => {
    const preview = resolve(assetId)
    if (!preview || preview.mime !== asset.mime) throw new Error(`Image "${asset.name}" needs verified source bytes before it can be copied.`)
    return [assetId, Object.freeze({ assetId, sha256: asset.sha256, mime: asset.mime, data: preview.data })]
  })))
}

export async function publishInternalClipboard(
  value: CanvasClipboardWrite,
  clipboard: Pick<Clipboard, 'write' | 'writeText'> | null = typeof navigator === 'undefined' ? null : navigator.clipboard,
  ClipboardItemType: typeof ClipboardItem | null = typeof ClipboardItem === 'undefined' ? null : ClipboardItem,
): Promise<boolean> {
  if (!clipboard) return false
  try {
    if (ClipboardItemType) {
      await clipboard.write([new ClipboardItemType({
        'text/html': new Blob([value.html], { type: 'text/html' }),
        'text/plain': new Blob([value.text], { type: 'text/plain' }),
      })])
    } else await clipboard.writeText(value.text)
    return true
  } catch { return false }
}
