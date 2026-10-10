export type DesktopPackageEnvironment = Readonly<{
  mode: 'local' | 'production'
  authURL: string
  loginURL: string
  previewURL: string
  assetsURL: string
}>

declare const __DESIGN_EDITOR_PACKAGE_ENVIRONMENT__: DesktopPackageEnvironment | undefined

export const desktopPackageEnvironment = typeof __DESIGN_EDITOR_PACKAGE_ENVIRONMENT__ === 'undefined'
  ? undefined
  : Object.freeze(__DESIGN_EDITOR_PACKAGE_ENVIRONMENT__)
