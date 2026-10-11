import { createContext, useContext, type ReactNode } from 'react'

const PreviewBrandContext = createContext('Missing provider')

export function PreviewBrandProvider({ brand, children }: Readonly<{ brand: string; children?: ReactNode }>) {
  return <PreviewBrandContext.Provider value={brand}>{children}</PreviewBrandContext.Provider>
}

export function usePreviewBrand(): string {
  return useContext(PreviewBrandContext)
}
