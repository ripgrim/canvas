import { createContext, createElement, type ReactNode } from 'react'

/** Effective design theme of one preview instance, as the preview runtime hands it to a verified adapter. */
export type FixturePreviewTheme = { mode: 'light' | 'dark'; designThemeId: string; attribute: string | null; colorScheme: 'light' | 'dark'; explicit: boolean }
type RegisterPortalRoot = (instanceId: string, root: Element, dispose?: () => void) => () => void
type Claim = { instanceId: string; root: Element; release: () => void }
type AdapterWindow = Window & {
  __adapterCalls?: { instanceId: string; theme: FixturePreviewTheme }[]
  __themeAdapter?: { claim: (instanceId: string, root: Element) => void; release: (root: Element) => boolean; owners: () => string[] }
}

const FixtureTheme = createContext<FixturePreviewTheme | null>(null)
const adapterWindow = () => window as AdapterWindow

/**
 * Verified theme adapter for this fixture. Cards get a context provider boundary (no DOM node). The fixture opens its
 * dialog portal from a click inside a preview instance, so a `role="dialog"` root appended to `document.body` right
 * after a pointer press is attributed to the closest preview instance under that press. Any other body child stays
 * unclaimed. `window.__adapterCalls` and `window.__themeAdapter` exist so browser tests can observe and drive claims.
 */
export const previewThemeAdapter = {
  id: 'fixture-card-theme',
  components: ['atom-card'],
  renderBoundary({ instanceId, theme, children }: { instanceId: string; theme: FixturePreviewTheme; children: ReactNode }) {
    const target = adapterWindow()
    target.__adapterCalls = [...(target.__adapterCalls ?? []), { instanceId, theme }]
    return createElement(FixtureTheme.Provider, { value: theme }, children)
  },
  install({ registerPortalRoot }: { registerPortalRoot: RegisterPortalRoot }) {
    const claims: Claim[] = []
    let pendingOwner: string | null = null
    const claim = (instanceId: string, root: Element) => { claims.push({ instanceId, root, release: registerPortalRoot(instanceId, root) }) }
    const release = (root: Element) => {
      const owned = claims.filter(entry => entry.root === root)
      for (const entry of owned) { claims.splice(claims.indexOf(entry), 1); entry.release() }
      return owned.length > 0
    }
    const remember = (event: Event) => {
      const instance = event.target instanceof Element ? event.target.closest('[data-preview-instance]') : null
      pendingOwner = instance?.getAttribute('data-preview-instance') ?? null
    }
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.removedNodes) if (node instanceof Element) release(node)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element) || node.getAttribute('role') !== 'dialog' || pendingOwner === null) continue
          claim(pendingOwner, node)
          pendingOwner = null
        }
      }
    })
    document.addEventListener('pointerdown', remember, true)
    observer.observe(document.body, { childList: true })
    adapterWindow().__themeAdapter = { claim, release, owners: () => claims.map(entry => entry.instanceId) }
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', remember, true)
      for (const entry of [...claims]) release(entry.root)
      delete adapterWindow().__themeAdapter
    }
  },
}
