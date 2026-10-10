export type ShadcnDiagnostic = Readonly<{
  code: 'invalid-config' | 'missing-css' | 'missing-ui-root' | 'unsupported-export'
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
}>
