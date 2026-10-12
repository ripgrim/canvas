import { describe, expect, it } from 'vitest'
import { desktopUpdateChannel } from '../src/main/package-environment'

describe('desktop update channel isolation', () => {
  it('keeps unsigned review installers and local packages outside update feeds', () => {
    expect(desktopUpdateChannel('staging', false)).toBeNull()
    expect(desktopUpdateChannel('production', false)).toBeNull()
    expect(desktopUpdateChannel('local', true)).toBeNull()
  })

  it('selects a channel only for explicitly updatable release packages', () => {
    expect(desktopUpdateChannel('staging', true)).toBe('nightly')
    expect(desktopUpdateChannel('production', true)).toBe('stable')
  })
})
