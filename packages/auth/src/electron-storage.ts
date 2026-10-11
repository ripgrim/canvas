export type AuthStorage = Readonly<{
  getItem(name: string): unknown | null
  setItem(name: string, value: unknown): void
}>

export type AuthStorageBackend = Readonly<{
  get(name: string): unknown
  set(name: string, value: string): void
}>

export type AuthStorageProtection = Readonly<{
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}>

export type ElectronSessionStorageOptions = Readonly<{
  backend: AuthStorageBackend
  protection: AuthStorageProtection
  platform: NodeJS.Platform
}>

const envelopePrefix = 'canvas-safe-storage:v1:'
const protectedLinuxBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

export function isProtectedAuthStorageValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(envelopePrefix)
}

function protectionAvailable(protection: AuthStorageProtection, platform: NodeJS.Platform): boolean {
  try {
    if (!protection.isEncryptionAvailable()) return false
  } catch {
    return false
  }
  if (platform !== 'linux') return true
  try {
    const backend = protection.getSelectedStorageBackend?.()
    return backend !== undefined && protectedLinuxBackends.has(backend)
  } catch {
    return false
  }
}

function encodedCiphertext(value: Buffer): string {
  return `${envelopePrefix}${value.toString('base64')}`
}

function decodeCiphertext(value: string): Buffer | null {
  if (!value.startsWith(envelopePrefix)) return null
  const encoded = value.slice(envelopePrefix.length)
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null
  const ciphertext = Buffer.from(encoded, 'base64')
  return ciphertext.toString('base64') === encoded ? ciphertext : null
}

/**
 * Main-process-only storage. Persistent values are encrypted with Electron safeStorage.
 * When OS-backed encryption is unavailable, values live in memory for this process and
 * are deliberately not recovered from or written to the persistent backend.
 */
export function createElectronSessionStorage(options: ElectronSessionStorageOptions): AuthStorage {
  const { backend, protection, platform } = options
  const volatile = new Map<string, unknown>()
  return Object.freeze({
    getItem(name: string): unknown | null {
      if (volatile.has(name)) return volatile.get(name) ?? null
      if (!protectionAvailable(protection, platform)) return volatile.get(name) ?? null
      let stored: unknown
      try {
        stored = backend.get(name)
      } catch {
        return null
      }
      if (typeof stored !== 'string') return null
      const ciphertext = decodeCiphertext(stored)
      if (!ciphertext) return null
      try {
        const envelope = JSON.parse(protection.decryptString(ciphertext)) as unknown
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null
        const record = envelope as Record<string, unknown>
        if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'value')) return null
        return record.value ?? null
      } catch {
        return null
      }
    },
    setItem(name: string, value: unknown): void {
      if (!protectionAvailable(protection, platform)) {
        volatile.set(name, value)
        return
      }
      try {
        const plaintext = JSON.stringify({ value })
        backend.set(name, encodedCiphertext(protection.encryptString(plaintext)))
        volatile.delete(name)
      } catch {
        volatile.set(name, value)
      }
    },
  })
}

/** Wraps the Electron plugin's already-encrypted legacy values without decrypting them. */
export function migrateLegacyEncryptedAuthStorage(options: ElectronSessionStorageOptions, storage: AuthStorage, names: readonly string[]): void {
  const { backend, protection, platform } = options
  if (!protectionAvailable(protection, platform)) return
  for (const name of names) {
    const value = backend.get(name)
    if (typeof value === 'string' && value && !isProtectedAuthStorageValue(value)) storage.setItem(name, value)
  }
}
