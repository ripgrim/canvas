import type { FontCatalogSnapshot, FontFamilyOption, FontStyleOption } from './font-types'
import type { PreviewFontFace } from '@canvas/preview-runtime/protocol'
import { fontFeatureKey, fontFeatureService } from './font-feature-service'
import { preloadGoogleFontPreviews, registerGoogleFontPreviews } from './google-font-preview'

type LocalFontData = Readonly<{
  blob?: () => Promise<Blob>
  family: string
  fullName?: string
  postscriptName?: string
  style?: string
}>
type LoadedFontResult = PreviewFontFace | Readonly<{ bytes: ArrayBuffer; preview: PreviewFontFace }>

type PermissionStateValue = 'denied' | 'granted' | 'prompt'
type PermissionQuery = Readonly<{ state: PermissionStateValue }>

export type FontCatalogEnvironment = Readonly<{
  documentFonts(): readonly FontFamilyOption[]
  googleFonts(): Promise<readonly FontFamilyOption[]>
  loadFavorites(): readonly string[]
  permission(): Promise<PermissionQuery>
  queryLocalFonts(): Promise<readonly LocalFontData[]>
  saveFavorites(favorites: readonly string[]): void
  supportsLocalFonts(): boolean
  visibility(): DocumentVisibilityState
  listenVisibility(listener: () => void): () => void
  loadGoogleFont(option: FontFamilyOption, style: FontStyleOption): Promise<readonly LoadedFontResult[]>
  clearLoadedFonts(): void
}>

const favoriteStorageKey = 'canvas.font-favorites'
const initialSnapshot: FontCatalogSnapshot = { favorites: [], loadError: null, localStatus: 'prompt', options: [] }

const cleanFamily = (family: string) => family.trim().replace(/^['"]|['"]$/g, '')
export const fontFamilyLabel = (family: string) => cleanFamily(family.split(',')[0] ?? family)
export const fontOptionAvailable = (option: FontFamilyOption): boolean => option.source === 'google' || option.source === 'local' || option.source === 'system'

export const systemFontOptions: readonly FontFamilyOption[] = [
  { family: 'system-ui, sans-serif', label: 'System Sans-Serif', source: 'system' },
  { family: 'ui-serif, Georgia, serif', label: 'System Serif', source: 'system' },
  { family: 'ui-monospace, "SFMono-Regular", Consolas, monospace', label: 'System Monospace', source: 'system' },
  ...['Arial', 'Arial Black', 'Comic Sans MS', 'Courier New', 'Georgia', 'Impact', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'].map(family => ({ family, label: family, source: 'system' as const })),
]

const styleFromName = (name = ''): FontStyleOption['style'] => {
  const normalized = name.toLocaleLowerCase()
  if (normalized.includes('italic')) return 'italic'
  if (normalized.includes('oblique')) return 'oblique'
  return 'normal'
}

const weightFromName = (name = ''): number => {
  const normalized = name.toLocaleLowerCase().replace(/[\s_-]+/g, '')
  if (normalized.includes('thin')) return 100
  if (normalized.includes('extralight') || normalized.includes('ultralight')) return 200
  if (normalized.includes('light')) return 300
  if (normalized.includes('medium')) return 500
  if (normalized.includes('semibold') || normalized.includes('demibold')) return 600
  if (normalized.includes('extrabold') || normalized.includes('ultrabold')) return 800
  if (normalized.includes('black') || normalized.includes('heavy')) return 900
  if (normalized.includes('bold')) return 700
  return 400
}

export function mergeFontOptions(...groups: readonly (readonly FontFamilyOption[])[]): FontFamilyOption[] {
  const merged = new Map<string, FontFamilyOption>()
  const priority = { document: 0, google: 1, system: 2, local: 3 } as const
  for (const group of groups) for (const option of group) {
    const key = fontFamilyLabel(option.family).toLocaleLowerCase()
    const current = merged.get(key)
    const styles = [...(current?.styles ?? []), ...(option.styles ?? [])]
      .filter((style, index, all) => all.findIndex(candidate => candidate.style === style.style && candidate.weight === style.weight && candidate.width === style.width) === index)
    const preferred = current && priority[current.source] >= priority[option.source] ? current : option
    merged.set(key, { ...current, ...option, ...preferred, ...(styles.length ? { styles } : {}) })
  }
  return [...merged.values()].sort((left, right) => left.label.localeCompare(right.label, 'en', { numeric: true, ignorePunctuation: true }))
}

export function fontSearchScore(label: string, query: string): number {
  const target = label.toLocaleLowerCase()
  const normalized = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  if (!normalized) return 0
  const direct = target.indexOf(normalized)
  if (direct >= 0) return direct
  let cursor = 0
  let distance = 0
  for (const character of normalized) {
    const next = target.indexOf(character, cursor)
    if (next < 0) return Number.POSITIVE_INFINITY
    distance += next - cursor
    cursor = next + 1
  }
  return target.length + distance
}

const dataUrl = (bytes: ArrayBuffer, mime: string): string => {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000))
  return `data:${mime};base64,${btoa(binary)}`
}

const googleFontRequest = (family: string, style: FontStyleOption, text?: string): string => {
  const params = new URLSearchParams({ family: style.style === 'normal' ? `${family}:wght@${style.weight}` : `${family}:ital,wght@1,${style.weight}`, display: 'swap', ...(text ? { text } : {}) })
  return `https://fonts.googleapis.com/css2?${params}`
}

const familyHash = (family: string): string => {
  let hash = 2166136261
  for (const character of family) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(36)
}

const googleFontAssetKey = (family: string, style: FontStyleOption, index: number): string => `google-${family.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56)}-${familyHash(family)}-${style.style}-${style.weight}-${index}`

export const googleFontRules = (css: string): readonly Readonly<{ url: string; unicodeRange?: string }>[] => [...css.matchAll(/@font-face\s*{([^}]*)}/gi)].flatMap(match => {
  const body = match[1] ?? ''
  const url = body.match(/src\s*:\s*url\((?:['"])?(https:\/\/[^)'"]+)(?:['"])?\)/i)?.[1]
  const unicodeRange = body.match(/unicode-range\s*:\s*([^;]+)/i)?.[1]?.trim()
  return url ? [{ url, ...(unicodeRange ? { unicodeRange } : {}) }] : []
})

