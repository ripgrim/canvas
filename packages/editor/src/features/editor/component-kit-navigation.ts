export type ComponentKitLocation = Readonly<{ fileId: string; componentId: string; sequence: number }> | null

let location: ComponentKitLocation = null
let sequence = 0
const listeners = new Set<() => void>()

function emit(next: ComponentKitLocation) {
  location = next
  for (const listener of [...listeners]) listener()
}

export const componentKitNavigation = Object.freeze({
  getSnapshot: (): ComponentKitLocation => location,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  open: (fileId: string, componentId: string) => emit({ fileId, componentId, sequence: ++sequence }),
  back: () => emit(null),
})

export function componentKitSidebarView<T extends string>(location: ComponentKitLocation, fileId: string | undefined, choice: Readonly<{ view: T; kitAt: number }>): T | 'kit' {
  return location && location.fileId === fileId && location.sequence > choice.kitAt ? 'kit' : choice.view
}
