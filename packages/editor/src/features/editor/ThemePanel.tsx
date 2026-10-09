import { useRef, useState, useSyncExternalStore } from 'react'
import { resolveToken, tokenReferences, wouldCreateAliasCycle } from '@canvas/repo-engine/file-document'
import type { ColorToken, FileDocument, SourcePalette } from '@canvas/repo-engine/file-document'
import { colorToCss, colorToHex, hexColor } from '@canvas/repo-engine/color'
import type { Color } from '@canvas/repo-engine/color'
import { compareOrder } from '@canvas/repo-engine/order-keys'
import { ThemeButton, ThemeChip, ThemeColorValue, ThemeConfirm, ThemeCount, ThemeEditorActions, ThemeEditorField, ThemeEditorPopover, ThemeEmpty, ThemeGroup, ThemeIconButton, ThemeNote, ThemePanelLayout, ThemeReadonly, ThemeSearchField, ThemeSwatch, ThemeTokenList, ThemeTokenRow, ThemeToolbar } from '../../design-system/theme-atoms'
import { InspectorColorField, InspectorSelectField, InspectorTextField, splitHex } from '../../design-system/inspector-atoms'
import { ColorPicker } from '../../design-system/color-picker'
import { documentStore } from './document-store'
import { editorStore } from './store'
import { themeCopy as copy } from './theme-copy'
import { pendingFocus, themeFocus } from './theme-focus'

type Search = { open: boolean; query: string; refocus: boolean }
type Editing = { id: string; open: boolean; confirm: boolean }
type Shown = { hex: string; opacity: number }

const shown = (color: Color | null): Shown | null => { const parts = color ? splitHex(colorToHex(color)) : null; return parts ? { hex: parts.rgb.toUpperCase(), opacity: parts.opacity } : null }
const describe = (value: Shown | null) => value ? copy.swatch(value.hex, value.opacity) : copy.unresolved
const sortedTokens = (file: FileDocument) => Object.values(file.theme.tokens).sort(compareOrder)

function valueText(file: FileDocument, token: ColorToken, color: Shown | null): string {
  if (token.value.kind === 'alias') return copy.aliasValue(file.theme.tokens[token.value.tokenId]?.name ?? copy.missing)
  if (token.value.kind === 'source') return copy.sourceValue(token.value.property, describe(color))
  return describe(color)
}

function matches(file: FileDocument, token: ColorToken, color: Shown | null, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const fields = [token.name, color?.hex ?? '']
  if (token.value.kind === 'alias') fields.push(file.theme.tokens[token.value.tokenId]?.name ?? '')
  if (token.value.kind === 'source') fields.push(token.value.property)
  return fields.some(field => field.toLowerCase().includes(needle))
}

function TokenValue({ file, token, color }: { file: FileDocument; token: ColorToken; color: Shown | null }) {
  if (token.value.kind === 'alias') { const target = file.theme.tokens[token.value.tokenId]?.name ?? copy.missing; return <ThemeChip title={copy.aliasValue(target)}>{target}</ThemeChip> }
  return <>{token.value.kind === 'source' && <ThemeChip title={token.value.property}>{copy.source}</ThemeChip>}{color && <ThemeColorValue hex={color.hex} opacity={color.opacity} />}</>
}

