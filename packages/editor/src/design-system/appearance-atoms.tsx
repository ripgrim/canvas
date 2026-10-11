import { useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import { Select } from '@base-ui/react/select'
import { Icon } from './atoms'
import './appearance.css'

/** A pointer drag owned by the caller: `move` previews, `end` commits once, `cancel` restores exactly. */
export type DragSession<T> = { move: (value: T) => void; end: () => void; cancel: () => void }

const glyphs = {
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  eye: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></>,
  'eye-off': <><path d="M6.2 3.8A6.4 6.4 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.7 2.2M4.2 4.9A11 11 0 0 0 1.5 8S4 12.5 8 12.5a6 6 0 0 0 3-.8" /><path d="m2.5 2.5 11 11" /></>,
  grip: <><circle cx="6" cy="4" r=".6" /><circle cx="10" cy="4" r=".6" /><circle cx="6" cy="8" r=".6" /><circle cx="10" cy="8" r=".6" /><circle cx="6" cy="12" r=".6" /><circle cx="10" cy="12" r=".6" /></>,
  solid: <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />,
  gradient: <><rect x="3" y="3" width="10" height="10" rx="2" /><path d="M5.5 3.5v9M8 3.5v9M10.5 3.5v9" opacity=".6" /></>,
  image: <><rect x="2.5" y="3" width="11" height="10" rx="2" /><path d="m2.5 11 3.5-3.5 3 3 2-2 2.5 2.5" /><circle cx="10.5" cy="6" r="1" /></>,
  'stroke-width': <><path d="M3 4h10" strokeWidth=".75" /><path d="M3 8h10" strokeWidth="1.5" /><path d="M3 12.5h10" strokeWidth="2.5" /></>,
  offset: <><rect x="5.5" y="5.5" width="5" height="5" rx="1" /><rect x="2.5" y="2.5" width="11" height="11" rx="2" strokeDasharray="2 2" /></>,
  opacity: <><path d="M8 2.5S3.5 7.2 3.5 10A4.5 4.5 0 0 0 12.5 10C12.5 7.2 8 2.5 8 2.5Z" /><path d="M5.1 11.2a3 3 0 0 0 5.8 0" /></>,
  angle: <><path d="M3 13h10M3 13V3" /><path d="M6 13a7 7 0 0 1 7-7" /></>,
  length: <><path d="M2.5 8h11" /><path d="m5 5.5-2.5 2.5L5 10.5m6-5 2.5 2.5-2.5 2.5" /></>,
  position: <><path d="M2.5 8h11M8 2.5v11" /><circle cx="8" cy="8" r="2" fill="currentColor" /></>,
} as const
export type AppearanceGlyph = keyof typeof glyphs

function Glyph({ name }: { name: AppearanceGlyph }) {
  return <svg className="appearance-glyph" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">{glyphs[name]}</svg>
}

/** A small glyph for a field prefix, such as stroke width or offset. */
export function AppearanceFieldGlyph({ name }: { name: AppearanceGlyph }) { return <Glyph name={name} /> }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * Follows one pointer from a pointerdown until release. The caller's session starts only after a small movement, so a
 * plain click or double-click never opens a gesture. Escape and pointercancel cancel; listeners live only for the drag.
 */
function followPointer(event: ReactPointerEvent<HTMLElement>, start: () => DragSession<number> | null, valueAt: (event: PointerEvent) => number, onStateChange?: (dragging: boolean) => void) {
  const pointerId = event.pointerId
  const origin = { x: event.clientX, y: event.clientY }
  let session: DragSession<number> | null = null
  let started = false
  let last: number | null = null
  const finish = (cancelled: boolean) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key, true)
    const current = session
    session = null
    if (!current) return
    onStateChange?.(false)
    if (cancelled) current.cancel(); else current.end()
  }
  const move = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return
    if (!started) {
      if (Math.hypot(next.clientX - origin.x, next.clientY - origin.y) < 3) return
      started = true
      session = start()
      if (!session) { finish(true); return }
      onStateChange?.(true)
    }
    if (!session) return
    const value = valueAt(next)
    if (value !== last) { last = value; session.move(value) }
  }
  const up = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(false) }
  const cancel = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(true) }
  const key = (next: globalThis.KeyboardEvent) => { if (next.key === 'Escape' && session) { next.preventDefault(); next.stopPropagation(); finish(true) } }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key, true)
}

// Section chrome ------------------------------------------------------------------------------------------------------

/**
 * One appearance section: a 32 px header with the title and actions, then rows. An absent optional section is dimmed
 * and its whole header adds the section.
 */
