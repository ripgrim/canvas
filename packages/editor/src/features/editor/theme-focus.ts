/**
 * Requests to show one theme token in the Theme tab, sent from places that cannot reach the Theme panel's own state
 * (the appearance inspector's Edit token action). A request only increments a sequence; readers derive what to show
 * during render and acknowledge from their own event handlers, so nothing here needs a lifecycle hook.
 */
export type ThemeFocusRequest = Readonly<{ sequence: number; tokenId: string }>
export type ThemeFocusSnapshot = Readonly<{ request: ThemeFocusRequest | null; acknowledged: number }>
export type SidebarView = 'design' | 'theme' | 'kit' | 'sources'
/** The sidebar view the user last picked, with the request sequence current at that moment. */
export type SidebarChoice = Readonly<{ view: SidebarView; at: number }>

const initial: ThemeFocusSnapshot = { request: null, acknowledged: 0 }

export function createThemeFocus() {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const emit = (next: ThemeFocusSnapshot) => { snapshot = next; for (const listener of [...listeners]) listener() }
  return {
    getSnapshot: (): ThemeFocusSnapshot => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** Asks the Theme tab to show and select this token. Returns the request sequence. */
    request: (tokenId: string): number => {
      const sequence = (snapshot.request?.sequence ?? 0) + 1
      emit({ request: { sequence, tokenId }, acknowledged: snapshot.acknowledged })
      return sequence
    },
    /** Marks every request up to `sequence` as handled; older or repeated acknowledgements change nothing. */
    acknowledge: (sequence: number) => { if (sequence > snapshot.acknowledged) emit({ ...snapshot, acknowledged: sequence }) },
    dispose: () => { listeners.clear(); snapshot = initial },
  }
}

/** The request the Theme panel has not handled yet, if any. */
export const pendingFocus = (snapshot: ThemeFocusSnapshot): ThemeFocusRequest | null => snapshot.request && snapshot.request.sequence > snapshot.acknowledged ? snapshot.request : null

/** Latest request sequence, for recording alongside a sidebar choice. */
export const focusSequence = (snapshot: ThemeFocusSnapshot): number => snapshot.request?.sequence ?? 0

/** A request newer than the user's last tab choice shows the Theme tab; otherwise the choice stands. */
export const sidebarViewFor = (snapshot: ThemeFocusSnapshot, choice: SidebarChoice): SidebarView => focusSequence(snapshot) > choice.at ? 'theme' : choice.view

export const themeFocus = createThemeFocus()
