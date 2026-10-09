/** The page color belongs to the preview surface, not the camera-transformed scene. */
export function applyPageBackground(ownerDocument, background) {
  const color = typeof background === 'string' ? background : 'transparent'
  ownerDocument.documentElement.style.background = color
  ownerDocument.body.style.background = color
}
