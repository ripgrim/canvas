import { describe, expect, it, vi } from 'vitest'

vi.mock('@canvas/preview-runtime/browser', () => ({ startPreview: vi.fn() }))
vi.mock('../../../tests/fixtures/component-repo-seed/src/PreviewLogin', () => ({ PreviewLogin: function PreviewLogin() {} }))
vi.mock('../../../tests/fixtures/component-repo-seed/src/atoms/Button', () => ({ Button: function Button() {} }))
vi.mock('../../../tests/fixtures/component-repo-seed/src/atoms/Card', () => ({ Card: function Card() {} }))
vi.mock('../../../tests/fixtures/component-repo-seed/src/atoms/Input', () => ({ Input: function Input() {} }))
vi.mock('../../../tests/fixtures/component-repo-seed/src/atoms/Label', () => ({ Label: function Label() {} }))
vi.stubGlobal('window', { location: { search: '?editorOrigin=design-editor%3A%2F%2Fapp&mode=composition', origin: 'https://preview.canvas.test' } })

const { startPreview } = await import('@canvas/preview-runtime/browser')
const { requireEditorOrigin } = await import('./main')

describe('bundled preview editor origin', () => {
  it('accepts the registered desktop origin and canonical remote origins', () => {
    expect(startPreview).toHaveBeenCalledWith(expect.objectContaining({ editorOrigin: 'design-editor://app' }))
    expect(requireEditorOrigin('design-editor://app', 'https://preview.canvas.test')).toBe('design-editor://app')
    expect(requireEditorOrigin('https://app.canvas.test', 'https://preview.canvas.test')).toBe('https://app.canvas.test')
  })

  it('rejects unregistered custom schemes and non-origin URLs', () => {
    for (const origin of ['other-editor://app', 'design-editor://other', 'design-editor://app/', 'design-editor://app.evil', 'https://app.canvas.test/path']) {
      expect(() => requireEditorOrigin(origin, 'https://preview.canvas.test')).toThrow('A separate editor origin is required.')
    }
  })

  it('rejects the preview origin itself', () => {
    expect(() => requireEditorOrigin('https://preview.canvas.test', 'https://preview.canvas.test')).toThrow('A separate editor origin is required.')
  })
})
