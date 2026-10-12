export type ContainerPort = Readonly<{ fetch(request: Request | string, init?: RequestInit): Promise<Response> }>
export type ContainerInstance = Readonly<{
  running: boolean
  start(options?: Readonly<{ env?: Readonly<Record<string, string>> }>): void
  setInactivityTimeout(durationMs: number): Promise<void>
  getTcpPort(port: number): ContainerPort
}>
export type DurableObjectContext = Readonly<{
  container: ContainerInstance | null
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}>
export type DurableObjectStub = Readonly<{ fetch(request: Request): Promise<Response> }>
export type DurableObjectNamespace = Readonly<{ idFromName(name: string): unknown; get(id: unknown): DurableObjectStub }>
