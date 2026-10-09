export type PreviewSnapshot = {
  status: 'stopped' | 'building' | 'ready' | 'error' | 'disposed'
  currentGeneration: number
  activeGeneration: number | null
  origin: string | null
  url: string | null
  stale: boolean
  diagnostics: readonly string[]
}
