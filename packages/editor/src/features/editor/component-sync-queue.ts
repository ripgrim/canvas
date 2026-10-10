export type ComponentSyncDraft = Readonly<{
  fileId: string
  componentIds: readonly string[]
  sourceLocation: string
  destination: string
}>

export type ComponentSyncTransport = Readonly<{
  enqueue(request: ComponentSyncDraft): Promise<void>
}>

let transport: ComponentSyncTransport | undefined
const browserQueue = new Map<string, Set<string>>()

/** Renderer-side queue boundary. A desktop bridge must persist and execute requests outside the renderer. */
export const componentSyncQueue = {
  configure(next: ComponentSyncTransport | undefined) { transport = next },
  queueBrowserUse(fileId: string, componentId: string) {
    const components = browserQueue.get(fileId) ?? new Set<string>()
    components.add(componentId)
    browserQueue.set(fileId, components)
  },
  pendingComponentIds(fileId: string): readonly string[] { return [...(browserQueue.get(fileId) ?? [])] },
  async submit(request: ComponentSyncDraft): Promise<boolean> {
    if (!transport) return false
    await transport.enqueue(request)
    browserQueue.delete(request.fileId)
    return true
  },
  reset() { transport = undefined; browserQueue.clear() },
}
