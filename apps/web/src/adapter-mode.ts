export type WebAdapterMode =
  | Readonly<{ kind: 'desktop' }>
  | Readonly<{ kind: 'cloud'; apiOrigin: string }>
  | Readonly<{ kind: 'browser-test' }>

export function resolveWebAdapterMode(input: Readonly<{ desktop: boolean; apiOrigin?: string; development: boolean; browserTestStorage: boolean }>): WebAdapterMode {
  if (input.desktop) return Object.freeze({ kind: 'desktop' })
  if (input.browserTestStorage) return Object.freeze({ kind: 'browser-test' })
  const apiOrigin = input.apiOrigin?.trim() || (input.development ? 'http://127.0.0.1:4320' : '')
  if (!apiOrigin) throw new Error('VITE_API_ORIGIN is required for account-backed files.')
  return Object.freeze({ kind: 'cloud', apiOrigin })
}
