import { useRef, useState, useSyncExternalStore } from 'react'
import { resolveToken, resolveTokenLiteral, tokenReferences, tokenTypes, wouldCreateAliasCycle } from '@canvas/repo-engine/file-document'
import type { ColorToken, FileCommand, FileDocument, FileToken, ResolvedTokenLiteral, SourcePalette, TokenType, TokenValue } from '@canvas/repo-engine/file-document'
import { colorToCss, colorToHex, hexColor } from '@canvas/repo-engine/color'
import type { Color } from '@canvas/repo-engine/color'
import { compareOrder } from '@canvas/repo-engine/order-keys'
import { orderKeyBetween } from '@canvas/repo-engine/order-keys'
import { ThemeButton, ThemeChip, ThemeColorValue, ThemeConfirm, ThemeCount, ThemeEditorActions, ThemeEditorField, ThemeEditorPopover, ThemeEmpty, ThemeGroup, ThemeIconButton, ThemeNote, ThemePanelLayout, ThemeReadonly, ThemeSearchField, ThemeSwatch, ThemeTokenGlyph, ThemeTokenList, ThemeTokenRow, ThemeTokenTypeMenu, ThemeToolbar } from '../../design-system/theme-atoms'
import { InspectorColorField, InspectorSelectField, InspectorTextField, splitHex } from '../../design-system/inspector-atoms'
import { ColorPicker } from '../../design-system/color-picker'
import { ContextMenu } from '../../design-system/context-menu'
import type { ContextMenuAction } from '../../design-system/context-menu'
import { floatingPortalContainer } from '../../design-system/floating-portal'
import { documentStore } from './document-store'
import { editorStore } from './store'
import { themeCopy as copy } from './theme-copy'
import { pendingFocus, themeFocus } from './theme-focus'
import { decodeThemeTokens, encodeThemeTokens, moveThemeTokens } from './theme-token-menu'
import type { TokenMove } from './theme-token-menu'

type Search = { open: boolean; query: string; refocus: boolean }
type Editing = { id: string; open: boolean; pending: boolean; confirm: boolean; deleteIds: readonly string[] | null; container: HTMLElement | null }
type MenuPosition = { x: number; y: number }
type Shown = { hex: string; opacity: number }
type Entry = { token: FileToken; literal: ResolvedTokenLiteral | null; color: Shown | null }

const shown = (color: Color | null): Shown | null => { const parts = color ? splitHex(colorToHex(color)) : null; return parts ? { hex: parts.rgb.toUpperCase(), opacity: parts.opacity } : null }
const describeColor = (value: Shown | null) => value ? copy.swatch(value.hex, value.opacity) : copy.unresolved
const sortedTokens = (file: FileDocument) => Object.values(file.theme.tokens).sort(compareOrder)
const typeLabel = (type: TokenType) => copy.types[type]
const tokenTypeOptions = tokenTypes.map((type, index) => ({ value: type, label: typeLabel(type), ...([3, 6].includes(index) ? { sectionStart: true } : {}) }))
const glyphs: Record<TokenType, string> = { color: '■', opacity: '%', radius: '⌜', spacing: '↔', container: '▣', breakpoint: '▭', fontFamily: 'F', fontWeight: 'A', fontSize: '↕', lineHeight: '≡', letterSpacing: '↔' }
const clipboard = () => typeof navigator === 'undefined' ? null : navigator.clipboard

const defaultTokenValue = (type: TokenType): TokenValue => type === 'color'
  ? { kind: 'literal', color: hexColor('#D9D9D9') }
  : { kind: 'literal', value: ({ opacity: 0.5, radius: '8px', spacing: '8px', container: '1200px', breakpoint: '768px', fontFamily: 'Inter', fontWeight: 400, fontSize: '16px', lineHeight: 1.5, letterSpacing: '0px' } satisfies Record<Exclude<TokenType, 'color'>, string | number>)[type] }

const uniqueTokenName = (used: Set<string>, requested: string) => {
  const base = requested.trim().slice(0, 64) || 'Untitled'
  let name = base
  for (let suffix = 2; used.has(name); suffix += 1) name = `${base.slice(0, Math.max(1, 63 - String(suffix).length))} ${suffix}`
  used.add(name)
  return name
}

function scalarText(type: Exclude<TokenType, 'color'>, value: string | number): string {
  if (type === 'opacity' && typeof value === 'number') return `${Math.round(value * 100)}%`
  return String(value)
}

