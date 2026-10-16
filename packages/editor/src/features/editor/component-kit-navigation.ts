import { createComponentDocsPreviewService } from './component-docs-preview-service'
import { documentStore } from './document-store'

export type ComponentKitLocation = Readonly<{ fileId: string; componentId: string; sequence: number }> | null
type PlaygroundService = ReturnType<typeof createComponentDocsPreviewService>
type PlaygroundSession = Readonly<{ fileId: string; componentId: string; sequence: number; service: PlaygroundService; stopContextWatch: () => void }>

let location: ComponentKitLocation = null
let playground: PlaygroundSession | null = null
let sequence = 0
const listeners = new Set<() => void>()

function emit(next: ComponentKitLocation) {
  location = next
  for (const listener of [...listeners]) listener()
}

function messageHost(): Pick<Window, 'addEventListener' | 'removeEventListener'> {
  return typeof window === 'undefined' ? { addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'> : window
}

function retirePlayground() {
  playground?.stopContextWatch()
  playground?.service.disconnect()
  playground = null
}

export const componentKitNavigation = Object.freeze({
  getSnapshot: (): ComponentKitLocation => location,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  open: (fileId: string, componentId: string) => {
    retirePlayground()
    const next = { fileId, componentId, sequence: ++sequence }
    const service = createComponentDocsPreviewService(fileId, componentId, messageHost())
    const stopContextWatch = documentStore.subscribe(() => {
      const file = documentStore.getSnapshot().file
      if (!file || (file.fileId === fileId && file.componentModel.definitions[componentId])) return
      if (playground?.sequence !== next.sequence) return
      retirePlayground()
      emit(null)
    })
    playground = { ...next, service, stopContextWatch }
    emit(next)
  },
  back: () => { retirePlayground(); emit(null) },
  playground: (candidate: ComponentKitLocation): PlaygroundService | null => candidate && playground?.fileId === candidate.fileId && playground.componentId === candidate.componentId && playground.sequence === candidate.sequence ? playground.service : null,
})

export function componentKitSidebarView<T extends string>(location: ComponentKitLocation, fileId: string | undefined, choice: Readonly<{ view: T; kitAt: number }>): T | 'kit' {
  return location && location.fileId === fileId && location.sequence > choice.kitAt ? 'kit' : choice.view
}
