import type { JsonValue, PreviewPropRule, PreviewRegistryBinding } from './protocol.js'
// TypeScript consumers do not inspect this package's allowJs implementation. A sibling declaration would suppress
// copying that implementation during a clean build, so this typed facade is the single declaration boundary.
// @ts-ignore
import * as runtime from './verified-registry-runtime.mjs'

const { loadVerifiedRegistryManifest: loadManifest, registryRequestFromPreviewBinding: requestFromBinding, verifyComponentRegistry: verifyRegistry } = runtime

export type VerifiedPropRule = PreviewPropRule

export type VerifiedRegistryFile = Readonly<{
  path: string
  absolutePath: string
  integrity: string
  bytes: Uint8Array
}>

export type VerifiedRegistryAlias = Readonly<{
  configPath: string
  absolutePath: string
  integrity: string
  bytes: Uint8Array
  baseUrl: string
  paths: readonly Readonly<{ pattern: string; target: string }>[]
}>

export type VerifiedRegistryResolution = Readonly<{
  importer: string
  specifier: string
  path: string
  absolutePath: string
}>

export type VerifiedRegistryComponent = Readonly<{
  componentId: string
  entryPath: string
  exportName: string
  absolutePath: string
  integrity: string
  bytes: Uint8Array
  props?: Readonly<Record<string, VerifiedPropRule>>
  slots?: readonly string[]
}>

export type VerifiedRegistryProvider = Readonly<{
  entryPath: string
  exportName: string
  absolutePath: string
  integrity: string
  bytes: Uint8Array
  props: Readonly<Record<string, JsonValue>>
  evidence: Readonly<{ configPath: string; absolutePath: string; integrity: string; bytes: Uint8Array }>
}>

export type VerifiedRegistryAsset = Readonly<{
  assetId: string
  sourcePath: string
  publicPath: string
  mime: string
  absolutePath: string
  integrity: string
  bytes: Uint8Array
}>

export type VerifiedRegistryFont = Readonly<{
  family: string
  assetId: string
  weight: string
  style: 'normal' | 'italic' | 'oblique'
  display: 'auto' | 'block' | 'swap' | 'fallback' | 'optional'
}>

export type VerifiedRegistryPackageResolution = Readonly<{
  manifest: VerifiedRegistryFile
  lockfile: VerifiedRegistryFile
  specifiers: readonly Readonly<{ specifier: string; packageName: string; absolutePath: string; packageRoot: string }>[]
  packages: readonly Readonly<{ name: string; root: string; absolutePath: string; integrity: string; bytes: Uint8Array }>[]
}>

export type VerifiedComponentRegistry = Readonly<{
  version: 1
  repositoryRoot: string
  fingerprint: string
  entry: VerifiedRegistryComponent
  components: readonly VerifiedRegistryComponent[]
  styles: readonly VerifiedRegistryFile[]
  provider?: VerifiedRegistryProvider
  themeAdapters: readonly Omit<VerifiedRegistryProvider, 'props'>[]
  aliases: readonly VerifiedRegistryAlias[]
  dependencies: readonly VerifiedRegistryFile[]
  resolutions: readonly VerifiedRegistryResolution[]
  packageResolution?: VerifiedRegistryPackageResolution
  assets: readonly VerifiedRegistryAsset[]
  fonts: readonly VerifiedRegistryFont[]
}>

export type VerifiedRegistryRequest = Readonly<{
  version: 1
  entry: Readonly<{ componentId: string }>
  components: readonly (PreviewRegistryBinding & Readonly<{ integrity?: string }>)[]
  styles?: readonly Readonly<{ path: string; integrity?: string }>[]
  provider?: Readonly<{ entryPath: string; exportName: string; props?: Record<string, JsonValue>; integrity?: string; evidence?: Readonly<{ configPath: string; integrity?: string }> }>
  themeAdapters?: readonly Readonly<{ entryPath: string; exportName: string; integrity?: string; evidence?: Readonly<{ configPath: string; integrity?: string }> }>[]
  aliases?: readonly Readonly<{ configPath: string; integrity?: string; baseUrl: string; paths: readonly Readonly<{ pattern: string; target: string }>[] }>[]
  dependencies?: readonly Readonly<{ path: string; integrity: string }>[]
  assets?: readonly Readonly<{ assetId: string; sourcePath: string; publicPath: string; mime: string; integrity?: string }>[]
  fonts?: readonly Readonly<{ family: string; assetId: string; weight?: string; style?: 'normal' | 'italic' | 'oblique'; display?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional' }>[]
}>

export const verifyComponentRegistry = verifyRegistry as (repositoryRoot: string, request: VerifiedRegistryRequest) => Promise<VerifiedComponentRegistry>
export const registryRequestFromPreviewBinding = requestFromBinding as (binding: Readonly<{
  componentId: string
  entryPath: string
  exportName: string
  styles?: readonly string[]
  provider?: VerifiedRegistryRequest['provider']
  themeAdapters?: VerifiedRegistryRequest['themeAdapters']
  aliases?: VerifiedRegistryRequest['aliases']
  dependencies?: VerifiedRegistryRequest['dependencies']
  assets?: VerifiedRegistryRequest['assets']
  fonts?: VerifiedRegistryRequest['fonts']
  registry?: readonly PreviewRegistryBinding[]
}>) => VerifiedRegistryRequest
export const loadVerifiedRegistryManifest = loadManifest as (manifestPath?: string) => Promise<VerifiedComponentRegistry | null>