function valueText(file: FileDocument, entry: Entry): string {
  const { token, literal, color } = entry
  if (token.value.kind === 'alias') return copy.aliasValue(file.theme.tokens[token.value.tokenId]?.name ?? copy.missing)
  if (token.type === 'color') return token.value.kind === 'source' ? copy.sourceValue(token.value.property, describeColor(color)) : describeColor(color)
  return literal && 'value' in literal ? scalarText(token.type, literal.value) : copy.unresolved
}

function matches(file: FileDocument, entry: Entry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const fields = [entry.token.name, typeLabel(entry.token.type), valueText(file, entry)]
  if (entry.token.value.kind === 'alias') fields.push(file.theme.tokens[entry.token.value.tokenId]?.name ?? '')
  if (entry.token.value.kind === 'source') fields.push(entry.token.value.property)
  return fields.some(field => field.toLowerCase().includes(needle))
}

function TokenValue({ file, entry }: { file: FileDocument; entry: Entry }) {
  const { token, color, literal } = entry
  if (token.value.kind === 'alias') { const target = file.theme.tokens[token.value.tokenId]?.name ?? copy.missing; return <ThemeChip title={copy.aliasValue(target)}>{target}</ThemeChip> }
  if (token.type === 'color') return <>{token.value.kind === 'source' && <ThemeChip title={token.value.property}>{copy.source}</ThemeChip>}{color && <ThemeColorValue hex={color.hex} opacity={color.opacity} />}</>
  return <>{literal && 'value' in literal ? scalarText(token.type, literal.value) : copy.unresolved}</>
}

function scalarInput(type: Exclude<TokenType, 'color'>, value: string | number): string {
  return type === 'opacity' && typeof value === 'number' ? `${Math.round(value * 100)}%` : String(value)
}

function parseScalar(type: Exclude<TokenType, 'color'>, input: string): string | number | null {
  const value = input.trim()
  if (!value) return null
  if (type === 'fontFamily') return value
  if (type === 'opacity') {
    const number = Number(value.endsWith('%') ? value.slice(0, -1) : value)
    const normalized = value.endsWith('%') ? number / 100 : number
    return Number.isFinite(normalized) && normalized >= 0 && normalized <= 1 ? normalized : null
  }
  if (type === 'fontWeight') { const number = Number(value); return Number.isInteger(number) && number >= 1 && number <= 1000 ? number : null }
  if (type === 'lineHeight' || type === 'letterSpacing') {
    if (/^-?(?:\d+\.?\d*|\.\d+)px$/.test(value)) return value
    const number = Number(value)
    if (!Number.isFinite(number)) return null
    if (type === 'lineHeight' && (number <= 0 || number > 10) || type === 'letterSpacing' && Math.abs(number) > 1000) return null
    return number
  }
  const withUnit = /px$/.test(value) ? value : `${value}px`
  return /^(?:\d+\.?\d*|\.\d+)px$/.test(withUnit) ? withUnit : null
}

function ColorTokenEditor({ file, token, sources, mode, readOnly }: { file: FileDocument; token: ColorToken; sources: SourcePalette; mode: 'light' | 'dark'; readOnly: boolean }) {
  const theme = documentStore.commands.theme
  const resolved = resolveToken(file.theme, token.id, sources)
  const color = shown(resolved)
  const hex = resolved ? colorToHex(resolved) : '#000000'
  const literal = (next: string) => { theme.setTokenValue(token.id, { kind: 'literal', color: hexColor(next) }) }
  const value = token.value
  return <>
    {value.kind === 'literal' ? <ColorPicker variant="preview" label={copy.colorLabel(token.name)} value={hex} mode={mode} disabled={readOnly} onChange={literal} /> : <ThemeSwatch size="preview" color={resolved ? colorToCss(resolved) : null} label={`${copy.preview(token.name)}: ${describeColor(color)}`} />}
    {value.kind === 'literal' && <InspectorColorField id={`theme-token-${token.id}-color`} label={copy.colorLabel(token.name)} opacityLabel={copy.opacityLabel(token.name)} value={hex} disabled={readOnly} swatch={<ColorPicker variant="swatch" label={copy.colorLabel(token.name)} value={hex} mode={mode} disabled={readOnly} onChange={literal} />} onCommit={literal} />}
    {value.kind === 'source' && <ThemeReadonly title={value.property}>{value.property}</ThemeReadonly>}
    {value.kind !== 'literal' && <InspectorColorField id={`theme-token-${token.id}-resolved`} label={copy.colorLabel(token.name)} opacityLabel={copy.opacityLabel(token.name)} value={hex} />}
    {value.kind === 'source' && !readOnly && <ThemeButton onClick={() => { theme.setTokenValue(token.id, { kind: 'literal', color: resolved ?? value.fallback }) }}>{copy.detach}</ThemeButton>}
  </>
}

