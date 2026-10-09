import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { createSelectionUrlSync } from './shell/selection-url-sync'

let selectionSync: ReturnType<typeof createSelectionUrlSync> | null = null

export function getRouter() {
  const router = createRouter({ routeTree, scrollRestoration: false })
  // The browser owns one router at a time; the selection mirror follows it so a copied file URL names the selected node.
  if (typeof window !== 'undefined') { selectionSync?.stop(); selectionSync = createSelectionUrlSync(router); selectionSync.start() }
  return router
}
declare module '@tanstack/react-router' { interface Register { router: ReturnType<typeof getRouter> } }
