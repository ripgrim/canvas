export type ServiceFetcher = Readonly<{ fetch(request: Request): Promise<Response> }>
