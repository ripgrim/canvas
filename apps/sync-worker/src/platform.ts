export type DurableObjectStub = Readonly<{ fetch(request: Request): Promise<Response> }>
export type DurableObjectNamespace = Readonly<{ idFromName(name: string): unknown; get(id: unknown): DurableObjectStub }>