function TokenEditor({ file, token, sources, mode, readOnly, confirm, onConfirm, onDuplicate, onDelete, onClose }: { file: FileDocument; token: ColorToken; sources: SourcePalette; mode: 'light' | 'dark'; readOnly: boolean; confirm: boolean; onConfirm: (confirm: boolean) => void; onDuplicate: () => void; onDelete: () => void; onClose: () => void }) {
  const theme = documentStore.commands.theme
  const resolved = resolveToken(file.theme, token.id, sources)
  const color = shown(resolved)
  const hex = resolved ? colorToHex(resolved) : '#000000'
  const literal = (next: string) => { theme.setTokenValue(token.id, { kind: 'literal', color: hexColor(next) }) }
  const targets = sortedTokens(file).filter(candidate => candidate.id !== token.id && !wouldCreateAliasCycle(file.theme, token.id, candidate.id))
  const kindOptions = [{ value: 'literal', label: copy.literal }, ...(targets.length || token.value.kind === 'alias' ? [{ value: 'alias', label: copy.alias }] : []), ...(token.value.kind === 'source' ? [{ value: 'source', label: copy.source }] : [])]
  const setKind = (kind: string) => {
    if (kind === token.value.kind) return
    if (kind === 'literal') theme.setTokenValue(token.id, { kind: 'literal', color: resolved ?? (token.value.kind === 'source' ? token.value.fallback : hexColor('#000000')) })
    else if (kind === 'alias' && targets[0]) theme.setTokenValue(token.id, { kind: 'alias', tokenId: targets[0].id })
  }
  const references = tokenReferences(file, token.id).length
  const requestDelete = () => { if (references > 0) onConfirm(true); else onDelete() }
  const value = token.value
  return <>
    <ThemeSwatch size="preview" color={resolved ? colorToCss(resolved) : null} label={`${copy.preview(token.name)}: ${describe(color)}`} />
    <ThemeEditorField label={copy.name}><InspectorTextField key={token.id} id={`theme-token-${token.id}-name`} label={copy.nameLabel} value={token.name} maxLength={64} disabled={readOnly} onCommit={name => { theme.renameToken(token.id, name) }} /></ThemeEditorField>
    <ThemeEditorField label={copy.value}>
      <InspectorSelectField id={`theme-token-${token.id}-kind`} label={copy.valueType} value={value.kind} options={kindOptions} disabled={readOnly} onChange={setKind} />
      {value.kind === 'literal' && <InspectorColorField id={`theme-token-${token.id}-color`} label={copy.colorLabel(token.name)} opacityLabel={copy.opacityLabel(token.name)} value={hex} disabled={readOnly} swatch={<ColorPicker variant="swatch" label={copy.colorLabel(token.name)} value={hex} mode={mode} disabled={readOnly} onChange={literal} />} onCommit={literal} />}
      {value.kind === 'alias' && <InspectorSelectField id={`theme-token-${token.id}-target`} label={copy.targetLabel} value={value.tokenId} disabled={readOnly} options={[...(file.theme.tokens[value.tokenId] ? [] : [{ value: value.tokenId, label: copy.missing }]), ...targets.map(target => ({ value: target.id, label: target.name }))]} onChange={tokenId => { if (tokenId !== value.tokenId) theme.setTokenValue(token.id, { kind: 'alias', tokenId }) }} />}
      {value.kind === 'source' && <ThemeReadonly title={value.property}>{value.property}</ThemeReadonly>}
    </ThemeEditorField>
    {value.kind !== 'literal' && <ThemeEditorField label={copy.resolved}><InspectorColorField id={`theme-token-${token.id}-resolved`} label={copy.colorLabel(token.name)} opacityLabel={copy.opacityLabel(token.name)} value={hex} /></ThemeEditorField>}
    {value.kind === 'source' && !readOnly && <ThemeButton onClick={() => { theme.setTokenValue(token.id, { kind: 'literal', color: resolved ?? value.fallback }) }}>{copy.detach}</ThemeButton>}
    {confirm && !readOnly ? <ThemeConfirm label={copy.confirmLabel}>
      <ThemeButton variant="danger" onClick={onDelete}>{references > 0 ? copy.confirmDelete(references) : copy.confirmPlain}</ThemeButton>
      <ThemeButton onClick={() => onConfirm(false)}>{copy.cancel}</ThemeButton>
    </ThemeConfirm> : <ThemeEditorActions>
      {!readOnly && <ThemeButton variant="danger" onClick={requestDelete}>{copy.delete}</ThemeButton>}
      {!readOnly && <ThemeButton onClick={onDuplicate}>{copy.duplicate}</ThemeButton>}
      <ThemeButton onClick={onClose}>{copy.close}</ThemeButton>
    </ThemeEditorActions>}
  </>
}

