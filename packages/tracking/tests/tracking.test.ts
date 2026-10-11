import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { track } from '@databuddy/sdk'
import { appPlatform, appVersion, eventProperties, trackCanvasEvent } from '../src/index'

vi.mock('@databuddy/sdk', () => ({ track: vi.fn() }))

describe('tracking context', () => {
  it('labels web and Electron explicitly without using the user agent', () => {
    expect(appPlatform({} as typeof globalThis)).toBe('web')
    expect(appPlatform({ designEditor: {} } as unknown as typeof globalThis)).toBe('electron')
  })

  it('owns platform and version even when a caller supplies conflicting values', () => {
    expect(eventProperties({ app_platform: 'spoofed', app_version: 'spoofed', source: 'home' }, 'electron')).toEqual({
      app_platform: 'electron',
      app_version: appVersion,
      source: 'home',
    })
  })

  it('sends every custom event through the owned context', () => {
    expect(() => trackCanvasEvent('file_created', { source: 'home' })).not.toThrow()
    expect(vi.mocked(track)).toHaveBeenCalledWith('file_created', {
      app_platform: 'web',
      app_version: appVersion,
      source: 'home',
    })
  })

  it('uses the release version from the workspace manifest', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as { version: string }
    expect(appVersion).toBe(manifest.version)
  })
})