export function AppearanceSection({ id, title, absent = false, actions, addLabel, onAdd, disabled = false, children }: { id: string; title: string; absent?: boolean; actions?: ReactNode; addLabel?: string; onAdd?: () => void; disabled?: boolean; children?: ReactNode }) {
  const addFromHeader = absent && onAdd && !disabled ? (event: MouseEvent<HTMLDivElement>) => { if (!(event.target as Element).closest('button, select, input, label')) onAdd() } : undefined
  return <section className="appearance-section" data-appearance-section={id} data-absent={absent || undefined} aria-label={title}>
    <div className="appearance-section-header" data-section-header="" tabIndex={-1} onClick={addFromHeader}>
      <h3 className="appearance-section-title">{title}</h3>
      <span className="appearance-section-actions">{actions}{onAdd && addLabel && <AppearanceIconButton label={addLabel} glyph="plus" disabled={disabled} onClick={onAdd} />}</span>
    </div>
    {!absent && children && <div className="appearance-section-body">{children}</div>}
  </section>
}

/** One 24 px control row with 4 px vertical padding. `lead` keeps the first control compact. */
export function AppearanceLine({ lead = false, layout = 'balanced', children }: { lead?: boolean; layout?: 'balanced' | 'value-actions'; children: ReactNode }) {
  return <div className="appearance-line" data-lead={lead || undefined} data-layout={layout === 'balanced' ? undefined : layout}>{children}</div>
}

export function AppearanceSpacer() { return <span className="appearance-spacer" aria-hidden="true" /> }

export function AppearanceIconButton({ label, glyph, disabled = false, onClick }: { label: string; glyph: AppearanceGlyph; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="appearance-icon-button" aria-label={label} title={label} disabled={disabled} onClick={onClick}><Glyph name={glyph} /></button>
}

/** A minus button that keeps focus in the section after its row disappears: the next row, the previous row, or the header. */
export function AppearanceRemoveButton({ label, disabled = false, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  const remove = (event: MouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget
    const section = button.closest('[data-appearance-section]')
    const buttons = section ? Array.from(section.querySelectorAll<HTMLElement>('[data-remove]')) : []
    const index = buttons.indexOf(button)
    const next = buttons[index + 1] ?? buttons[index - 1] ?? section?.querySelector<HTMLElement>('[data-section-header]') ?? null
    onClick()
    next?.focus()
  }
  return <button type="button" className="appearance-icon-button" data-remove="" aria-label={label} title={label} disabled={disabled} onClick={remove}><Glyph name="minus" /></button>
}

/** Eye toggle; the label names the action it performs. */
export function AppearanceVisibilityButton({ visible, showLabel, hideLabel, disabled = false, onChange }: { visible: boolean; showLabel: string; hideLabel: string; disabled?: boolean; onChange: (visible: boolean) => void }) {
  const label = visible ? hideLabel : showLabel
  return <button type="button" className="appearance-icon-button" data-off={!visible || undefined} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!visible)}><Glyph name={visible ? 'eye' : 'eye-off'} /></button>
}

/** A full-width row that replaces a selection's mismatched records with the first one. */
export function AppearanceMixedButton({ label, disabled = false, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="appearance-mixed" disabled={disabled} onClick={onClick}>{label}</button>
}

// Lists ---------------------------------------------------------------------------------------------------------------

export function AppearanceList({ label, children }: { label: string; children: ReactNode }) {
  return <div className="appearance-list" role="list" aria-label={label}>{children}</div>
}

/**
 * A reorderable item. Alt+Up and Alt+Down from any control inside move it, as do plain arrows on its drag handle. Focus
 * is restored after the move because the list may re-insert the focused row.
 */
export function AppearanceItem({ label, onMoveBy, children }: { label: string; onMoveBy?: (delta: -1 | 1) => void; children: ReactNode }) {
  const refocus = useRef<HTMLElement | null>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onMoveBy || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    if (!event.altKey && !(event.target as Element).closest('[data-drag-handle]')) return
    event.preventDefault()
    event.stopPropagation()
    refocus.current = event.target as HTMLElement
    onMoveBy(event.key === 'ArrowUp' ? -1 : 1)
  }
  const restore = (row: HTMLDivElement | null) => {
    const target = refocus.current
    if (!row || !target) return
    refocus.current = null
    if (row.contains(target) && (document.activeElement === null || document.activeElement === document.body)) target.focus()
  }
  return <div className="appearance-item" role="listitem" aria-label={label} data-sortable-row="" ref={restore} onKeyDown={onKeyDown}>{children}</div>
}

/** Drag handle inside an `AppearanceItem`. Dragging reports the destination row among the list's other rows. */
export function AppearanceDragHandle({ label, disabled = false, onDragStart }: { label: string; disabled?: boolean; onDragStart: () => DragSession<number> | null }) {
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus()
    const row = event.currentTarget.closest<HTMLElement>('[data-sortable-row]')
    const list = row?.parentElement
    if (!row || !list) return
    const destination = (pointer: PointerEvent) => Array.from(list.children).filter(child => child !== row && child.hasAttribute('data-sortable-row')).filter(child => { const rect = child.getBoundingClientRect(); return rect.top + rect.height / 2 < pointer.clientY }).length
    followPointer(event, onDragStart, destination, dragging => { if (dragging) row.setAttribute('data-dragging', ''); else row.removeAttribute('data-dragging') })
  }
  return <button type="button" className="appearance-handle" data-drag-handle="" aria-label={label} title={label} disabled={disabled} onPointerDown={onPointerDown}><Glyph name="grip" /></button>
}

