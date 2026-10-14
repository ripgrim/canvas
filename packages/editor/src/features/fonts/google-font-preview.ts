import type { CSSProperties } from 'react'
import { googleFontPreviewAssets } from './google-font-preview-assets.generated'

type PreviewEntry = Readonly<{ atlas: number; width: number; x: number; y: number }>
type PreviewCatalog = Readonly<{
  atlasHeight: number
  atlasWidth: number
  families: Readonly<Record<string, PreviewEntry>>
}>

const scale = 0.5
const preloadImages: HTMLImageElement[] = []
let previewCatalog: PreviewCatalog | undefined

export const registerGoogleFontPreviews = (catalog: PreviewCatalog): void => {
  previewCatalog = catalog
}

export const googleFontPreviewStyle = (family: string): CSSProperties | undefined => {
  const preview = previewCatalog?.families[family]
  const asset = preview ? googleFontPreviewAssets[preview.atlas] : undefined
  if (!previewCatalog || !preview || !asset) return undefined
  return {
    width: preview.width * scale,
    backgroundImage: `url(${asset})`,
    backgroundPosition: `${-preview.x * scale}px ${-preview.y * scale}px`,
    backgroundSize: `${previewCatalog.atlasWidth * scale}px ${previewCatalog.atlasHeight * scale}px`,
  }
}

export const preloadGoogleFontPreviews = (): void => {
  if (typeof Image === 'undefined' || preloadImages.length > 0) return
  for (const source of googleFontPreviewAssets) {
    const image = new Image()
    image.fetchPriority = 'low'
    image.src = source
    preloadImages.push(image)
  }
}
