import { useId, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Icon } from './atoms'
import type { IconName } from './atoms'
import './inspector.css'

export function InspectorStack({ children }: { children: ReactNode }) { return <div className="sections-stack">{children}</div> }

export function InspectorHeading({ children }: { children: ReactNode }) { return <div className="section-heading" role="heading" aria-level={2}>{children}</div> }

export function InspectorSection({ id, title, actions, children }: { id: string; title: string; actions?: ReactNode; children?: ReactNode }) {
  return <section className={children ? 'section-border section-open' : 'section-border'} data-section={id} aria-label={title}>
    <div className="section-heading-row"><h3 className="section-title">{title}</h3>{actions && <span className="section-actions">{actions}</span>}</div>
    {children && <div className="section-body">{children}</div>}
  </section>
}

export function InspectorGroup({ label, children }: { label?: string; children: ReactNode }) {
  return <div className="inspector-group">{label && <span className="inspector-group-label">{label}</span>}{children}</div>
}

/** `lead` keeps the first control compact and lets the second take the remaining width. */
export function InspectorRow({ lead = false, children }: { lead?: boolean; children: ReactNode }) { return <div className="inspector-row" data-lead={lead || undefined}>{children}</div> }

export function InspectorNote({ id, icon, children }: { id?: string; icon?: IconName; children: ReactNode }) {
  return <p id={id} className="inspector-note">{icon && <Icon name={icon} />}<span>{children}</span></p>
}

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)) }

export function InspectorNumberField({ id, label, prefix, value, placeholder, min = -100000, max = 100000, suffix, disabled = false, onCommit }: { id: string; label: string; prefix?: ReactNode; value: number | null; placeholder?: string; min?: number; max?: number; suffix?: string; disabled?: boolean; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const shown = draft ?? (value === null ? '' : String(Math.round(value * 100) / 100))
  const commit = (raw: string) => {
    setDraft(null)
    if (!raw.trim()) return
    const next = Number(raw)
    if (!Number.isFinite(next)) return
    const clamped = clamp(Math.round(next), min, max)
    if (clamped !== value) onCommit(clamped)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setDraft(null); event.currentTarget.blur() }
    else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && value !== null) {
      event.preventDefault()
      const step = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1)
      setDraft(null)
      onCommit(clamp(Math.round(value + step), min, max))
    }
  }
  return <label className="inspector-field" htmlFor={id} data-disabled={disabled || undefined}>
    {prefix !== undefined && <span className="inspector-field-prefix" aria-hidden="true">{prefix}</span>}
    <input id={id} className="inspector-input" aria-label={label} inputMode="numeric" autoComplete="off" spellCheck={false} disabled={disabled} value={shown} placeholder={placeholder} onChange={event => setDraft(event.currentTarget.value)} onBlur={event => { if (cancelled.current) { cancelled.current = false; return } if (draft !== null) commit(event.currentTarget.value) }} onKeyDown={onKeyDown} />
    {suffix && <span className="inspector-field-suffix" aria-hidden="true">{suffix}</span>}
  </label>
}

export function InspectorTextField({ id, label, value, disabled = false, maxLength = 128, onCommit }: { id: string; label: string; value: string; disabled?: boolean; maxLength?: number; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const commit = (raw: string) => { setDraft(null); const next = raw.trim(); if (next && next !== value) onCommit(next) }
  return <label className="inspector-field" htmlFor={id} data-disabled={disabled || undefined}>
    <input id={id} className="inspector-input" aria-label={label} autoComplete="off" maxLength={maxLength} disabled={disabled} value={draft ?? value} onChange={event => setDraft(event.currentTarget.value)} onBlur={event => { if (cancelled.current) { cancelled.current = false; return } if (draft !== null) commit(event.currentTarget.value) }} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setDraft(null); event.currentTarget.blur() }
    }} />
  </label>
}

export type InspectorOption<T extends string> = Readonly<{ value: T; label: string; icon?: IconName; disabled?: boolean; reason?: string }>

type RadioGroupProps<T extends string> = {
  label: string
  /** Null when nothing is chosen, or when the selection holds different values (see `mixedLabel`). */
  value: T | null
  options: readonly InspectorOption<T>[]
  disabled?: boolean
  /** Shows the text label beside each option's icon; icon-only options keep the label as their accessible name. */
  showLabels?: boolean
  /** Shown under the group and announced as its description while `value` is null because the selection differs. */
  mixedLabel?: string
  /** A secondary line under the group, also announced as the group's description. */
  description?: string
  onChange: (value: T) => void
}

