import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFontCatalogService, googleFontRules, mergeFontOptions } from './font-catalog-service'
import type { FontCatalogEnvironment } from './font-catalog-service'
import googleFonts from './google-fonts.generated.json'

const environment = (overrides: Partial<FontCatalogEnvironment> = {}): FontCatalogEnvironment => ({
  documentFonts: () => [],
  googleFonts: async () => [],
  loadFavorites: () => [],
  permission: async () => ({ state: 'prompt' }),
  queryLocalFonts: async () => [],
  saveFavorites: () => undefined,
  supportsLocalFonts: () => true,
  visibility: () => 'visible',
  listenVisibility: () => () => undefined,
  loadGoogleFont: async () => [],
  clearLoadedFonts: () => undefined,
  ...overrides,
})

afterEach(() => vi.useRealTimers())

describe('FONT-LOCAL-001 session discovery', () => {
  it('does not prompt during background startup', async () => {
    const query = vi.fn(async () => [])
    const service = createFontCatalogService(environment({ queryLocalFonts: query }))
    service.start()
    await Promise.resolve()
    expect(query).not.toHaveBeenCalled()
    expect(service.getSnapshot().localStatus).toBe('prompt')
    service.dispose()
  })

  it('enumerates without a prompt after a granted permission', async () => {
    const service = createFontCatalogService(environment({
      permission: async () => ({ state: 'granted' }),
      queryLocalFonts: async () => [{ family: 'Local Sans', style: 'Semi Bold Italic' }],
    }))
    service.start()
    await vi.waitFor(() => expect(service.getSnapshot().localStatus).toBe('loaded'))
    expect(service.getSnapshot().options.find(option => option.family === 'Local Sans')?.styles).toEqual([{ style: 'italic', weight: 600 }])
    service.dispose()
  })

  it('keeps a late result after the five second UI deadline', async () => {
    vi.useFakeTimers()
    let complete: ((fonts: readonly { family: string }[]) => void) | undefined
    const service = createFontCatalogService(environment({
      queryLocalFonts: () => new Promise(resolve => { complete = resolve }),
    }))
    service.start()
    await Promise.resolve()
    service.requestLocalFonts()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(service.getSnapshot().localStatus).toBe('given-up')
    complete?.([{ family: 'Late Sans' }])
    await Promise.resolve()
    expect(service.getSnapshot().localStatus).toBe('loaded')
    expect(service.getSnapshot().options.some(option => option.family === 'Late Sans')).toBe(true)
    service.dispose()
  })
})

describe('FONT-CACHE-001 session favorites', () => {
  it('persists normalized favorites and publishes one snapshot', () => {
    const save = vi.fn()
    const service = createFontCatalogService(environment({ saveFavorites: save }))
    service.start()
    service.toggleFavorite('Paper Mono Preview')
    expect(service.getSnapshot().favorites).toEqual(['Paper Mono'])
    expect(save).toHaveBeenCalledWith(['Paper Mono'])
    service.dispose()
  })
})

describe('FONT-CATALOG-001 background catalog', () => {
  it('parses every face returned by Google Fonts CSS', () => {
    expect(googleFontRules(`
      @font-face { font-family: 'Roboto'; src: url(https://fonts.example/latin.woff2) format('woff2'); unicode-range: U+0000-00FF; }
      @font-face { font-family: 'Roboto'; src: url("https://fonts.example/cyrillic.woff2") format('woff2'); }
    `)).toEqual([
      { url: 'https://fonts.example/latin.woff2', unicodeRange: 'U+0000-00FF' },
      { url: 'https://fonts.example/cyrillic.woff2' },
    ])
  })

  it('ships official Google family, style, and axis data', () => {
    expect(googleFonts.source).toBe('https://fonts.google.com/metadata/fonts')
    expect(googleFonts.families.length).toBeGreaterThan(1900)
    const roboto = googleFonts.families.find(font => font.family === 'Roboto')
    expect(roboto?.styles).toContainEqual({ style: 'italic', weight: 700 })
    expect(roboto?.axes).toMatchObject({ wdth: { min: 75, max: 100 }, wght: { min: 100, max: 900 } })
  })

  it('publishes system fonts before the catalog resolves', async () => {
    let complete: ((fonts: readonly { family: string; label: string; source: 'google' }[]) => void) | undefined
    const service = createFontCatalogService(environment({ googleFonts: () => new Promise(resolve => { complete = resolve }) }))
    service.start()
    expect(service.getSnapshot().options.some(option => option.family === 'Arial')).toBe(true)
    expect(service.getSnapshot().options.some(option => option.family === 'Async Sans')).toBe(false)
    complete?.([{ family: 'Async Sans', label: 'Async Sans', source: 'google' }])
    await Promise.resolve()
    expect(service.getSnapshot().options.some(option => option.family === 'Async Sans')).toBe(true)
    service.dispose()
  })

  it('does not replace an available local family with catalog metadata', () => {
    const options = mergeFontOptions(
      [{ family: 'Roboto', label: 'Roboto', source: 'local' }],
      [{ family: 'Roboto', label: 'Roboto', source: 'google', styles: [{ style: 'normal', weight: 700 }] }],
    )
    expect(options).toEqual([{ family: 'Roboto', label: 'Roboto', source: 'local', styles: [{ style: 'normal', weight: 700 }] }])
  })

  it('loads one Google face once and keeps it for the session', async () => {
    const load = vi.fn(async () => [{ key: 'google-abel-normal-400-0', family: 'Abel', style: 'normal' as const, weight: 400, data: 'data:font/ttf;base64,QQ==' }])
    const service = createFontCatalogService(environment({ loadGoogleFont: load }))
    const option = { family: 'Abel', label: 'Abel', source: 'google' as const }
    service.start()
    await service.load(option, { style: 'normal', weight: 400 })
    await service.load(option, { style: 'normal', weight: 400 })
    expect(load).toHaveBeenCalledTimes(1)
    expect(service.getLoadedFonts()).toEqual([{ key: 'google-abel-normal-400-0', family: 'Abel', style: 'normal', weight: 400, data: 'data:font/ttf;base64,QQ==' }])
    service.dispose()
  })
})
