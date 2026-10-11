import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createElectronSessionStorage, migrateLegacyEncryptedAuthStorage } from '../src/electron-storage'

function protection(key = randomBytes(32)) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted])
    },
    decryptString: (value: Buffer) => {
      const nonce = value.subarray(0, 12)
      const tag = value.subarray(12, 28)
      const encrypted = value.subarray(28)
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    },
  }
}

function backend(seed: Map<string, string> = new Map()) {
  return {
    values: seed,
    storage: {
      get: (name: string) => seed.get(name),
      set: (name: string, value: string) => { seed.set(name, value) },
    },
  }
}

function sessionStorage(disk: ReturnType<typeof backend>, safeStorage: ReturnType<typeof protection> | {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}, platform: NodeJS.Platform = 'win32') {
  return createElectronSessionStorage({ backend: disk.storage, protection: safeStorage, platform })
}

describe('Electron auth storage protection', () => {
  it('AT-AUTH-001 stores cookie and cache material only as protected ciphertext and survives a restart', () => {
    const disk = backend()
    const safeStorage = protection(Buffer.alloc(32, 7))
    const first = sessionStorage(disk, safeStorage)
    const cookie = 'better-auth.session_token=secret-bearer-value'
    first.setItem('design-editor-auth.cookie', cookie)

    const persisted = disk.values.get('design-editor-auth.cookie')
    expect(persisted).toMatch(/^canvas-safe-storage:v1:/)
    expect(persisted).not.toContain(cookie)
    expect(persisted).not.toContain('secret-bearer-value')

    const restarted = sessionStorage(disk, safeStorage)
    expect(restarted.getItem('design-editor-auth.cookie')).toBe(cookie)
  })

  it('AT-AUTH-001 fails closed when persisted material is opened with the wrong protection key', () => {
    const disk = backend()
    sessionStorage(disk, protection(Buffer.alloc(32, 1))).setItem('design-editor-auth.cookie', 'secret')
    expect(sessionStorage(disk, protection(Buffer.alloc(32, 2))).getItem('design-editor-auth.cookie')).toBeNull()
  })

  it('AT-AUTH-001 uses an honest memory-only fallback when OS encryption is unavailable', () => {
    const disk = backend(new Map([['design-editor-auth.cookie', 'plaintext-must-not-be-read']]))
    const unavailable = {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('must not encrypt') },
      decryptString: () => { throw new Error('must not decrypt') },
    }
    const current = sessionStorage(disk, unavailable)
    expect(current.getItem('design-editor-auth.cookie')).toBeNull()
    current.setItem('design-editor-auth.cookie', 'process-only-secret')
    expect(current.getItem('design-editor-auth.cookie')).toBe('process-only-secret')
    expect(disk.values.get('design-editor-auth.cookie')).toBe('plaintext-must-not-be-read')
    expect(sessionStorage(disk, unavailable).getItem('design-editor-auth.cookie')).toBeNull()
  })

  it('treats Electron basic_text storage as unavailable instead of claiming encryption', () => {
    const disk = backend()
    const basicText = {
      ...protection(Buffer.alloc(32, 4)),
      getSelectedStorageBackend: () => 'basic_text',
    }
    const storage = sessionStorage(disk, basicText, 'linux')
    storage.setItem('design-editor-auth.cookie', 'process-only-secret')
    expect(storage.getItem('design-editor-auth.cookie')).toBe('process-only-secret')
    expect(disk.values.size).toBe(0)
    expect(sessionStorage(disk, basicText, 'linux').getItem('design-editor-auth.cookie')).toBeNull()
  })

  it.each([
    ['missing', undefined],
    ['unknown', (): string => 'unknown'],
    ['unrecognized', (): string => 'plaintext'],
    ['throwing', (): string => { throw new Error('backend unavailable') }],
  ] as const)('fails closed on Linux when backend introspection is %s', (_label, getSelectedStorageBackend) => {
    const disk = backend()
    const linuxProtection = {
      ...protection(Buffer.alloc(32, 5)),
      ...(getSelectedStorageBackend ? { getSelectedStorageBackend } : {}),
    }
    const storage = sessionStorage(disk, linuxProtection, 'linux')
    storage.setItem('design-editor-auth.cookie', 'process-only-secret')
    expect(storage.getItem('design-editor-auth.cookie')).toBe('process-only-secret')
    expect(disk.values.size).toBe(0)
    expect(sessionStorage(disk, linuxProtection, 'linux').getItem('design-editor-auth.cookie')).toBeNull()
  })

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])('persists only with an explicitly protected Linux backend: %s', backendName => {
    const disk = backend()
    const linuxProtection = { ...protection(Buffer.alloc(32, 10)), getSelectedStorageBackend: () => backendName }
    const storage = sessionStorage(disk, linuxProtection, 'linux')
    storage.setItem('design-editor-auth.cookie', 'secret')
    expect(disk.values.get('design-editor-auth.cookie')).toMatch(/^canvas-safe-storage:v1:/)
    expect(storage.getItem('design-editor-auth.cookie')).toBe('secret')
  })

  it('uses safeStorage on non-Linux platforms without Linux backend introspection', () => {
    const disk = backend()
    const platformProtection = { ...protection(Buffer.alloc(32, 6)), getSelectedStorageBackend: () => { throw new Error('unsupported platform') } }
    const storage = sessionStorage(disk, platformProtection, 'win32')
    storage.setItem('design-editor-auth.cookie', 'secret')
    expect(disk.values.get('design-editor-auth.cookie')).toMatch(/^canvas-safe-storage:v1:/)
    expect(storage.getItem('design-editor-auth.cookie')).toBe('secret')
  })

  it('preserves the Electron plugin encrypted session across the storage hardening migration', () => {
    const legacyPluginCiphertext = 'base64-ciphertext-created-by-better-auth-electron'
    const disk = backend(new Map([['design-editor-auth.cookie', legacyPluginCiphertext]]))
    const safeStorage = protection(Buffer.alloc(32, 9))
    const storage = sessionStorage(disk, safeStorage)
    migrateLegacyEncryptedAuthStorage({ backend: disk.storage, protection: safeStorage, platform: 'win32' }, storage, ['design-editor-auth.cookie'])
    expect(disk.values.get('design-editor-auth.cookie')).toMatch(/^canvas-safe-storage:v1:/)
    expect(disk.values.get('design-editor-auth.cookie')).not.toContain(legacyPluginCiphertext)
    expect(storage.getItem('design-editor-auth.cookie')).toBe(legacyPluginCiphertext)
  })

  it('does not recover a legacy disk session when Linux protection fails closed', () => {
    const legacyPluginCiphertext = 'base64-ciphertext-created-by-better-auth-electron'
    const disk = backend(new Map([['design-editor-auth.cookie', legacyPluginCiphertext]]))
    const linuxProtection = { ...protection(Buffer.alloc(32, 8)), getSelectedStorageBackend: () => 'unknown' }
    const options = { backend: disk.storage, protection: linuxProtection, platform: 'linux' as const }
    const storage = createElectronSessionStorage(options)
    migrateLegacyEncryptedAuthStorage(options, storage, ['design-editor-auth.cookie'])
    expect(storage.getItem('design-editor-auth.cookie')).toBeNull()
    expect(disk.values.get('design-editor-auth.cookie')).toBe(legacyPluginCiphertext)
  })

  it.each(['plaintext', 'canvas-safe-storage:v1:not base64', 'canvas-safe-storage:v1:YWJjZA'])('rejects unprotected or malformed persisted data: %s', value => {
    const disk = backend(new Map([['design-editor-auth.cookie', value]]))
    expect(sessionStorage(disk, protection(Buffer.alloc(32, 3))).getItem('design-editor-auth.cookie')).toBeNull()
  })
})
