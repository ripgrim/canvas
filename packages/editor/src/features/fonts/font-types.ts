export type FontSource = 'document' | 'google' | 'local' | 'system'

export type FontStyleOption = Readonly<{
  style: 'italic' | 'normal' | 'oblique'
  weight: number
  width?: number
}>

export type FontFamilyOption = Readonly<{
  axes?: Readonly<Record<string, Readonly<{ defaultValue: number; max: number; min: number }>>>
  family: string
  label: string
  source: FontSource
  styles?: readonly FontStyleOption[]
}>

export type LocalFontStatus = 'denied' | 'given-up' | 'loaded' | 'loading' | 'prompt' | 'unsupported'

export type FontCatalogSnapshot = Readonly<{
  favorites: readonly string[]
  loadError: string | null
  localStatus: LocalFontStatus
  options: readonly FontFamilyOption[]
}>
