import type { Rect, Size } from './canvas-math'
import type { CanvasTransient } from './document-store'
import { documentStore } from './document-store'

export const editorMobileBreakpoint = 760

export type EditorMobilePanel = 'layers' | 'design' | null

export const toggleMobilePanel = (current: EditorMobilePanel, requested: Exclude<EditorMobilePanel, null>): EditorMobilePanel => current === requested ? null : requested

export const mobilePanelVisibility = (panel: EditorMobilePanel, readOnly: boolean) => ({
  left: panel === 'layers',
  right: !readOnly && panel === 'design',
})

export const mobileQuickActionsPosition = (selection: Rect, viewport: Size, toolbar = { width: 180, height: 44 }): { x: number; y: number } => {
  const inset = 8
  const dimensionBadgeClearance = 28
  const x = Math.max(inset, Math.min(selection.x, viewport.width - toolbar.width - inset))
  const below = selection.y + selection.height + dimensionBadgeClearance + inset
  const y = below + toolbar.height <= viewport.height - inset
    ? below
    : Math.max(inset, selection.y - toolbar.height - inset)
  return { x: Math.round(x), y: Math.round(y) }
}

export type MobileQuickActionsPhase = 'idle' | 'moving' | 'resizing'
export const mobileQuickActionsPhase = (transient: CanvasTransient | null): MobileQuickActionsPhase => transient?.kind === 'move' ? 'moving' : transient?.kind === 'resize' ? 'resizing' : 'idle'
let quickActionsPhase: MobileQuickActionsPhase = 'idle'
export const mobileQuickActionsPhaseSnapshot = (): MobileQuickActionsPhase => {
  const next = mobileQuickActionsPhase(documentStore.getSnapshot().transient)
  if (next !== quickActionsPhase) quickActionsPhase = next
  return quickActionsPhase
}

const query = typeof window === 'undefined' ? null : window.matchMedia(`(max-width: ${editorMobileBreakpoint}px)`)
let mobileSnapshot = query?.matches ?? false
const mobileListeners = new Set<() => void>()
const onViewportChange = (event: MediaQueryListEvent) => {
  if (mobileSnapshot === event.matches) return
  mobileSnapshot = event.matches
  for (const listener of mobileListeners) listener()
}

export const mobileViewport = {
  subscribe(listener: () => void) {
    if (mobileListeners.size === 0) query?.addEventListener('change', onViewportChange)
    mobileListeners.add(listener)
    return () => {
      mobileListeners.delete(listener)
      if (mobileListeners.size === 0) query?.removeEventListener('change', onViewportChange)
    }
  },
  getSnapshot: () => mobileSnapshot,
  getServerSnapshot: () => false,
}
