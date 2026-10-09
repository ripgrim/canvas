import type { ReactNode } from 'react'
import './selection.css'

export function SelectionOverlay({ children }: { children: ReactNode }) { return <div className="canvas-selection-overlay" aria-hidden="true">{children}</div> }
