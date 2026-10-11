declare module 'virtual:canvas-verified-component-registry' {
  import type { ComponentType } from 'react'
  export const RegistryEntry: ComponentType<Record<string, unknown>> | null
  export const RegistryProvider: ComponentType<Record<string, unknown>> | undefined
  export const registryProviderProps: Readonly<Record<string, unknown>>
  export const registryThemeAdapters: readonly ComponentType<Record<string, unknown>>[]
  export const registry: readonly { componentId: string; exportName: string; Component: ComponentType<Record<string, unknown>> }[]
  export const registryContract: Readonly<{ version: 1; fingerprint: string; entry: { componentId: string; exportName: string } | null; components: readonly { componentId: string; entryPath: string; exportName: string; integrity: string; props?: Readonly<Record<string, { kind: 'string' | 'number' | 'boolean' } | { kind: 'enum'; values: readonly (string | number | boolean)[] }>>; slots?: readonly string[] }[] }>
  export const registryAssets: Readonly<Record<string, string>>
}
