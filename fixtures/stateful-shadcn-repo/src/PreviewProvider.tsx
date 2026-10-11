import type { ReactNode } from 'react'
import { PreviewBrandProvider } from '@/preview/context'

export function PreviewProvider({ brand, children }: Readonly<{ brand: string; children?: ReactNode }>) {
  return <PreviewBrandProvider brand={brand}>{children}</PreviewBrandProvider>
}