// Inputs --------------------------------------------------------------------------------------------------------------

export type AppearanceOption = Readonly<{ value: string; label: string; disabled?: boolean }>

/** A themed inspector select with grouped options, keyboard navigation, and focus restoration. */
export function AppearanceSelect({ id, label, value, placeholder, options, groups, disabled = false, onChange }: { id: string; label: string; value: string | null; placeholder?: string; options?: readonly AppearanceOption[]; groups?: readonly (readonly AppearanceOption[])[]; disabled?: boolean; onChange: (value: string) => void }) {
  const sets = groups ?? [options ?? []]
  const trigger = useRef<HTMLButtonElement>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const selected = sets.flat().find(option => option.value === value)
  return <Select.Root value={value} disabled={disabled} onOpenChange={open => { if (open) setContainer(trigger.current?.closest<HTMLElement>('.editor-root') ?? null) }} onValueChange={next => { if (next !== null) onChange(next) }}>
    <Select.Trigger ref={trigger} id={id} className="inspector-field inspector-select appearance-select" aria-label={label} title={label} data-disabled={disabled || undefined} data-mixed={value === null || undefined}>
      <span className="inspector-input appearance-select-value">{selected?.label ?? placeholder}</span>
      <Select.Icon className="inspector-select-chevron"><Icon name="chevron" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={container}>
      <Select.Positioner className="appearance-select-positioner" sideOffset={4} alignItemWithTrigger={false}>
        <Select.Popup className="appearance-select-popup">
          <Select.List className="appearance-select-list">
            {sets.map((set, index) => <Select.Group key={`group-${index}`} className="appearance-select-group">
              {index > 0 && <Select.Separator className="appearance-select-separator" />}
              {set.map(option => <Select.Item key={option.value} className="appearance-select-item" value={option.value} disabled={option.disabled} label={option.label}>
                <Select.ItemText className="appearance-select-item-text">{option.label}</Select.ItemText>
                <Select.ItemIndicator className="appearance-select-indicator">✓</Select.ItemIndicator>
              </Select.Item>)}
            </Select.Group>)}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>
}

/** Compact icon segmented switch with radio semantics: arrows move focus, Enter or Space chooses. */
export function AppearanceSegments<T extends string>({ label, value, options, disabled = false, onChange }: { label: string; value: T | null; options: readonly { value: T; label: string; glyph: AppearanceGlyph }[]; disabled?: boolean; onChange: (value: T) => void }) {
  const focusValue = options.some(option => option.value === value) ? value : options[0]?.value
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    const current = buttons.indexOf(event.target as HTMLButtonElement)
    event.preventDefault()
    buttons[(current + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }
  return <div className="appearance-segments" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={onKeyDown}>
    {options.map(option => <button key={option.value} type="button" role="radio" className="appearance-segment" aria-label={option.label} title={option.label} aria-checked={option.value === value} tabIndex={option.value === focusValue ? 0 : -1} disabled={disabled} data-checked={option.value === value || undefined} onClick={() => { if (option.value !== value) onChange(option.value) }}><Glyph name={option.glyph} /></button>)}
  </div>
}

export type FilePickerHandle = { open: () => void }

/** A hidden file input; open it through `pickerRef` from a button or a type switch. */
export function AppearanceFilePicker({ label, accept, disabled = false, pickerRef, onFile }: { label: string; accept: string; disabled?: boolean; pickerRef: RefObject<FilePickerHandle | null>; onFile: (file: File) => void }) {
  return <input className="appearance-file" type="file" tabIndex={-1} aria-label={label} accept={accept} disabled={disabled} ref={input => { pickerRef.current = input ? { open: () => input.click() } : null }} onChange={event => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) onFile(file)
  }} />
}

/** Paper-style image fill row: the thumbnail is the edit affordance and metadata stays beside it. */
export function AppearanceImagePreview({ src, name, dimensions, editLabel, disabled = false, onEdit }: { src: string | null; name: string; dimensions: string | null; editLabel: string; disabled?: boolean; onEdit: () => void }) {
  const description = dimensions ? `${name} ${dimensions}` : name
  return <span className="appearance-image">
    <button type="button" className="appearance-image-thumb" aria-label={`${editLabel} ${description}`} title={`${editLabel} ${description}`} disabled={disabled} onClick={onEdit}>
      {src && <img src={src} alt="" />}
      <span className="appearance-image-edit" aria-hidden="true">{editLabel}</span>
    </button>
    <span className="appearance-image-meta" title={description}>
      <span className="appearance-image-name">{name}</span>
      {dimensions && <span className="appearance-image-dimensions">{dimensions}</span>}
    </span>
  </span>
}