function TokenEditor({ file, token, sources, mode, readOnly, confirm, deleteCount, referenceCount, onConfirm, onDuplicate, onDelete, onClose }: { file: FileDocument; token: FileToken; sources: SourcePalette; mode: 'light' | 'dark'; readOnly: boolean; confirm: boolean; deleteCount: number; referenceCount: number; onConfirm: (confirm: boolean) => void; onDuplicate: () => void; onDelete: () => void; onClose: () => void }) {
  const theme = documentStore.commands.theme
  const resolved = resolveTokenLiteral(file.theme, token.id, sources)
  const targets = sortedTokens(file).filter(candidate => candidate.type === token.type && candidate.id !== token.id && !wouldCreateAliasCycle(file.theme, token.id, candidate.id))
  const kindOptions = [{ value: 'literal', label: copy.literal }, ...(targets.length || token.value.kind === 'alias' ? [{ value: 'alias', label: copy.alias }] : []), ...(token.value.kind === 'source' ? [{ value: 'source', label: copy.source }] : [])]
  const setKind = (kind: string) => {
    if (kind === token.value.kind) return
    if (kind === 'alias' && targets[0]) { theme.setTokenValue(token.id, { kind: 'alias', tokenId: targets[0].id }); return }
    if (kind === 'literal' && resolved) theme.setTokenValue(token.id, resolved)
  }
  const requestDelete = () => { if (referenceCount > 0) onConfirm(true); else onDelete() }
  const aliasValue = token.value.kind === 'alias' ? token.value : null
  return <>
    <ThemeEditorField label={copy.name}><InspectorTextField key={token.id} id={`theme-token-${token.id}-name`} label={copy.nameLabel} value={token.name} maxLength={64} disabled={readOnly} onCommit={name => { theme.renameToken(token.id, name) }} /></ThemeEditorField>
    <ThemeEditorField label={copy.value}>
      <InspectorSelectField id={`theme-token-${token.id}-kind`} label={copy.valueType} value={token.value.kind} options={kindOptions} disabled={readOnly} onChange={setKind} />
      {aliasValue && <InspectorSelectField id={`theme-token-${token.id}-target`} label={copy.targetLabel} value={aliasValue.tokenId} disabled={readOnly} options={[...(file.theme.tokens[aliasValue.tokenId] ? [] : [{ value: aliasValue.tokenId, label: copy.missing }]), ...targets.map(target => ({ value: target.id, label: target.name }))]} onChange={tokenId => { if (tokenId !== aliasValue.tokenId) theme.setTokenValue(token.id, { kind: 'alias', tokenId }) }} />}
      {token.type === 'color' ? <ColorTokenEditor file={file} token={token} sources={sources} mode={mode} readOnly={readOnly} /> : token.value.kind === 'literal' ? <InspectorTextField key={`${token.id}:${String(token.value.value)}`} id={`theme-token-${token.id}-value`} label={copy.valueLabel(token.name)} value={scalarInput(token.type, token.value.value)} disabled={readOnly} onCommit={input => { const value = parseScalar(token.type, input); if (value !== null) theme.setTokenValue(token.id, { kind: 'literal', value }) }} /> : resolved && 'value' in resolved ? <ThemeReadonly>{scalarText(token.type, resolved.value)}</ThemeReadonly> : null}
    </ThemeEditorField>
    {confirm && !readOnly ? <ThemeConfirm label={copy.confirmLabel}>
      <ThemeButton variant="danger" onClick={onDelete}>{referenceCount > 0 ? copy.confirmDelete(referenceCount, deleteCount) : copy.confirmPlain}</ThemeButton>
      <ThemeButton onClick={() => onConfirm(false)}>{copy.cancel}</ThemeButton>
    </ThemeConfirm> : <ThemeEditorActions>
      {!readOnly && <ThemeButton variant="danger" onClick={requestDelete}>{copy.delete}</ThemeButton>}
      {!readOnly && <ThemeButton onClick={onDuplicate}>{copy.duplicate}</ThemeButton>}
      <ThemeButton onClick={onClose}>{copy.close}</ThemeButton>
    </ThemeEditorActions>}
  </>
}

