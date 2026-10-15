import { useId, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, FocusEvent, KeyboardEvent } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { fontCatalogService, fontFamilyLabel, fontOptionAvailable, fontSearchScore, mergeFontOptions } from '../features/fonts/font-catalog-service'
import { googleFontPreviewStyle } from '../features/fonts/google-font-preview'
import type { FontFamilyOption, FontStyleOption } from '../features/fonts/font-types'
import { Icon } from './atoms'
import './font-family-picker.css'

export type { FontFamilyOption, FontStyleOption } from '../features/fonts/font-types'
export { fontFamilyLabel, fontSearchScore, mergeFontOptions, systemFontOptions } from '../features/fonts/font-catalog-service'

export type FontFamilyTokenOption = Readonly<{ id: string; name: string; family: string }>

type FontPickerCopy = Readonly<{
  title: string
  close: string
  fonts: string
  favorites: string
  tokens: string
  searchFonts: string
  searchFavorites: string
  searchTokens: string
  noMatches: string
  noMatchesLoaded: string
  noFavorites: string
  noTokens: string
  loadLocalFonts: string
  loadingLocalFonts: string
  localFontsDenied: string
  localFontsLate: string
  localFontsUnsupported: string
  unavailable: string
  loadFailed: string
  favorite: (family: string) => string
  unfavorite: (family: string) => string
}>

type PickerTab = 'favorites' | 'fonts' | 'tokens'
type PickerEntry = Readonly<{ family: FontFamilyOption; token?: FontFamilyTokenOption }>

const rowHeight = 36
const listHeight = 352
const overscan = 30

function FavoriteGlyph({ selected }: { selected: boolean }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 1.7 1.9 3.8 4.2.6-3 3 .7 4.2L8 11.3l-3.8 2 .7-4.2-3-3 4.2-.6Z" fill={selected ? 'currentColor' : 'none'} stroke="currentColor" strokeLinejoin="round" /></svg>
}

const anchoredPosition = (trigger: HTMLElement | null): CSSProperties => {
  const rect = trigger?.getBoundingClientRect()
  if (!rect) return {}
  const width = Math.min(300, window.innerWidth - 16)
  const height = Math.min(444, window.innerHeight - 16)
  return { left: Math.max(8, rect.left - width - 12), top: Math.max(8, Math.min(rect.top - 24, window.innerHeight - height - 8)), width, height }
}

export const fontPickerPortalContainer = (trigger: HTMLElement | null): HTMLElement | null => trigger?.closest<HTMLElement>('.mobile-sheet-popup') ?? trigger?.closest<HTMLElement>('.editor-root') ?? null

export const fontPickerEntries = (tab: PickerTab, options: readonly FontFamilyOption[], tokens: readonly FontFamilyTokenOption[], favorites: readonly string[], query: string): PickerEntry[] => {
  const byFamily = new Map(options.map(option => [option.family.toLocaleLowerCase(), option]))
  const entries = tab === 'tokens'
    ? tokens.map(token => ({ token, family: { ...(byFamily.get(token.family.toLocaleLowerCase()) ?? { source: 'document' as const }), family: token.family, label: token.name } }))
    : (tab === 'favorites' ? favorites.map(family => byFamily.get(family.toLocaleLowerCase()) ?? { family, label: family, source: 'document' as const }) : options).map(family => ({ family }))
  return entries
    .map(entry => ({ entry, score: fontSearchScore(entry.family.label, query) }))
    .filter(item => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score || left.entry.family.label.localeCompare(right.entry.family.label, 'en', { numeric: true, ignorePunctuation: true }))
    .map(item => item.entry)
}