// Gradient bar --------------------------------------------------------------------------------------------------------

export type GradientBarStop = { key: string; position: number; color: string; label: string }
export type GradientBarMidpoint = { key: string; stopIndex: number; position: number; value: number; label: string }
type GradientBarProps = {
  label: string
  background: string
  stops: readonly GradientBarStop[]
  midpoints: readonly GradientBarMidpoint[]
  active: number
  disabled?: boolean
  onSelect: (index: number) => void
  onStopDrag: (index: number) => DragSession<number> | null
  onMidpointDrag: (stopIndex: number) => DragSession<number> | null
  onAdd: (position: number) => void
  onRemove: (index: number) => void
  onOpen: (index: number) => void
  onNudge: (index: number, delta: number) => void
  onMidpointNudge: (stopIndex: number, delta: number) => void
  onResetMidpoint: (stopIndex: number) => void
}

/**
 * Gradient stops on a horizontal track. Click the track to add a stop; drag stops and midpoints; double-click a stop
 * to edit its color and a midpoint to reset it; Delete removes the focused stop; arrows nudge.
 */
export function GradientBar({ label, background, stops, midpoints, active, disabled = false, onSelect, onStopDrag, onMidpointDrag, onAdd, onRemove, onOpen, onNudge, onMidpointNudge, onResetMidpoint }: GradientBarProps) {
  const rail = useRef<HTMLDivElement>(null)
  const positionAt = (clientX: number) => {
    const rect = rail.current?.getBoundingClientRect()
    return rect && rect.width > 0 ? Math.round(clamp((clientX - rect.left) / rect.width, 0, 1) * 1000) / 1000 : 0
  }
  const percent = (value: number) => `${Math.round(value * 1000) / 10}%`
  const stopKeys = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 0.1 : 0.01
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); onSelect(index); onNudge(index, -step) }
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); onSelect(index); onNudge(index, step) }
    else if (event.key === 'Enter') { event.preventDefault(); onSelect(index); onOpen(index) }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && stops.length > 2) {
      event.preventDefault()
      event.stopPropagation()
      const handles = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[data-gradient-stop]') ?? [])
      const position = handles.indexOf(event.currentTarget)
      const neighbour = handles[position + 1] ?? handles[position - 1]
      neighbour?.focus()
      onRemove(index)
    }
  }
  return <div className="gradient-bar" role="group" aria-label={label} data-disabled={disabled || undefined}>
    <div className="gradient-bar-rail" ref={rail}>
      <span className="gradient-bar-track" onClick={event => { if (!disabled) onAdd(positionAt(event.clientX)) }}><span className="gradient-bar-fill" style={{ backgroundImage: background }} /></span>
      {midpoints.map(midpoint => <button key={midpoint.key} type="button" role="slider" className="gradient-bar-midpoint" style={{ left: percent(midpoint.position) }} aria-label={midpoint.label} aria-valuemin={1} aria-valuemax={99} aria-valuenow={Math.round(midpoint.value * 100)} aria-valuetext={`${Math.round(midpoint.value * 100)}%`} disabled={disabled}
        onPointerDown={event => { if (event.button !== 0 || disabled) return; event.preventDefault(); event.currentTarget.focus(); followPointer(event, () => onMidpointDrag(midpoint.stopIndex), pointer => positionAt(pointer.clientX)) }}
        onDoubleClick={() => onResetMidpoint(midpoint.stopIndex)}
        onKeyDown={event => {
          const step = event.shiftKey ? 0.1 : 0.01
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); onMidpointNudge(midpoint.stopIndex, -step) }
          else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); onMidpointNudge(midpoint.stopIndex, step) }
        }} />)}
      {stops.map((stop, index) => <button key={stop.key} type="button" role="slider" className="gradient-bar-stop" data-gradient-stop="" data-active={index === active || undefined} style={{ left: percent(stop.position) }} aria-label={stop.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(stop.position * 100)} aria-valuetext={`${Math.round(stop.position * 100)}%`} disabled={disabled}
        onPointerDown={event => { if (event.button !== 0 || disabled) return; event.preventDefault(); event.currentTarget.focus(); onSelect(index); followPointer(event, () => onStopDrag(index), pointer => positionAt(pointer.clientX)) }}
        onFocus={() => onSelect(index)}
        onDoubleClick={() => onOpen(index)}
        onKeyDown={stopKeys(index)}><span className="gradient-bar-stop-color" style={{ backgroundColor: stop.color }} /></button>)}
    </div>
  </div>
}
