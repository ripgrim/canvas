export type DurableObjectStub = Readonly<{ fetch(request: Request): Promise<Response> }>
export type DurableObjectNamespace = Readonly<{ idFromName(name: string): unknown; get(id: unknown): DurableObjectStub }>
export type DurableObjectTransaction = Readonly<{
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}>
export type DurableObjectStorage = Readonly<{
  transaction<T>(callback: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T>
  list<T>(options: Readonly<{ prefix: string; limit: number }>): Promise<Map<string, T>>
  delete(keys: readonly string[]): Promise<number>
}>
export type DurableObjectContext = Readonly<{ storage: DurableObjectStorage }>