const fontMime = (response: Response, url: string): string => {
  const header = response.headers.get('content-type')?.split(';')[0]?.trim()
  if (header?.startsWith('font/')) return header
  if (url.includes('.woff2')) return 'font/woff2'
  if (url.includes('.woff')) return 'font/woff'
  return 'font/ttf'
}

const browserEnvironment = (): FontCatalogEnvironment => {
  const installed = new Set<FontFace>()
  return ({
  documentFonts: () => {
    const options: FontFamilyOption[] = []
    document.fonts.forEach(face => {
      const family = cleanFamily(face.family)
      if (family) options.push({ family, label: family, source: 'local', styles: [{ style: styleFromName(face.style), weight: Number(face.weight) || 400 }] })
    })
    return options
  },
  googleFonts: async () => {
    const [catalog, previews] = await Promise.all([
      import('./google-fonts.generated.json').then(module => module.default as Readonly<{ source: string; families: readonly Readonly<{ family: string; styles: readonly FontStyleOption[]; axes?: FontFamilyOption['axes'] }>[] }>),
      import('./google-font-previews.generated.json').then(module => module.default),
    ])
    registerGoogleFontPreviews(previews)
    return catalog.families.map(entry => ({ family: entry.family, label: entry.family, source: 'google', styles: entry.styles, ...(entry.axes ? { axes: entry.axes } : {}) }))
  },
  loadFavorites: () => {
    try {
      const value: unknown = JSON.parse(window.localStorage.getItem(favoriteStorageKey) ?? '[]')
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    } catch { return [] }
  },
  permission: async () => navigator.permissions.query({ name: 'local-fonts' as PermissionName }),
  queryLocalFonts: async () => {
    const query = (window as Window & { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts
    if (!query) return []
    return query.call(window)
  },
  saveFavorites: favorites => {
    try { window.localStorage.setItem(favoriteStorageKey, JSON.stringify(favorites)) } catch { return }
  },
  supportsLocalFonts: () => typeof (window as Window & { queryLocalFonts?: unknown }).queryLocalFonts === 'function',
  visibility: () => document.visibilityState,
  listenVisibility: listener => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
  loadGoogleFont: async (option, style) => {
    const response = await fetch(googleFontRequest(option.family, style))
    if (!response.ok) throw new Error(`Font metadata returned ${response.status}.`)
    const rules = googleFontRules(await response.text())
    if (!rules.length) throw new Error('Font metadata contained no faces.')
    return Promise.all(rules.map(async (rule, index) => {
      const fontResponse = await fetch(rule.url)
      if (!fontResponse.ok) throw new Error(`Font asset returned ${fontResponse.status}.`)
      const bytes = await fontResponse.arrayBuffer()
      const face = new FontFace(option.family, bytes, { style: style.style, weight: String(style.weight), ...(rule.unicodeRange ? { unicodeRange: rule.unicodeRange } : {}) })
      await face.load()
      document.fonts.add(face)
      installed.add(face)
      return { bytes, preview: { key: googleFontAssetKey(option.family, style, index), family: option.family, style: style.style, weight: style.weight, ...(rule.unicodeRange ? { unicodeRange: rule.unicodeRange } : {}), data: dataUrl(bytes, fontMime(fontResponse, rule.url)) } }
    }))
  },
  clearLoadedFonts: () => {
    for (const face of installed) document.fonts.delete(face)
    installed.clear()
  },
  })
}

export function createFontCatalogService(environment: FontCatalogEnvironment = browserEnvironment()) {
  let snapshot = initialSnapshot
  let started = false
  let generation = 0
  let stopVisibility: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const fontListeners = new Set<() => void>()
  const loadedFonts = new Map<string, readonly PreviewFontFace[]>()
  const pendingFonts = new Map<string, Promise<void>>()
  let localFonts: readonly LocalFontData[] = []
  const publish = (patch: Partial<FontCatalogSnapshot>) => {
    const next = { ...snapshot, ...patch }
    if (snapshot.localStatus === next.localStatus && snapshot.options === next.options && snapshot.favorites === next.favorites && snapshot.loadError === next.loadError) return
    snapshot = next
    for (const listener of listeners) listener()
  }
  const completeLocal = (fonts: readonly LocalFontData[], request: number) => {
    if (!started || request !== generation) return
    localFonts = fonts
    const options = fonts.map(font => ({
      family: font.family,
      label: font.family,
      source: 'local' as const,
      styles: [{ style: styleFromName(font.style ?? font.fullName), weight: weightFromName(font.style ?? font.fullName) }],
    }))
    publish({ localStatus: 'loaded', options: mergeFontOptions(systemFontOptions, environment.documentFonts(), snapshot.options, options) })
  }
  const discover = async (prompt: boolean) => {
    if (!environment.supportsLocalFonts()) { publish({ localStatus: 'unsupported' }); return }
    const request = ++generation
    publish({ localStatus: 'loading' })
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => { if (request === generation && snapshot.localStatus === 'loading') publish({ localStatus: 'given-up' }) }, 5_000)
    try {
      const fonts = await environment.queryLocalFonts()
      completeLocal(fonts, request)
    } catch {
      if (!started || request !== generation) return
      publish({ localStatus: prompt ? 'denied' : 'prompt' })
    } finally {
      if (request === generation && timeout) { clearTimeout(timeout); timeout = undefined }
    }
  }
  const initialize = async () => {
    if (!environment.supportsLocalFonts()) { publish({ localStatus: 'unsupported' }); return }
    try {
      const permission = await environment.permission()
      if (!started) return
      if (permission.state === 'granted') await discover(false)
      else publish({ localStatus: permission.state })
    } catch { publish({ localStatus: 'prompt' }) }
  }
  const loadGoogle = async () => {
    try {
      const options = await environment.googleFonts()
      if (started) publish({ options: mergeFontOptions(snapshot.options, options) })
    } catch { return }
  }
  const retryVisible = () => { if (environment.visibility() === 'visible' && snapshot.localStatus === 'prompt') void initialize() }
  const load = (option: FontFamilyOption, style: FontStyleOption = { style: 'normal', weight: 400 }): Promise<void> => {
    if (option.source !== 'google') return Promise.resolve()
    const key = `${option.family}:${style.style}:${style.weight}`
    if (loadedFonts.has(key)) return Promise.resolve()
    const current = pendingFonts.get(key)
    if (current) return current
    const pending = environment.loadGoogleFont(option, style).then(results => {
      if (!started) return
      const fonts = results.map(result => 'preview' in result ? result.preview : result)
      for (const result of results) if ('preview' in result) fontFeatureService.register(fontFeatureKey(result.preview.family, result.preview.style, result.preview.weight), result.bytes)
      loadedFonts.set(key, fonts)
      publish({ loadError: null })
      for (const listener of fontListeners) listener()
    }).catch(error => {
      if (started) publish({ loadError: error instanceof Error ? error.message : 'Font loading failed.' })
    }).finally(() => pendingFonts.delete(key))
    pendingFonts.set(key, pending)
    return pending
  }
  return {
    start(): void {
      if (started) return
      started = true
      snapshot = {
        favorites: environment.loadFavorites(),
        loadError: null,
        localStatus: environment.supportsLocalFonts() ? 'prompt' : 'unsupported',
        options: mergeFontOptions(systemFontOptions, environment.documentFonts()),
      }
      stopVisibility = environment.listenVisibility(retryVisible)
      preloadGoogleFontPreviews()
      for (const listener of listeners) listener()
      void loadGoogle()
      void initialize()
    },
    dispose(): void {
      started = false
      generation += 1
      if (timeout) clearTimeout(timeout)
      timeout = undefined
      stopVisibility?.()
      stopVisibility = undefined
      environment.clearLoadedFonts()
      fontFeatureService.dispose()
      localFonts = []
      loadedFonts.clear()
      pendingFonts.clear()
      snapshot = initialSnapshot
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot(): FontCatalogSnapshot { return snapshot },
    getServerSnapshot(): FontCatalogSnapshot { return initialSnapshot },
    subscribeLoadedFonts(listener: () => void): () => void { fontListeners.add(listener); return () => fontListeners.delete(listener) },
    getLoadedFonts(): readonly PreviewFontFace[] { return [...loadedFonts.values()].flat() },
    load,
    requestFeatures(family: string, style: FontStyleOption): void {
      const key = fontFeatureKey(family, style.style, style.weight)
      const local = localFonts.find(font => fontFamilyLabel(font.family).toLocaleLowerCase() === fontFamilyLabel(family).toLocaleLowerCase() && styleFromName(font.style ?? font.fullName) === style.style && weightFromName(font.style ?? font.fullName) === style.weight)
      if (local?.blob) {
        void local.blob().then(blob => blob.arrayBuffer()).then(bytes => { fontFeatureService.register(key, bytes); fontFeatureService.inspect(key) }).catch(() => fontFeatureService.unavailable(key))
        return
      }
      const option = snapshot.options.find(candidate => fontFamilyLabel(candidate.family).toLocaleLowerCase() === fontFamilyLabel(family).toLocaleLowerCase() && candidate.source === 'google')
      if (!option) { fontFeatureService.unavailable(key); return }
      void load(option, style).then(() => fontFeatureService.inspect(key))
    },
    requestLocalFonts(): void { if (started && snapshot.localStatus !== 'loading' && snapshot.localStatus !== 'loaded') void discover(true) },
    toggleFavorite(family: string): void {
      const normalized = family === 'Paper Mono Preview' ? 'Paper Mono' : family
      const favorites = snapshot.favorites.includes(normalized)
        ? snapshot.favorites.filter(item => item !== normalized)
        : [...snapshot.favorites, normalized]
      environment.saveFavorites(favorites)
      publish({ favorites })
    },
  }
}

export const fontCatalogService = createFontCatalogService()