const backward = new Set(['ArrowLeft', 'ArrowUp'])
const forward = new Set(['ArrowRight', 'ArrowDown'])

/**
 * Segmented single choice with radio semantics: arrow keys move to and select the next enabled option (wrapping), Home
 * and End select the first and last enabled option, Space selects the focused one. Unavailable options are skipped and
 * describe their reason; the checked option (or the first enabled one) is the only tab stop.
 */
export function InspectorRadioGroup<T extends string>({ label, value, options, disabled = false, showLabels = false, mixedLabel, description, onChange }: RadioGroupProps<T>) {
  const id = useId()
  const available = (option: InspectorOption<T>) => !disabled && !option.disabled
  const checked = options.find(option => option.value === value)
  const tabStop = checked ?? options.find(available) ?? options[0]
  const notes = [value === null && mixedLabel ? mixedLabel : null, description ?? null].filter((note): note is string => Boolean(note))
  const noteId = (index: number) => `${id}-note-${index}`
  const select = (option: InspectorOption<T> | undefined) => { if (option && available(option) && option.value !== value) onChange(option.value) }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    const current = radios.findIndex(radio => event.target instanceof Node && radio.contains(event.target))
    if (current < 0) return
    let target = -1
    if (backward.has(event.key) || forward.has(event.key)) {
      const step = forward.has(event.key) ? 1 : -1
      for (let offset = 1; offset <= options.length && target < 0; offset++) {
        const index = (((current + step * offset) % options.length) + options.length) % options.length
        if (available(options[index]!)) target = index
      }
    } else if (event.key === 'Home') target = options.findIndex(available)
    else if (event.key === 'End') { for (let index = options.length - 1; index >= 0 && target < 0; index--) if (available(options[index]!)) target = index }
    else if (event.key === ' ') target = current
    else return
    // Handled keys never reach the editor shortcuts (nudge, the Space hand tool) or scroll the rail.
    event.preventDefault()
    if (target < 0) return
    radios[target]?.focus()
    select(options[target])
  }
  const group = <div className="inspector-segments" role="radiogroup" aria-label={label} aria-describedby={notes.length ? notes.map((_, index) => noteId(index)).join(' ') : undefined} aria-disabled={disabled || undefined} onKeyDown={onKeyDown}>
    {options.map((option, index) => {
      const unavailable = !available(option)
      const reasonId = `${id}-reason-${index}`
      return <button key={option.value} type="button" role="radio" className="inspector-segment" aria-label={option.label} aria-checked={option === checked} aria-disabled={unavailable || undefined} aria-describedby={unavailable && option.reason ? reasonId : undefined} title={option.reason ? `${option.label}: ${option.reason}` : option.label} tabIndex={option === tabStop ? 0 : -1} data-checked={option === checked || undefined} data-labelled={showLabels && option.icon ? '' : undefined} onClick={() => select(option)}>
        {option.icon && <Icon name={option.icon} />}
        {(!option.icon || showLabels) && <span className="inspector-segment-label">{option.label}</span>}
        {option.reason && <span id={reasonId} hidden>{option.reason}</span>}
      </button>
    })}
  </div>
  // One stable wrapper keeps the radios mounted (and focused) when a note appears; without notes it adds no layout box.
  return <div className="inspector-radio-field" data-notes={notes.length ? '' : undefined}>{group}{notes.map((note, index) => <InspectorNote key={index} id={noteId(index)}>{note}</InspectorNote>)}</div>
}

export function InspectorSelectField({ id, label, value, options, disabled = false, onChange }: { id: string; label: string; value: string; options: readonly { value: string; label: string }[]; disabled?: boolean; onChange: (value: string) => void }) {
  return <label className="inspector-field inspector-select" htmlFor={id} data-disabled={disabled || undefined}>
    <select id={id} className="inspector-input" aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.currentTarget.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    <span className="inspector-select-chevron" aria-hidden="true"><Icon name="chevron" /></span>
  </label>
}