/** File-scoped tokens grouped by the value domains supported by the runtime. */
export function ThemePanel() {
  const state = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const mode = useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().mode, () => editorStore.getSnapshot().mode)
  useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().snapshot, () => editorStore.getSnapshot().snapshot)
  useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().previewThemeId, () => editorStore.getSnapshot().previewThemeId)
  const focus = useSyncExternalStore(themeFocus.subscribe, themeFocus.getSnapshot, themeFocus.getSnapshot)
  const [search, setSearch] = useState<Search>({ open: false, query: '', refocus: false })
  const [expanded, setExpanded] = useState<TokenType[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<Editing | null>(null)
  const [menu, setMenu] = useState<MenuPosition | null>(null)
  const [clipboardContainsTokens, setClipboardContainsTokens] = useState<boolean | null>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())
  const returnFocus = useRef<string | null>(null)
  const addButton = useRef<HTMLButtonElement | null>(null)
  const revealed = useRef(0)
  const file = state.file
  if (!file) return <ThemePanelLayout><ThemeNote>{copy.unavailable}</ThemeNote></ThemePanelLayout>
  const readOnly = state.blocked
  const sources = documentStore.sources()
  const tokens = sortedTokens(file)
  if (readOnly && !tokens.length) return <ThemePanelLayout><ThemeNote>{copy.unavailable}</ThemeNote></ThemePanelLayout>
  const entries: Entry[] = tokens.map(token => ({ token, literal: resolveTokenLiteral(file.theme, token.id, sources), color: token.type === 'color' ? shown(resolveToken(file.theme, token.id, sources)) : null }))
  const requested = pendingFocus(focus)
  const target = requested && file.theme.tokens[requested.tokenId] ? requested : null
  const hidesTarget = (query: string) => { const entry = target && entries.find(item => item.token.id === target.tokenId); return Boolean(entry && !matches(file, entry, query)) }
  const shownSearch: Search = target && search.open && hidesTarget(search.query) ? { open: false, query: '', refocus: false } : search
  const selectedIds = target ? new Set([target.tokenId]) : selected
  const selectedId = target ? target.tokenId : [...selected][0] ?? null
  const visible = shownSearch.open ? entries.filter(entry => matches(file, entry, shownSearch.query)) : entries
  const defaultExpanded = tokenTypes.filter(type => entries.some(entry => entry.token.type === type))
  const openGroups = expanded ?? defaultExpanded
  const settle = () => {
    if (!target) return
    setSelected(new Set([target.tokenId]))
    setSearch(shownSearch)
    setExpanded(current => [...new Set([...(current ?? defaultExpanded), file.theme.tokens[target.tokenId]!.type])])
    themeFocus.acknowledge(target.sequence)
  }
  const open = (id: string, confirm = false, deleteIds: readonly string[] | null = null) => {
    settle()
    setSelected(new Set([id]))
    setMenu(null)
    returnFocus.current = id
    const anchor = rows.current.get(id) ?? null
    setEditing({ id, open: Boolean(anchor), pending: !anchor, confirm, deleteIds, container: floatingPortalContainer(anchor) })
  }
  const close = () => setEditing(current => current ? { ...current, open: false, pending: false, confirm: false } : current)
  const create = (type: TokenType) => {
    settle()
    const id = documentStore.commands.theme.createToken(type)
    if (!id) return
    setSearch({ open: false, query: '', refocus: false })
    setExpanded(current => [...new Set([...(current ?? defaultExpanded), type])])
    open(id)
  }
  const duplicate = (id: string) => { const next = documentStore.commands.theme.duplicateToken(id); if (next) open(next) }
  const remove = (ids: readonly string[]) => {
    settle()
    const deleting = new Set(ids)
    const index = visible.findIndex(entry => deleting.has(entry.token.id))
    if (!documentStore.commands.theme.deleteTokens([...deleting])) return
    const remaining = visible.filter(entry => !deleting.has(entry.token.id))
    const neighbor = remaining[Math.min(Math.max(index, 0), Math.max(remaining.length - 1, 0))]?.token.id ?? null
    returnFocus.current = neighbor
    setSelected(neighbor ? new Set([neighbor]) : new Set())
    close()
  }
  const editedToken = editing ? file.theme.tokens[editing.id] : undefined
  const deleteIds = editing?.deleteIds?.filter(id => Boolean(file.theme.tokens[id])) ?? (editedToken ? [editedToken.id] : [])
  const deleting = new Set(deleteIds)
  const deleteReferences = deleteIds.reduce((count, id) => count + tokenReferences(file, id).filter(reference => !('aliasTokenId' in reference) || !deleting.has(reference.aliasTokenId)).length, 0)
  const editedIndex = editedToken ? tokens.findIndex(token => token.id === editedToken.id) : -1
  const reorder = (id: string, index: number) => { settle(); documentStore.commands.theme.reorderToken(id, index) }
  const selectionTokens = () => sortedTokens(documentStore.getSnapshot().file ?? file).filter(token => selectedIds.has(token.id))
  const copySelection = async () => {
    const targetClipboard = clipboard()
    const chosen = selectionTokens()
    if (!targetClipboard || !chosen.length) return false
    await targetClipboard.writeText(encodeThemeTokens(chosen))
    return true
  }
  const inspectClipboard = () => {
    const targetClipboard = clipboard()
    setClipboardContainsTokens(null)
    if (!targetClipboard) { setClipboardContainsTokens(false); return }
    void targetClipboard.readText().then(text => setClipboardContainsTokens(Boolean(decodeThemeTokens(text)))).catch(() => setClipboardContainsTokens(false))
  }
  const cutSelection = async () => { if (await copySelection()) documentStore.commands.theme.deleteTokens(selectionTokens().map(token => token.id)) }
  const paste = async (overwrite: boolean) => {
    const targetClipboard = clipboard()
    if (!targetClipboard) return
    const incoming = decodeThemeTokens(await targetClipboard.readText())
    const current = documentStore.getSnapshot().file
    if (!incoming || !current) return
    const ordered = sortedTokens(current)
    const used = new Set(ordered.map(token => token.name))
    const mapped = new Map<string, string>()
    const records = incoming.map(token => {
      const existing = overwrite ? ordered.find(candidate => candidate.type === token.type && candidate.name === token.name) : undefined
      const id = existing?.id ?? crypto.randomUUID()
      mapped.set(token.id, id)
      return { source: token, id, create: !existing, name: existing?.name ?? uniqueTokenName(used, token.name) }
    })
    let last = ordered.at(-1)?.orderKey ?? null
    const commands: FileCommand[] = []
    for (const record of records) {
      const sourceValue = record.source.value
      const aliasId = sourceValue.kind === 'alias' ? mapped.get(sourceValue.tokenId) ?? (current.theme.tokens[sourceValue.tokenId]?.type === record.source.type ? sourceValue.tokenId : null) : null
      const value: TokenValue = sourceValue.kind !== 'alias' ? structuredClone(sourceValue) : aliasId && aliasId !== record.id ? { kind: 'alias', tokenId: aliasId } : defaultTokenValue(record.source.type)
      if (record.create) {
        const orderKey = orderKeyBetween(last, null)
        last = orderKey
        commands.push({ type: 'token.create', token: { ...structuredClone(record.source), id: record.id, name: record.name, orderKey, value } as FileToken })
      } else {
        commands.push({ type: 'token.setValue', tokenId: record.id, value })
        if (record.source.description !== undefined) commands.push({ type: 'token.setDescription', tokenId: record.id, description: record.source.description })
      }
    }
    if (commands.length && documentStore.commands.executeBatch(commands)) setSelected(new Set(records.map(record => record.id)))
  }
  const duplicateSelection = () => {
    const copies = selectionTokens().flatMap(token => { const id = documentStore.commands.theme.duplicateToken(token.id); return id ? [id] : [] })
    if (copies.length) setSelected(new Set(copies))
  }
  const moveSelection = (direction: TokenMove) => {
    const current = sortedTokens(documentStore.getSnapshot().file ?? file)
    const ids = moveThemeTokens(current, selectedIds, direction)
    const commands: FileCommand[] = ids.map((tokenId, index) => ({ type: 'token.reorder', tokenId, index }))
    if (ids.some((tokenId, index) => tokenId !== current[index]?.id)) documentStore.commands.executeBatch(commands)
  }
  const requestSelectionDelete = () => {
    const ids = selectionTokens().map(token => token.id)
    if (!ids.length) return
    const selectedForDelete = new Set(ids)
    const references = ids.reduce((count, id) => count + tokenReferences(file, id).filter(reference => !('aliasTokenId' in reference) || !selectedForDelete.has(reference.aliasTokenId)).length, 0)
    if (references > 0) open(ids[0]!, true, ids)
    else remove(ids)
  }
  const menuGroups: ContextMenuAction[][] = [[
    { id: 'cut', label: copy.cut, shortcut: 'Mod+X', disabled: readOnly || !selectedIds.size, onSelect: () => { void cutSelection() } },
    { id: 'copy', label: copy.copy, shortcut: 'Mod+C', disabled: !selectedIds.size, onSelect: () => { void copySelection() } },
    { id: 'paste', label: copy.paste, shortcut: 'Mod+V', disabled: readOnly || clipboardContainsTokens === false, onSelect: () => { void paste(false) } },
    { id: 'paste-over', label: copy.pasteOver, shortcut: 'Mod+Shift+V', disabled: readOnly || clipboardContainsTokens === false, onSelect: () => { void paste(true) } },
    { id: 'duplicate', label: copy.duplicate, shortcut: 'Mod+D', disabled: readOnly || !selectedIds.size, onSelect: duplicateSelection },
  ], [
    { id: 'select-all', label: copy.selectAll, shortcut: 'Mod+A', onSelect: () => setSelected(new Set(visible.map(entry => entry.token.id))) },
  ], [
    { id: 'move-up', label: copy.moveUp, disabled: readOnly || !selectedIds.size, onSelect: () => moveSelection('up') },
    { id: 'move-down', label: copy.moveDown, disabled: readOnly || !selectedIds.size, onSelect: () => moveSelection('down') },
    { id: 'move-first', label: copy.moveFirst, disabled: readOnly || !selectedIds.size, onSelect: () => moveSelection('first') },
    { id: 'move-last', label: copy.moveLast, disabled: readOnly || !selectedIds.size, onSelect: () => moveSelection('last') },
  ], [
    { id: 'delete', label: copy.delete, shortcut: 'Backspace', disabled: readOnly || !selectedIds.size, onSelect: requestSelectionDelete },
  ]]
  const focusable = visible.some(entry => entry.token.id === selectedId) ? selectedId : visible[0]?.token.id ?? null
  const rowRef = (tokenId: string) => (element: HTMLDivElement | null) => {
    if (!element) { rows.current.delete(tokenId); return }
    rows.current.set(tokenId, element)
    setEditing(current => current?.id === tokenId && current.pending ? { ...current, open: true, pending: false, container: floatingPortalContainer(element) } : current)
    if (target?.tokenId !== tokenId || revealed.current === target.sequence) return
    revealed.current = target.sequence
    element.scrollIntoView({ block: 'nearest' })
    element.focus({ preventScroll: true })
  }
  const toolbar = <ThemeToolbar actions={<>
    {!shownSearch.open && <ThemeIconButton label={copy.search} icon="search" autoFocus={shownSearch.refocus} onClick={() => { settle(); setSearch({ open: true, query: '', refocus: false }) }} />}
    {!readOnly && <ThemeTokenTypeMenu label={copy.add} mode={mode} options={tokenTypeOptions} buttonRef={addButton} onSelect={value => create(value as TokenType)} />}
  </>}>{shownSearch.open ? <ThemeSearchField id="theme-token-search" label={copy.search} value={shownSearch.query} onChange={query => { settle(); setSearch({ open: true, query, refocus: false }) }} onClose={refocus => { settle(); setSearch({ open: false, query: '', refocus }) }} /> : <ThemeCount>{copy.count(tokens.length)}</ThemeCount>}</ThemeToolbar>

  if (!tokens.length) return <ThemePanelLayout>{toolbar}<ThemeEmpty title={copy.emptyTitle} action={<ThemeButton onClick={() => create('color')}>{copy.create}</ThemeButton>} /></ThemePanelLayout>

  return <ThemePanelLayout>
    {toolbar}
    {tokenTypes.map(type => {
      const groupEntries = entries.filter(entry => entry.token.type === type)
      if (!groupEntries.length) return null
      const groupVisible = visible.filter(entry => entry.token.type === type)
      const groupOpen = shownSearch.open || openGroups.includes(type)
      return <ThemeGroup key={type} id={type} title={typeLabel(type)} count={groupEntries.length} expanded={groupOpen} toggleLabel={groupOpen ? copy.collapse(typeLabel(type)) : copy.expand(typeLabel(type))} onToggle={() => { settle(); setExpanded(current => { const source = current ?? defaultExpanded; return source.includes(type) ? source.filter(item => item !== type) : [...source, type] }) }}>
        {groupVisible.length ? <ThemeTokenList label={copy.list(typeLabel(type))}>{groupVisible.map(entry => <ThemeTokenRow key={entry.token.id}
          rowRef={rowRef(entry.token.id)}
          label={copy.row(entry.token.name, valueText(file, entry))}
          swatch={entry.token.type === 'color' ? <ThemeSwatch color={entry.color ? colorToCss(resolveToken(file.theme, entry.token.id, sources)!) : null} label={describeColor(entry.color)} /> : <ThemeTokenGlyph>{glyphs[entry.token.type]}</ThemeTokenGlyph>}
          name={entry.token.name}
          value={<TokenValue file={file} entry={entry} />}
          selected={selectedIds.has(entry.token.id)}
          focusable={entry.token.id === focusable}
          onSelect={() => { settle(); if (!selectedIds.has(entry.token.id)) setSelected(new Set([entry.token.id])) }}
          onOpen={() => open(entry.token.id)}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
            settle()
            close()
            const visibleIds = visible.map(item => item.token.id)
            if (event.shiftKey && selectedId) {
              const anchor = visibleIds.indexOf(selectedId)
              const current = visibleIds.indexOf(entry.token.id)
              if (anchor >= 0 && current >= 0) setSelected(new Set([...selectedIds, ...visibleIds.slice(Math.min(anchor, current), Math.max(anchor, current) + 1)]))
            } else if (event.metaKey || event.ctrlKey) {
              const next = new Set(selectedIds)
              if (next.has(entry.token.id)) next.delete(entry.token.id); else next.add(entry.token.id)
              setSelected(next)
            } else if (!selectedIds.has(entry.token.id)) setSelected(new Set([entry.token.id]))
            inspectClipboard()
            setMenu({ x: event.clientX, y: event.clientY })
          }}
          onDelete={readOnly ? undefined : () => open(entry.token.id, true, [entry.token.id])} />)}</ThemeTokenList> : <ThemeNote>{copy.noMatches}</ThemeNote>}
      </ThemeGroup>
    })}
    <ThemeEditorPopover key={editing?.id ?? 'none'} open={Boolean(editing?.open && editedToken)} mode={mode} title={deleteIds.length > 1 ? copy.deleteSelectionTitle(deleteIds.length) : editedToken ? copy.editor(typeLabel(editedToken.type)) : copy.editor(copy.color)} container={editing?.container ?? null}
      titleActions={editedToken && !readOnly ? <>
        <ThemeIconButton label={copy.moveUp} icon="chevron" direction="up" disabled={editedIndex <= 0} onClick={() => reorder(editedToken.id, editedIndex - 1)} />
        <ThemeIconButton label={copy.moveDown} icon="chevron" direction="down" disabled={editedIndex >= tokens.length - 1} onClick={() => reorder(editedToken.id, editedIndex + 1)} />
      </> : null}
      anchor={() => (editing ? rows.current.get(editing.id) : null) ?? null}
      finalFocus={() => (returnFocus.current ? rows.current.get(returnFocus.current) : null) ?? addButton.current}
      onOpenChange={next => { if (!next) close() }}>
      {editing && editedToken && <TokenEditor file={file} token={editedToken} sources={sources} mode={mode} readOnly={readOnly} confirm={editing.confirm} deleteCount={deleteIds.length} referenceCount={deleteReferences} onConfirm={confirm => setEditing({ ...editing, confirm })} onDuplicate={() => duplicate(editedToken.id)} onDelete={() => remove(deleteIds)} onClose={close} />}
    </ThemeEditorPopover>
    {menu && <ContextMenu position={menu} label={copy.actions} groups={menuGroups} onClose={() => setMenu(null)} />}
  </ThemePanelLayout>
}