export function FontFamilyPicker({ id, value, placeholder, options, tokens = [], disabled = false, copy, onChoose }: {
  id: string
  value: string | null
  placeholder: string
  options: readonly FontFamilyOption[]
  tokens?: readonly FontFamilyTokenOption[]
  disabled?: boolean
  copy: FontPickerCopy
  onChoose: (option: FontFamilyOption, token?: FontFamilyTokenOption) => FontStyleOption | void
}) {
  const catalog = useSyncExternalStore(fontCatalogService.subscribe, fontCatalogService.getSnapshot, fontCatalogService.getServerSnapshot)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<PickerTab>('fonts')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [position, setPosition] = useState<CSSProperties>({})
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const allOptions = mergeFontOptions(options, catalog.options)
  const entries = fontPickerEntries(tab, allOptions, tokens, catalog.favorites, query)
  const current = active < entries.length ? active : Math.max(0, entries.length - 1)
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(entries.length, Math.ceil((scrollTop + listHeight) / rowHeight) + overscan)
  const rendered = entries.slice(start, end)
  const choose = (entry: PickerEntry) => {
    if (!fontOptionAvailable(entry.family)) return
    const style = onChoose(entry.family, entry.token)
    void fontCatalogService.load(entry.family, style ?? { style: 'normal', weight: 400 })
    setOpen(false)
    setQuery('')
  }
  const showIndex = (index: number) => {
    const next = Math.max(0, Math.min(entries.length - 1, index))
    setActive(next)
    const viewport = list.current
    if (!viewport) return
    const top = next * rowHeight
    const bottom = top + rowHeight
    if (top < viewport.scrollTop) viewport.scrollTop = top
    else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight
  }
  const changeTab = (next: PickerTab) => {
    setTab(next)
    setQuery('')
    setActive(0)
    setScrollTop(0)
    if (list.current) list.current.scrollTop = 0
  }
  const openPicker = () => {
    setContainer(fontPickerPortalContainer(trigger.current))
    setPosition(anchoredPosition(trigger.current))
    changeTab('fonts')
    if (catalog.localStatus === 'prompt' || catalog.localStatus === 'given-up') fontCatalogService.requestLocalFonts()
  }
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      showIndex(current + (event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Home') {
      event.preventDefault()
      showIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      showIndex(entries.length - 1)
    } else if (event.key === 'Enter' && entries[current]) {
      event.preventDefault()
      choose(entries[current]!)
    } else if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
      showIndex(0)
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.target !== search.current) {
      event.preventDefault()
      setQuery(previous => `${previous}${event.key}`)
      setActive(0)
      search.current?.focus()
    }
  }
  const empty = tab === 'favorites' && !query ? copy.noFavorites : tab === 'tokens' && !query ? copy.noTokens : catalog.localStatus === 'loaded' ? copy.noMatchesLoaded : copy.noMatches
  const searchCopy = tab === 'favorites' ? copy.searchFavorites : tab === 'tokens' ? copy.searchTokens : copy.searchFonts
  return <Dialog.Root open={open} onOpenChange={next => { setOpen(next); if (next) openPicker() }}>
    <Dialog.Trigger ref={trigger} id={id} className="inspector-font-trigger" aria-label={copy.title} disabled={disabled}>
      <Icon name="font-family" /><span className="inspector-font-trigger-label" style={value ? { fontFamily: value } : undefined}>{value ? fontFamilyLabel(value) : placeholder}</span><Icon name="chevron" />
    </Dialog.Trigger>
    <Dialog.Portal container={container}><Dialog.Backdrop className="font-picker-backdrop" /><Dialog.Popup className="font-picker-dialog" style={position} aria-describedby={undefined} onKeyDownCapture={keys} onBlur={(event: FocusEvent<HTMLDivElement>) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
      <header className="font-picker-header">
        <nav className="font-picker-tabs" role="tablist" aria-label={copy.title}>
          <button type="button" role="tab" aria-selected={tab === 'fonts'} data-active={tab === 'fonts' || undefined} onFocus={() => changeTab('fonts')} onClick={() => changeTab('fonts')}>{copy.fonts}</button>
          {catalog.favorites.length > 0 && <button type="button" role="tab" aria-selected={tab === 'favorites'} data-active={tab === 'favorites' || undefined} onFocus={() => changeTab('favorites')} onClick={() => changeTab('favorites')}>{copy.favorites}</button>}
          {tokens.length > 0 && <button type="button" role="tab" aria-selected={tab === 'tokens'} data-active={tab === 'tokens' || undefined} onFocus={() => changeTab('tokens')} onClick={() => changeTab('tokens')}>{copy.tokens}</button>}
        </nav>
        <Dialog.Title className="font-picker-title">{copy.title}</Dialog.Title>
        <Dialog.Close className="font-picker-close" aria-label={copy.close}><Icon name="close" /></Dialog.Close>
      </header>
      <label className="font-picker-search"><Icon name="search" /><input ref={search} data-search autoFocus value={query} aria-label={searchCopy} aria-controls={listId} aria-activedescendant={entries[current] ? `${listId}-${current}` : undefined} placeholder={searchCopy} onChange={event => { setQuery(event.currentTarget.value); setActive(0) }} /></label>
      <div ref={list} id={listId} className="font-picker-list" role="listbox" aria-label={tab === 'favorites' ? copy.favorites : tab === 'tokens' ? copy.tokens : copy.fonts} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
        {entries.length > 0 && <div className="font-picker-list-space" style={{ height: entries.length * rowHeight }}>
          <div className="font-picker-list-window" style={{ transform: `translateY(${start * rowHeight}px)` }}>
            {rendered.map((entry, offset) => {
              const index = start + offset
              const favorite = catalog.favorites.includes(entry.family.family)
              const unavailable = !fontOptionAvailable(entry.family)
              const preview = entry.family.source === 'google' ? googleFontPreviewStyle(entry.family.family) : undefined
              return <div key={entry.token?.id ?? entry.family.family} id={`${listId}-${index}`} className="font-picker-row" role="option" aria-selected={index === current} data-active={index === current || undefined} onPointerMove={() => setActive(index)}>
                <button type="button" className="font-picker-family" aria-label={entry.family.label} disabled={unavailable} style={!preview ? { fontFamily: entry.family.family } : undefined} onClick={() => choose(entry)}>
                  {preview ? <span className="font-picker-family-preview" aria-hidden="true" style={preview} /> : <span className="font-picker-family-name">{entry.family.label}</span>}
                  {entry.token ? <span className="font-picker-token-value">{fontFamilyLabel(entry.family.family)}</span> : unavailable ? <span className="font-picker-unavailable">{copy.unavailable}</span> : null}
                </button>
                {!entry.token && <button type="button" tabIndex={-1} className="font-picker-favorite" aria-label={favorite ? copy.unfavorite(entry.family.label) : copy.favorite(entry.family.label)} aria-pressed={favorite} onPointerDown={event => { event.preventDefault(); event.stopPropagation() }} onClick={() => fontCatalogService.toggleFavorite(entry.family.family)}><FavoriteGlyph selected={favorite} /></button>}
              </div>
            })}
          </div>
        </div>}
        {!entries.length && <div className="font-picker-empty">{empty}</div>}
      </div>
      <footer className="font-picker-footer">
        {catalog.loadError && <span>{copy.loadFailed}</span>}
        {catalog.localStatus === 'loading' && <span>{copy.loadingLocalFonts}</span>}
        {catalog.localStatus === 'given-up' && <><span>{copy.localFontsLate}</span><button type="button" onClick={fontCatalogService.requestLocalFonts}>{copy.loadLocalFonts}</button></>}
        {catalog.localStatus === 'denied' && <span>{copy.localFontsDenied}</span>}
        {catalog.localStatus === 'prompt' && <button type="button" onClick={fontCatalogService.requestLocalFonts}>{copy.loadLocalFonts}</button>}
        {catalog.localStatus === 'unsupported' && <span>{copy.localFontsUnsupported}</span>}
      </footer>
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>
}