export function InspectorCheck({ id, label, checked, disabled = false, onChange }: { id: string; label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label className="inspector-check" htmlFor={id} data-disabled={disabled || undefined}><input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} /><span className="inspector-check-box" aria-hidden="true"><Icon name="check" /></span><span>{label}</span></label>
}

export function InspectorIconButton({ label, title = label, icon, disabled = false, onClick }: { label: string; title?: string; icon: IconName; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="inspector-icon-button" aria-label={label} title={title} disabled={disabled} onClick={onClick}><Icon name={icon} /></button>
}

/** One gradient stop: position, color, and a trailing action on the first line; the color source below. */
export function InspectorPaintStop({ label, position, color, binding, action }: { label: string; position: ReactNode; color: ReactNode; binding: ReactNode; action: ReactNode }) {
  return <div className="inspector-paint-stop" role="group" aria-label={label}><span className="inspector-paint-stop-position">{position}</span><span className="inspector-paint-stop-color">{color}</span><span className="inspector-paint-stop-action">{action}</span><span className="inspector-paint-stop-binding">{binding}</span></div>
}

export function InspectorTextButton({ label, icon, disabled = false, onClick }: { label: string; icon?: IconName; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="inspector-text-button" disabled={disabled} onClick={onClick}>{icon && <Icon name={icon} />}<span>{label}</span></button>
}

const hexPattern = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i
/** Splits #rrggbb or #rrggbbaa into the opaque color and an opacity percentage. */
export function splitHex(value: string): { rgb: string; opacity: number } | null {
  const match = hexPattern.exec(value.trim())
  if (!match) return null
  return { rgb: `#${match[1]!.toLowerCase()}`, opacity: match[2] ? Math.round(Number.parseInt(match[2], 16) * 100 / 255) : 100 }
}
/** Joins an opaque color and an opacity percentage; full opacity drops the alpha pair. */
export function joinHex(rgb: string, opacity: number): string {
  const percent = clamp(Math.round(opacity), 0, 100)
  return percent >= 100 ? rgb : `${rgb}${Math.round(percent * 255 / 100).toString(16).padStart(2, '0')}`
}

type ColorFieldProps = {
  id: string
  label: string
  opacityLabel: string
  value: string
  title?: string
  inherited?: boolean
  disabled?: boolean
  swatch?: ReactNode
  /** Placeholder for a selection holding different colors; the opacity part is hidden until one color is chosen. */
  mixed?: string
  onCommit?: (value: string) => void
}

/** Compact color control on one field surface: swatch, hex value, and opacity. Without onCommit it renders read only. */
export function InspectorColorField({ id, label, opacityLabel, value, title, inherited = false, disabled = false, swatch, mixed, onCommit }: ColorFieldProps) {
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const [opacityDraft, setOpacityDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const parts = splitHex(value) ?? { rgb: '#000000', opacity: 100 }
  const current = joinHex(parts.rgb, parts.opacity)
  const shownHex = parts.rgb.toUpperCase()
  const fill = <span className="inspector-color-swatch" aria-hidden="true"><span className="inspector-color-swatch-fill" style={{ backgroundColor: current }} /></span>
  if (!onCommit) return <span className="inspector-field inspector-color-field" role="group" aria-label={label} title={title} data-readonly="">
    {fill}<span className="inspector-color-hex">{shownHex}</span><span className="inspector-color-opacity">{parts.opacity}<span className="inspector-field-suffix">%</span></span>
  </span>
  const emit = (next: string) => { if (mixed !== undefined || next !== current) onCommit(next) }
  const commitHex = (raw: string) => {
    setHexDraft(null)
    const next = splitHex(raw.replace(/\s+/g, ''))
    if (!next) return
    emit(joinHex(next.rgb, raw.replace(/[\s#]+/g, '').length === 8 ? next.opacity : mixed !== undefined ? 100 : parts.opacity))
  }
  const commitOpacity = (raw: string) => {
    setOpacityDraft(null)
    const next = Number(raw.replace('%', '').trim())
    if (!raw.trim() || !Number.isFinite(next)) return
    emit(joinHex(parts.rgb, next))
  }
  const keys = (event: KeyboardEvent<HTMLInputElement>, reset: () => void) => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; reset(); event.currentTarget.blur() }
  }
  const blur = (draft: string | null, raw: string, commit: (raw: string) => void) => { if (cancelled.current) { cancelled.current = false; return } if (draft !== null) commit(raw) }
  return <span className="inspector-field inspector-color-field" title={title} data-inherited={inherited || undefined} data-disabled={disabled || undefined}>
    {swatch ?? fill}
    <input id={id} className="inspector-input inspector-color-hex" aria-label={label} autoComplete="off" spellCheck={false} maxLength={9} disabled={disabled} value={hexDraft ?? (mixed !== undefined ? '' : shownHex)} placeholder={mixed} onChange={event => setHexDraft(event.currentTarget.value)} onBlur={event => blur(hexDraft, event.currentTarget.value, commitHex)} onKeyDown={event => keys(event, () => setHexDraft(null))} />
    {mixed === undefined && <label className="inspector-color-opacity" htmlFor={`${id}-opacity`}>
      <input id={`${id}-opacity`} className="inspector-input" aria-label={opacityLabel} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={4} disabled={disabled} value={opacityDraft ?? String(parts.opacity)} onChange={event => setOpacityDraft(event.currentTarget.value)} onBlur={event => blur(opacityDraft, event.currentTarget.value, commitOpacity)} onKeyDown={event => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setOpacityDraft(null); emit(joinHex(parts.rgb, parts.opacity + (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1))); return }
        keys(event, () => setOpacityDraft(null))
      }} />
      <span className="inspector-field-suffix" aria-hidden="true">%</span>
    </label>}
  </span>
}

/** A pointer scrub owned by the caller: `move` previews, `end` commits once, `cancel` restores exactly. */
export type InspectorScrubSession = { move: (value: number) => void; end: () => void; cancel: () => void }

const roundTo = (value: number, precision: number) => { const factor = 10 ** precision; return Math.round(value * factor) / factor }

type ScrubFieldProps = {
  id: string
  label: string
  prefix: ReactNode
  value: number | null
  placeholder?: string
  min?: number
  max?: number
  suffix?: string
  /** Decimal places kept on commit and per scrub pixel (0 scrubs by 1, 2 scrubs by 0.01). */
  precision?: number
  disabled?: boolean
  onCommit: (value: number) => void
  /** Called when a field holding a value is emptied; without it an empty field restores the value. */
  onClear?: () => void
  /** Starts a scrub once the pointer has moved on the prefix; returning null leaves the value alone. */
  onScrubStart?: () => InspectorScrubSession | null
}

/**
 * Number field whose prefix scrubs horizontally. The scrub only opens a session after a few pixels of movement, so a
 * click never starts a gesture; Escape or pointer cancel ends it without a commit. Listeners live only for the drag.
 */
export function InspectorScrubField({ id, label, prefix, value, placeholder, min = -100000, max = 100000, suffix, precision = 0, disabled = false, onCommit, onClear, onScrubStart }: ScrubFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const [scrubbing, setScrubbing] = useState<number | null>(null)
  const cancelled = useRef(false)
  const shown = scrubbing !== null ? String(scrubbing) : draft ?? (value === null ? '' : String(roundTo(value, precision)))
  const step = 10 ** -precision
  const commit = (raw: string) => {
    setDraft(null)
    if (!raw.trim()) { if (value !== null && onClear) onClear(); return }
    const next = Number(raw.trim())
    if (!Number.isFinite(next)) return
    const clamped = clamp(roundTo(next, precision), min, max)
    if (clamped !== value) onCommit(clamped)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setDraft(null); event.currentTarget.blur() }
    else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && value !== null) {
      event.preventDefault()
      setDraft(null)
      onCommit(clamp(roundTo(value + step * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1), precision), min, max))
    }
  }
  const scrubbable = Boolean(onScrubStart) && !disabled && value !== null
  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!scrubbable || !onScrubStart || value === null || event.button !== 0) return
    event.preventDefault()
    const pointerId = event.pointerId
    const originX = event.clientX
    const start = value
    let session: InspectorScrubSession | null = null
    let last = start
    const finish = (cancel: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', lost)
      window.removeEventListener('keydown', key, true)
      const current = session
      session = null
      setScrubbing(null)
      if (!current) return
      if (cancel) current.cancel(); else current.end()
    }
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      const delta = Math.round(next.clientX - originX)
      if (!session) {
        if (Math.abs(delta) < 3) return
        session = onScrubStart()
        if (!session) { finish(true); return }
      }
      const current = clamp(roundTo(start + delta * step, precision), min, max)
      if (current === last) return
      last = current
      setScrubbing(current)
      session.move(current)
    }
    const up = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(false) }
    const lost = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(true) }
    // Capture phase on window runs before the editor keyboard service, so Escape cancels the scrub instead of clearing the selection.
    const key = (next: globalThis.KeyboardEvent) => { if (next.key !== 'Escape') return; if (session) { next.preventDefault(); next.stopPropagation() } finish(true) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', lost)
    window.addEventListener('keydown', key, true)
  }
  return <label className="inspector-field" htmlFor={id} data-disabled={disabled || undefined} data-scrubbing={scrubbing !== null || undefined}>
    <span className="inspector-field-prefix" data-scrub-handle={scrubbable || undefined} aria-hidden="true" onPointerDown={onPointerDown}>{prefix}</span>
    <input id={id} className="inspector-input" aria-label={label} inputMode="decimal" autoComplete="off" spellCheck={false} disabled={disabled} value={shown} placeholder={placeholder} onChange={event => setDraft(event.currentTarget.value)} onBlur={event => { if (cancelled.current) { cancelled.current = false; return } if (draft !== null) commit(event.currentTarget.value) }} onKeyDown={onKeyDown} />
    {suffix && <span className="inspector-field-suffix" aria-hidden="true">{suffix}</span>}
  </label>
}

