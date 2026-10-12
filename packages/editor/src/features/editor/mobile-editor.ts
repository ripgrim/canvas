import type { Rect, Size } from './canvas-math'
import type { CanvasTransient } from './document-store'
import { documentStore } from './document-store'
import type { HudProjectionFrame } from './canvas-hud-projection'

export const editorMobileBreakpoint = 760

export type EditorMobilePanel = 'layers' | 'design' | null

export const toggleMobilePanel = (current: EditorMobilePanel, requested: Exclude<EditorMobilePanel, null>): EditorMobilePanel => current === requested ? null : requested

export const mobilePanelVisibility = (panel: EditorMobilePanel, readOnly: boolean) => ({
  left: panel === 'layers',
  right: !readOnly && panel === 'design',
})

export const mobileQuickActionsPosition = (selection: Rect, viewport: Size, dimension?: Readonly<{ anchor: Readonly<{ x: number; y: number }> }>, toolbar = { width: 180, height: 44 }): { x: number; y: number } => {
  const inset = 8
  const dimensionBadgeClearance = 28
  const x = Math.max(inset, Math.min(selection.x, viewport.width - toolbar.width - inset))
  const below = dimension
    ? Math.max(selection.y + selection.height + inset, dimension.anchor.y + 20 + inset)
    : selection.y + selection.height + dimensionBadgeClearance + inset
  const y = below + toolbar.height <= viewport.height - inset
    ? below
    : Math.max(inset, selection.y - toolbar.height - inset)
  return { x: Math.round(x), y: Math.round(y) }
}

export type MobileQuickActionsPhase = 'idle' | 'moving' | 'resizing'
export const shouldMountMobileQuickActions = (frame: HudProjectionFrame | null, eligible: boolean): boolean => eligible && frame?.key.mobile === true
export const mobileQuickActionsPhase = (transient: CanvasTransient | null, frame: HudProjectionFrame | null = null): MobileQuickActionsPhase => frame?.flowDrag
  ? 'moving'
  : transient?.kind === 'move' ? 'moving' : transient?.kind === 'resize' ? 'resizing' : 'idle'
let quickActionsPhase: MobileQuickActionsPhase = 'idle'
export const mobileQuickActionsPhaseSnapshot = (): MobileQuickActionsPhase => {
  const next = mobileQuickActionsPhase(documentStore.getSnapshot().transient)
  if (next !== quickActionsPhase) quickActionsPhase = next
  return quickActionsPhase
}

export type MobileQuickActionsRenderSnapshot<T> = Readonly<{ phase: MobileQuickActionsPhase; projection: T }>

/** Keeps the last canonical toolbar pose while hidden and ignores per-sample drag publications. */
export function stableMobileQuickActionsSnapshot<T>(current: MobileQuickActionsRenderSnapshot<T>, phase: MobileQuickActionsPhase, projection: T, hasCanonicalFrame: (value: T) => boolean): MobileQuickActionsRenderSnapshot<T> {
  if (phase !== 'idle') {
    if (current.phase === phase) return current
    return Object.freeze({ phase, projection: hasCanonicalFrame(current.projection) ? current.projection : projection })
  }
  if (current.phase === phase && current.projection === projection) return current
  return Object.freeze({ phase, projection })
}

/** External-store adapter that suppresses notifications while the hidden gesture phase is unchanged. */
export function createStableMobileQuickActionsStore<T>(
  read: () => MobileQuickActionsRenderSnapshot<T>,
  subscribeSources: (listener: () => void) => () => void,
  hasCanonicalFrame: (value: T) => boolean,
) {
  const initial = read()
  let snapshot = Object.freeze({ phase: initial.phase, projection: initial.projection })
  const getSnapshot = () => {
    const next = read()
    snapshot = stableMobileQuickActionsSnapshot(snapshot, next.phase, next.projection, hasCanonicalFrame)
    return snapshot
  }
  const subscribe = (listener: () => void) => {
    let current = getSnapshot()
    return subscribeSources(() => {
      const next = getSnapshot()
      if (next === current) return
      current = next
      listener()
    })
  }
  return Object.freeze({ getSnapshot, subscribe })
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
