export type ShadcnDiagnostic = Readonly<{
  code: 'invalid-config' | 'missing-css' | 'missing-ui-root' | 'unsupported-export' | 'unsupported-preview-component'
  path: string
  message: string
}>

export type ShadcnConfig = Readonly<{
  source: 'manifest' | 'inferred'
  path: string
  workspace: string
  uiAlias: string | null
  uiRoots: readonly string[]
  registryRoots: readonly string[]
  tokenFiles: readonly string[]
  registries: readonly string[]
  moduleConfig: ShadcnModuleConfig | null
  previewProvider: ShadcnPreviewProviderConfig | null
  themeAdapters: readonly ShadcnThemeAdapterConfig[]
}>

export type ShadcnPreviewProviderConfig = Readonly<{ entryPath: string; exportName: string; props: Readonly<Record<string, string | number | boolean | null>> }>
export type ShadcnThemeAdapterConfig = Readonly<{ entryPath: string; exportName: string }>

export type ShadcnModuleConfig = Readonly<{
  path: string
  baseUrl: string
  paths: Readonly<Record<string, readonly string[]>>
}>

export type ShadcnProp = Readonly<{ name: string; type: string; optional: boolean }>

export type ShadcnComponent = Readonly<{
  path: string
  exportName: string
  declarationKind: 'function' | 'variable' | 'forwardRef' | 'memo'
  props: readonly ShadcnProp[]
  slots: readonly string[]
  sourceHash: string
  fingerprint: string
}>

export type ShadcnToken = Readonly<{
  name: string
  value: string
  path: string
  selector: string
  atRules: readonly string[]
  theme: string
  aliases: readonly string[]
  line: number
  column: number
}>

export type ShadcnScan = Readonly<{
  adapterId: 'shadcn-v1'
  configs: readonly ShadcnConfig[]
  components: readonly ShadcnComponent[]
  tokens: readonly ShadcnToken[]
  sourceHashes: Readonly<Record<string, string>>
  diagnostics: readonly ShadcnDiagnostic[]
  previewDependencies?: readonly Readonly<{ path: string; integrity: string }>[]
  previewResolutions?: readonly Readonly<{ importer: string; specifier: string; path: string }>[]
}>

export type ShadcnPreviewPropRule =
  | Readonly<{ kind: 'string' | 'number' | 'boolean'; optional: boolean }>
  | Readonly<{ kind: 'enum'; values: readonly (string | number | boolean)[]; optional: boolean }>

export type ShadcnPreviewRegistryComponent = Readonly<{
  componentId: string
  entryPath: string
  exportName: string
  integrity: string
  props: Readonly<Record<string, ShadcnPreviewPropRule>>
  slots: readonly string[]
}>

export type ShadcnPreviewRegistryRequest = Readonly<{
  version: 1
  entry: Readonly<{ componentId: string }>
  components: readonly ShadcnPreviewRegistryComponent[]
  styles: readonly Readonly<{ path: string; integrity: string }>[]
  aliases?: readonly Readonly<{
    configPath: string
    integrity: string
    baseUrl: string
    paths: readonly Readonly<{ pattern: string; target: string }>[]
  }>[]
  dependencies?: readonly Readonly<{ path: string; integrity: string }>[]
  resolutions?: readonly Readonly<{ importer: string; specifier: string; path: string }>[]
  provider?: Readonly<ShadcnPreviewProviderConfig & { integrity: string; evidence: Readonly<{ configPath: string; integrity: string }> }>
  themeAdapters?: readonly Readonly<ShadcnThemeAdapterConfig & { integrity: string; evidence: Readonly<{ configPath: string; integrity: string }> }>[]
}>

/** Read-only scanner output that can be reverified immediately before either preview consumer starts. */
export type ShadcnPreviewRegistry = Readonly<{
  request: ShadcnPreviewRegistryRequest
  fingerprint: string
  entryComponentId: string
}>

/** Renderer-safe catalog derived from the exact scanned components admitted to the verified preview registry. */
export type ShadcnComponentCatalogEntry = Readonly<{
  componentId: string
  path: string
  exportName: string
  sourceHash: string
  props: readonly ShadcnProp[]
  slots: readonly string[]
}>

export type ShadcnComponentCatalog = Readonly<{
  fingerprint: string
  components: readonly ShadcnComponentCatalogEntry[]
}>

export type VerifiedShadcnScan = Readonly<{ scan: ShadcnScan; registry: ShadcnPreviewRegistry }>
