export type DesktopAuthorization = Readonly<{ identifier: string; state: string }>

export function decodeDesktopAuthorization(token: string): DesktopAuthorization {
  if (!/^[A-Za-z0-9_-]{1,4096}={0,2}$/.test(token)) throw new Error('Desktop auth callback is invalid.')
  const unpadded = token.replace(/=+$/, '')
  const bytes = Buffer.from(token, 'base64url')
  const canonical = bytes.toString('base64url')
  const padded = canonical + '='.repeat((4 - canonical.length % 4) % 4)
  if (canonical !== unpadded || (token !== canonical && token !== padded)) throw new Error('Desktop auth callback is invalid.')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('Desktop auth callback is invalid.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Desktop auth callback is invalid.')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || typeof record.identifier !== 'string' || !/^[A-Za-z0-9]{32}$/.test(record.identifier) || typeof record.state !== 'string' || !/^[A-Za-z0-9]{16}$/.test(record.state)) {
    throw new Error('Desktop auth callback is invalid.')
  }
  return Object.freeze({ identifier: record.identifier, state: record.state })
}