/** File theme tokens: one color group, searchable, with a popover editor beside each row. */
export function ThemePanel() {
  const state = useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot, documentStore.getSnapshot)
  const mode = useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().mode, () => editorStore.getSnapshot().mode)
  // Re-render when the preview theme changes, since source tokens resolve against it.
  useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().snapshot, () => editorStore.getSnapshot().snapshot)
  useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().previewThemeId, () => editorStore.getSnapshot().previewThemeId)
  const focus = useSyncExternalStore(themeFocus.subscribe, themeFocus.getSnapshot, themeFocus.getSnapshot)
  const [search, setSearch] = useState<Search>({ open: false, query: '', refocus: false })
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
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
  const entries = tokens.map(token => { const resolved = resolveToken(file.theme, token.id, sources); return { token, resolved, color: shown(resolved) } })
  // An unhandled Edit token request (from the inspector) wins over local selection until one of the handlers below
  // acknowledges it; a search that would hide the requested token reads as closed.
  const requested = pendingFocus(focus)
  const target = requested && file.theme.tokens[requested.tokenId] ? requested : null
  const hidesTarget = (query: string) => { const entry = target && entries.find(item => item.token.id === target.tokenId); return Boolean(entry && !matches(file, entry.token, entry.color, query)) }
  const shownSearch: Search = target && search.open && hidesTarget(search.query) ? { open: false, query: '', refocus: false } : search
  const selectedId = target ? target.tokenId : selected
  const visible = shownSearch.open ? entries.filter(entry => matches(file, entry.token, entry.color, shownSearch.query)) : entries
  const groupOpen = target ? true : expanded ?? tokens.length > 0
  /** Makes what a pending request shows the panel's own state and marks the request handled. Every handler calls it first. */
  const settle = () => {
    if (!target) return
    setSelected(target.tokenId)
    setSearch(shownSearch)
    setExpanded(true)
    themeFocus.acknowledge(target.sequence)
  }

  const open = (id: string, confirm = false) => { settle(); setSelected(id); returnFocus.current = id; setEditing({ id, open: true, confirm }) }
  const close = () => setEditing(current => current ? { ...current, open: false, confirm: false } : current)
  const create = () => {
    settle()
    const id = documentStore.commands.theme.createToken()
    if (!id) return
    setSearch({ open: false, query: '', refocus: false })
    setExpanded(true)
    open(id)
  }
  const duplicate = (id: string) => { const next = documentStore.commands.theme.duplicateToken(id); if (next) open(next) }
  const remove = (id: string) => {
    settle()
    const index = visible.findIndex(entry => entry.token.id === id)
    if (!documentStore.commands.theme.deleteTokens([id])) return
    const neighbor = visible[index + 1]?.token.id ?? visible[index - 1]?.token.id ?? null
    returnFocus.current = neighbor
    setSelected(neighbor)
    close()
  }
  const editedToken = editing ? file.theme.tokens[editing.id] : undefined
  const editedIndex = editedToken ? tokens.findIndex(token => token.id === editedToken.id) : -1
  const reorder = (id: string, index: number) => { settle(); documentStore.commands.theme.reorderToken(id, index) }
  const focusable = visible.some(entry => entry.token.id === selectedId) ? selectedId : visible[0]?.token.id ?? null
  /** Rows register for popover anchoring; the requested row is scrolled to and focused once per request, after it exists. */
  const rowRef = (tokenId: string) => (element: HTMLDivElement | null) => {
    if (!element) { rows.current.delete(tokenId); return }
    rows.current.set(tokenId, element)
    if (target?.tokenId !== tokenId || revealed.current === target.sequence) return
    revealed.current = target.sequence
    element.scrollIntoView({ block: 'nearest' })
    element.focus({ preventScroll: true })
  }

  const toolbar = <ThemeToolbar actions={<>
    {!shownSearch.open && <ThemeIconButton label={copy.search} icon="search" autoFocus={shownSearch.refocus} onClick={() => { settle(); setSearch({ open: true, query: '', refocus: false }) }} />}
    {!readOnly && <ThemeIconButton label={copy.add} icon="plus" buttonRef={addButton} onClick={create} />}
  </>}>{shownSearch.open ? <ThemeSearchField id="theme-token-search" label={copy.search} value={shownSearch.query} onChange={query => { settle(); setSearch({ open: true, query, refocus: false }) }} onClose={refocus => { settle(); setSearch({ open: false, query: '', refocus }) }} /> : <ThemeCount>{copy.count(tokens.length)}</ThemeCount>}</ThemeToolbar>

  if (!tokens.length) return <ThemePanelLayout>{toolbar}<ThemeEmpty title={copy.emptyTitle} action={<ThemeButton onClick={create}>{copy.create}</ThemeButton>} /></ThemePanelLayout>

  return <ThemePanelLayout>
    {toolbar}
    <ThemeGroup id="color" title={copy.color} count={tokens.length} expanded={groupOpen} toggleLabel={groupOpen ? copy.collapse(copy.color) : copy.expand(copy.color)} onToggle={() => { settle(); setExpanded(!groupOpen) }}>
      {visible.length ? <ThemeTokenList label={copy.list}>{visible.map(({ token, resolved, color }) => <ThemeTokenRow key={token.id}
        rowRef={rowRef(token.id)}
        label={copy.row(token.name, valueText(file, token, color))}
        swatch={<ThemeSwatch color={resolved ? colorToCss(resolved) : null} label={describe(color)} />}
        name={token.name}
        value={<TokenValue file={file} token={token} color={color} />}
        selected={token.id === selectedId}
        focusable={token.id === focusable}
        onSelect={() => { settle(); setSelected(token.id) }}
        onOpen={() => open(token.id)}
        onDelete={readOnly ? undefined : () => open(token.id, true)} />)}</ThemeTokenList> : <ThemeNote>{copy.noMatches}</ThemeNote>}
    </ThemeGroup>
    <ThemeEditorPopover key={editing?.id ?? 'none'} open={Boolean(editing?.open && editedToken)} mode={mode} title={copy.editor}
      titleActions={editedToken && !readOnly ? <>
        <ThemeIconButton label={copy.moveUp} icon="chevron" direction="up" disabled={editedIndex <= 0} onClick={() => reorder(editedToken.id, editedIndex - 1)} />
        <ThemeIconButton label={copy.moveDown} icon="chevron" direction="down" disabled={editedIndex >= tokens.length - 1} onClick={() => reorder(editedToken.id, editedIndex + 1)} />
      </> : null}
      anchor={() => (editing ? rows.current.get(editing.id) : null) ?? null}
      finalFocus={() => (returnFocus.current ? rows.current.get(returnFocus.current) : null) ?? addButton.current}
      onOpenChange={next => { if (!next) close() }}>
      {editing && editedToken && <TokenEditor file={file} token={editedToken} sources={sources} mode={mode} readOnly={readOnly} confirm={editing.confirm} onConfirm={confirm => setEditing({ ...editing, confirm })} onDuplicate={() => duplicate(editedToken.id)} onDelete={() => remove(editedToken.id)} onClose={close} />}
    </ThemeEditorPopover>
  </ThemePanelLayout>
}
