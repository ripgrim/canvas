import { describe, expect, it } from 'vitest'
import previewCatalog from './google-font-previews.generated.json'
import { googleFontPreviewStyle, registerGoogleFontPreviews } from './google-font-preview'

describe('FONT-PREVIEW-001 generated previews', () => {
  it('maps the catalog to a compressed atlas crop', () => {
    registerGoogleFontPreviews(previewCatalog)
    expect(Object.keys(previewCatalog.families).length).toBeGreaterThan(1900)
    expect(googleFontPreviewStyle('Abel')).toMatchObject({
      backgroundPosition: expect.any(String),
      backgroundSize: '512px 512px',
      width: expect.any(Number),
    })
  })

  it('falls back when a family has no generated crop', () => {
    expect(googleFontPreviewStyle('Missing family')).toBeUndefined()
  })
})
