export type DesktopPackageEnvironment = Readonly<{
  mode: 'local' | 'staging' | 'production'
  authURL: string
  loginURL: string
  previewURL: string
  assetsURL: string
  appURL: string
  syncURL: string
  collaborationBuildId: string
  updateURL: string
  updateChannel: 'nightly' | 'stable' | null
}>

export function desktopUpdateChannel(mode: DesktopPackageEnvironment['mode'], updatable: boolean): DesktopPackageEnvironment['updateChannel'] {
  if (!updatable || mode === 'local') return null
  return mode === 'staging' ? 'nightly' : 'stable'
}

declare const __DESIGN_EDITOR_PACKAGE_ENVIRONMENT__: DesktopPackageEnvironment | undefined

export const desktopPackageEnvironment = typeof __DESIGN_EDITOR_PACKAGE_ENVIRONMENT__ === 'undefined'
  ? undefined
  : Object.freeze(__DESIGN_EDITOR_PACKAGE_ENVIRONMENT__)