export type InspectorAnchorCell = Readonly<{ key: string; label: string; pressed: boolean }>

/** The 3 by 3 alignment control: nine toggle buttons in reading order, each labelled for its anchor. */
export function InspectorAnchorGrid({ label, cells, disabled = false, onSelect }: { label: string; cells: readonly InspectorAnchorCell[]; disabled?: boolean; onSelect: (key: string) => void }) {
  return <div className="inspector-anchor-grid" role="group" aria-label={label}>
    {cells.map(cell => <button key={cell.key} type="button" className="inspector-anchor-cell" aria-label={cell.label} title={cell.label} aria-pressed={cell.pressed} disabled={disabled} onClick={() => onSelect(cell.key)}><span className="inspector-anchor-dot" aria-hidden="true" /></button>)}
  </div>
}

/** One Grid track: its number, an editable value, and earlier/later/remove actions. */
export function InspectorTrackRow({ label, index, field, earlierLabel, laterLabel, removeLabel, canEarlier, canLater, canRemove, disabled = false, onEarlier, onLater, onRemove }: { label: string; index: number; field: ReactNode; earlierLabel: string; laterLabel: string; removeLabel: string; canEarlier: boolean; canLater: boolean; canRemove: boolean; disabled?: boolean; onEarlier: () => void; onLater: () => void; onRemove: () => void }) {
  return <div className="inspector-track-row" role="group" aria-label={label}>
    <span className="inspector-track-index" aria-hidden="true">{index}</span>
    {field}
    <button type="button" className="inspector-icon-button inspector-track-earlier" aria-label={earlierLabel} title={earlierLabel} disabled={disabled || !canEarlier} onClick={onEarlier}><Icon name="chevron" /></button>
    <button type="button" className="inspector-icon-button inspector-track-later" aria-label={laterLabel} title={laterLabel} disabled={disabled || !canLater} onClick={onLater}><Icon name="chevron" /></button>
    <button type="button" className="inspector-icon-button" aria-label={removeLabel} title={removeLabel} disabled={disabled || !canRemove} onClick={onRemove}><Icon name="minus" /></button>
  </div>
}

/** A short validation message tied to the field above it; announced when it appears. */
export function InspectorAlert({ id, children }: { id: string; children: ReactNode }) {
  return <p id={id} className="inspector-note inspector-alert" role="alert">{children}</p>
}

/** A compact control that keeps its natural width inside an `InspectorRow`, next to a stretching group. */
export function InspectorFixedSlot({ children }: { children: ReactNode }) { return <div className="inspector-fixed-slot">{children}</div> }

/** Holds the second column of an `InspectorRow` empty so a lone field keeps half the width. */
export function InspectorRowSpacer() { return <span className="inspector-row-spacer" aria-hidden="true" /> }
