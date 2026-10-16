import { useId, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Icon } from './atoms'
import type { IconName } from './atoms'
import { AppearanceSelect } from './appearance-atoms'
import { floatingPortalContainer } from './floating-portal'
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

type InspectorFlexGlyphKind = 'direction' | 'wrap' | 'gap' | 'distribution' | 'padding-horizontal' | 'padding-vertical' | 'padding-split' | 'remove'

/** Paper's compact Flex glyphs use deliberately tiny, pixel-aligned geometry. */
export function InspectorFlexGlyph({ kind, column = false }: { kind: InspectorFlexGlyphKind; column?: boolean }) {
  if (kind === 'direction') return <svg className="inspector-flex-glyph" data-column={column || undefined} width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true"><path d="M.5 4.5h7.9M8.4 4.5 5.3 1.17M8.4 4.5 5.3 7.83" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg>
  if (kind === 'wrap') return <svg className="inspector-flex-glyph" width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4.5 10.5-3-3 3-3m-3 3H8" /><path d="M8 7.5A3.5 3.5 0 0 0 8 .5M5 .5h3" /></svg>
  if (kind === 'gap') return <svg className="inspector-flex-glyph" data-column={column || undefined} width="13" height="12" viewBox="0 0 13 12" fill="none" stroke="currentColor" aria-hidden="true"><rect x=".5" y="1.5" width="3" height="9" rx=".5" /><rect x="9.5" y="1.5" width="3" height="9" rx=".5" /><path d="M6.5 0v12" /></svg>
  if (kind === 'distribution') return <svg className="inspector-flex-glyph" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2 9.5h1V12H2zm7-3h1V12H9zM9 0h1v2.5H9zM2 0h1v5.5H2z" /><circle cx="2.5" cy="7.5" r="2" fill="none" stroke="currentColor" /><circle cx="9.5" cy="4.5" r="2" fill="none" stroke="currentColor" /></svg>
  if (kind === 'padding-horizontal') return <svg className="inspector-flex-glyph" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><rect x=".5" y=".5" width="11" height="11" rx="1.5" /><path d="M3.5 3v6m5-6v6" /></svg>
  if (kind === 'padding-vertical') return <svg className="inspector-flex-glyph" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><rect x=".5" y=".5" width="11" height="11" rx="1.5" /><path d="M3 3.5h6m-6 5h6" /></svg>
  if (kind === 'padding-split') return <svg className="inspector-flex-glyph" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><rect x=".5" y=".5" width="11" height="11" rx="1.5" /><path d="M2.5 4v4m7-4v4M4 2.5h4m-4 7h4" /></svg>
  return <svg className="inspector-flex-glyph" width="10" height="2" viewBox="0 0 10 2" fill="none" stroke="currentColor" aria-hidden="true"><path d="M10 1H0" vectorEffect="non-scaling-stroke" /></svg>
}

export function InspectorFlexBlock({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <div className="inspector-flex-block" role="group" aria-label={title}>
    <div className="inspector-flex-header"><span>{title}</span>{action}</div>
    {children}
  </div>
}

export function InspectorFlexRemoveButton({ label, title, disabled = false, onClick }: { label: string; title: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="inspector-flex-small-action" aria-label={label} title={title} disabled={disabled} onClick={onClick}><InspectorFlexGlyph kind="remove" /></button>
}

export function nextInspectorInputIndex(current: number, count: number, reverse: boolean): number | null {
  const next = current + (reverse ? -1 : 1)
  return current >= 0 && next >= 0 && next < count ? next : null
}

export function InspectorFlexPanel({ alignment, direction, wrap, gap, overflow, crossGap, padding }: { alignment: ReactNode; direction: ReactNode; wrap: ReactNode; gap: ReactNode; overflow: ReactNode; crossGap?: ReactNode; padding: ReactNode }) {
  const numericTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target
    if (!(target instanceof HTMLInputElement) || !target.matches('.inspector-input')) return
    const root = event.currentTarget.closest<HTMLElement>('.editor-root') ?? event.currentTarget
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input.inspector-input:not(:disabled)'))
    const next = nextInspectorInputIndex(inputs.indexOf(target), inputs.length, event.shiftKey)
    if (next === null) return
    event.preventDefault()
    inputs[next]!.focus()
    inputs[next]!.select()
  }
  return <div className="inspector-flex-panel" onKeyDown={numericTab}>
    <div className="inspector-flex-alignment">{alignment}</div>
    <div className="inspector-flex-controls">
      <div className="inspector-flex-control-row"><span>{direction}</span>{wrap}</div>
      <div className="inspector-flex-control-row"><span>{gap}</span>{overflow}</div>
      {crossGap && <div className="inspector-flex-control-row"><span>{crossGap}</span><span aria-hidden="true" /></div>}
    </div>
    <div className="inspector-flex-padding">{padding}</div>
  </div>
}

export function InspectorSpacingHeading({ label, control }: { label: string; control: ReactNode }) { return <div className="inspector-spacing-heading"><span className="inspector-spacing-heading-label">{label}</span>{control}</div> }

/** `lead` keeps the first control compact and lets the second take the remaining width. */
export function InspectorRow({ lead = false, children }: { lead?: boolean; children: ReactNode }) { return <div className="inspector-row" data-lead={lead || undefined}>{children}</div> }

export function InspectorNote({ id, icon, children }: { id?: string; icon?: IconName; children: ReactNode }) {
  return <p id={id} className="inspector-note">{icon && <Icon name={icon} />}<span>{children}</span></p>
}

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)) }

type NumberFieldProps = { id: string; label: string; prefix?: ReactNode; value: number | null; placeholder?: string; min?: number; max?: number; suffix?: string; precision?: number; disabled?: boolean; onCommit: (value: number) => void; onScrubStart?: () => InspectorScrubSession | null }

export function InspectorNumberField(props: NumberFieldProps) {
  return <InspectorScrubField {...props} />
}

export function InspectorTextField({ id, label, prefix, value, placeholder, disabled = false, maxLength = 128, onCommit }: { id: string; label: string; prefix?: ReactNode; value: string; placeholder?: string; disabled?: boolean; maxLength?: number; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const commit = (raw: string) => { setDraft(null); const next = raw.trim(); if (next && next !== value) onCommit(next) }
  return <label className="inspector-field" htmlFor={id} data-disabled={disabled || undefined}>
    {prefix !== undefined && <span className="inspector-field-prefix" aria-hidden="true">{prefix}</span>}
    <input id={id} className="inspector-input" aria-label={label} autoComplete="off" maxLength={maxLength} disabled={disabled} placeholder={placeholder} value={draft ?? value} onChange={event => setDraft(event.currentTarget.value)} onBlur={event => { if (cancelled.current) { cancelled.current = false; return } if (draft !== null) commit(event.currentTarget.value) }} onKeyDown={event => {
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
  onPreview?: (value: T | null) => void
}

const backward = new Set(['ArrowLeft', 'ArrowUp'])
const forward = new Set(['ArrowRight', 'ArrowDown'])

/**
 * Segmented single choice with radio semantics: arrow keys move to and select the next enabled option (wrapping), Home
 * and End select the first and last enabled option, Space selects the focused one. Unavailable options are skipped and
 * describe their reason; the checked option (or the first enabled one) is the only tab stop.
 */
export function InspectorRadioGroup<T extends string>({ label, value, options, disabled = false, showLabels = false, mixedLabel, description, onChange, onPreview }: RadioGroupProps<T>) {
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
  const group = <div className="inspector-segments" role="radiogroup" aria-label={label} aria-describedby={notes.length ? notes.map((_, index) => noteId(index)).join(' ') : undefined} aria-disabled={disabled || undefined} onKeyDown={onKeyDown} onPointerLeave={() => onPreview?.(null)} onBlur={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) onPreview?.(null) }}>
    {options.map((option, index) => {
      const unavailable = !available(option)
      const reasonId = `${id}-reason-${index}`
      return <button key={option.value} type="button" role="radio" className="inspector-segment" aria-label={option.label} aria-checked={option === checked} aria-disabled={unavailable || undefined} aria-describedby={unavailable && option.reason ? reasonId : undefined} title={option.reason ? `${option.label}: ${option.reason}` : option.label} tabIndex={option === tabStop ? 0 : -1} data-checked={option === checked || undefined} data-labelled={showLabels && option.icon ? '' : undefined} onPointerEnter={() => onPreview?.(option.value)} onFocus={() => onPreview?.(option.value)} onClick={() => select(option)}>
        {option.icon && <Icon name={option.icon} />}
        {(!option.icon || showLabels) && <span className="inspector-segment-label">{option.label}</span>}
        {option.reason && <span id={reasonId} hidden>{option.reason}</span>}
      </button>
    })}
  </div>
  // One stable wrapper keeps the radios mounted (and focused) when a note appears; without notes it adds no layout box.
  return <div className="inspector-radio-field" data-notes={notes.length ? '' : undefined}>{group}{notes.map((note, index) => <InspectorNote key={index} id={noteId(index)}>{note}</InspectorNote>)}</div>
}

export function InspectorSelectField({ id, label, prefix, value, options, disabled = false, onChange }: { id: string; label: string; prefix?: ReactNode; value: string; options: readonly { value: string; label: string; disabled?: boolean }[]; disabled?: boolean; onChange: (value: string) => void }) {
  return <AppearanceSelect id={id} label={label} value={value} options={options} {...(prefix === undefined ? {} : { prefix })} align="start" disabled={disabled} onChange={onChange} />
}

export function InspectorCheck({ id, label, checked, disabled = false, onChange }: { id: string; label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label className="inspector-check" htmlFor={id} data-disabled={disabled || undefined}><input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} /><span className="inspector-check-box" aria-hidden="true"><Icon name="check" /></span><span>{label}</span></label>
}

/** A tri-state checkbox for multi-selection controls. Mixed is visible and announced instead of being coerced to off. */
export function InspectorToggle({ label, value, disabled = false, onChange, onPreview }: { label: string; value: boolean | null; disabled?: boolean; onChange: (checked: boolean) => void; onPreview?: (checked: boolean | null) => void }) {
  return <button type="button" role="checkbox" className="inspector-check inspector-toggle" aria-checked={value === null ? 'mixed' : value} data-disabled={disabled || undefined} disabled={disabled} onPointerEnter={() => onPreview?.(value !== true)} onPointerLeave={() => onPreview?.(null)} onFocus={() => onPreview?.(value !== true)} onBlur={() => onPreview?.(null)} onClick={() => onChange(value !== true)}><span className="inspector-check-box" aria-hidden="true">{value === null ? <Icon name="minus" /> : value ? <Icon name="check" /> : null}</span><span>{label}</span></button>
}

export function InspectorIconButton({ label, title = label, icon, disabled = false, onClick }: { label: string; title?: string; icon: IconName; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="inspector-icon-button" aria-label={label} title={title} disabled={disabled} onClick={onClick}><Icon name={icon} /></button>
}

/** A compact inspector popup that keeps Base UI focus, dismissal, and keyboard behavior inside the editor theme scope. */
export function InspectorPopover({ label, title = label, icon, disabled = false, wide = false, contentClassName, onOpenChange, children }: { label: string; title?: string; icon: IconName; disabled?: boolean; wide?: boolean; contentClassName?: string; onOpenChange?: (open: boolean) => void; children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  return <Popover.Root onOpenChange={open => { if (open) setContainer(floatingPortalContainer(trigger.current)); onOpenChange?.(open) }}>
    <Popover.Trigger ref={trigger} className="inspector-icon-button inspector-popover-trigger" aria-label={label} title={label} disabled={disabled}><Icon name={icon} /></Popover.Trigger>
    <Popover.Portal container={container}><Popover.Positioner className="inspector-popover-positioner" side="left" align="start" sideOffset={4}><Popover.Popup className="inspector-popover-popup" data-wide={wide || undefined} aria-label={label}>
      <div className="inspector-popover-header"><Popover.Title className="inspector-popover-title">{title}</Popover.Title><Popover.Close className="inspector-popover-close" aria-label={`Close ${label}`}><Icon name="close" /></Popover.Close></div>
      <div className={['inspector-popover-content', contentClassName].filter(Boolean).join(' ')}>{children}</div>
    </Popover.Popup></Popover.Positioner></Popover.Portal>
  </Popover.Root>
}

function TransformGlyph({ kind }: { kind: 'rotate' | 'flip-x' | 'flip-y' }) {
  if (kind === 'rotate') return <svg viewBox="0 0 16 16" aria-hidden="true"><g transform="translate(16 0) scale(-1 1)"><path d="M9.5 2.5L6 4.5V3H4.5C3.11929 3 2 4.11929 2 5.5V8H1V5.5C1 3.567 2.567 2 4.5 2H6V0.5L9.5 2.5Z" fill="currentColor" /><rect x="5.5" y="6.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" /></g></svg>
  const triangles = <><path d="M1.5 12.5H5.5V3.5L1.5 12.5Z" /><path d="M12.5 12.5H8.5V3.5L12.5 12.5Z" /></>
  return <svg viewBox="0 0 14 16" aria-hidden="true" className={kind === 'flip-y' ? 'inspector-transform-flip-y' : undefined}>{triangles}</svg>
}

/** Paper-style quarter-turn and reflection actions sharing one compact segmented surface. */
export function InspectorTransformActions({ actionsLabel, rotateLabel, flipXLabel, flipYLabel, absoluteLabel, flipXPressed = false, flipYPressed = false, absolutePressed, disabled = false, onRotate, onFlipX, onFlipY, onAbsolute }: { actionsLabel: string; rotateLabel: string; flipXLabel: string; flipYLabel: string; absoluteLabel?: string; flipXPressed?: boolean; flipYPressed?: boolean; absolutePressed?: boolean; disabled?: boolean; onRotate: () => void; onFlipX: () => void; onFlipY: () => void; onAbsolute?: () => void }) {
  const action = (kind: 'rotate' | 'flip-x' | 'flip-y', label: string, pressed: boolean | undefined, onClick: () => void) => <button key={kind} type="button" className="inspector-transform-action" aria-label={label} title={label} disabled={disabled} {...(pressed === undefined ? {} : { 'aria-pressed': pressed })} onClick={onClick}><TransformGlyph kind={kind} /></button>
  return <div className="inspector-transform-actions" role="group" aria-label={actionsLabel} data-position-toggle={onAbsolute ? '' : undefined}>{action('rotate', rotateLabel, undefined, onRotate)}{action('flip-x', flipXLabel, flipXPressed, onFlipX)}{action('flip-y', flipYLabel, flipYPressed, onFlipY)}{onAbsolute && absoluteLabel && <button type="button" className="inspector-transform-action" aria-label={absoluteLabel} title={absoluteLabel} aria-pressed={absolutePressed} disabled={disabled} onClick={onAbsolute}><Icon name="selection" /></button>}</div>
}

/** Paper exposes Column before Row and uses one source glyph rotated between the two choices. */
export function InspectorFlexDirection({ label, rowLabel, columnLabel, axis, disabled = false, onAxis }: { label: string; rowLabel: string; columnLabel: string; axis: 'row' | 'column' | null; disabled?: boolean; onAxis: (axis: 'row' | 'column') => void }) {
  const direction = (value: 'column' | 'row', text: string) => <button key={value} type="button" className="inspector-flex-direction-button" data-axis={value} aria-label={text} title={text} aria-pressed={axis === value} disabled={disabled} onClick={() => onAxis(value)}><InspectorFlexGlyph kind="direction" column={value === 'column'} /></button>
  return <div className="inspector-flex-direction" role="group" aria-label={label}>{direction('column', columnLabel)}{direction('row', rowLabel)}</div>
}

export function InspectorFlexWrap({ label, wrapped, disabled = false, onChange }: { label: string; wrapped: boolean; disabled?: boolean; onChange: (wrapped: boolean) => void }) {
  return <button type="button" className="inspector-flex-small-action" aria-label={label} title={label} aria-pressed={wrapped} disabled={disabled} onClick={() => onChange(!wrapped)}><InspectorFlexGlyph kind="wrap" /></button>
}

export function InspectorFlexPaddingToggle({ label, individual, disabled = false, onChange }: { label: string; individual: boolean; disabled?: boolean; onChange: (individual: boolean) => void }) {
  return <button type="button" className="inspector-flex-small-action inspector-flex-padding-toggle" aria-label={label} title={label} aria-pressed={individual} disabled={disabled} onClick={() => onChange(!individual)}><InspectorFlexGlyph kind="padding-split" /></button>
}

export type InspectorFlexOverflowAction = 'main-space-between' | 'cross-space-between' | 'first-baseline' | 'last-baseline'

export function inspectorFlexOverflowItems(mainLabel: string, crossLabel: string, showCross: boolean): readonly Readonly<{ action: InspectorFlexOverflowAction; label: string; group: 'space' | 'baseline' }>[] {
  return [
    { action: 'main-space-between', label: mainLabel, group: 'space' },
    ...(showCross ? [{ action: 'cross-space-between' as const, label: crossLabel, group: 'space' as const }] : []),
    { action: 'first-baseline', label: 'First baseline', group: 'baseline' },
    { action: 'last-baseline', label: 'Last baseline', group: 'baseline' },
  ]
}

/** The compact distribution menu mirrors Paper's two checked groups and stays inside the active editor theme scope. */
export function InspectorFlexOverflow({ label, mainLabel, crossLabel, showCross, mainChecked, crossChecked, firstBaselineChecked, lastBaselineChecked, lastBaselineDisabled = false, disabled = false, onAction }: { label: string; mainLabel: string; crossLabel: string; showCross: boolean; mainChecked: boolean; crossChecked: boolean; firstBaselineChecked: boolean; lastBaselineChecked: boolean; lastBaselineDisabled?: boolean; disabled?: boolean; onAction: (action: InspectorFlexOverflowAction) => void }) {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const item = (action: InspectorFlexOverflowAction, text: string, checked: boolean, unavailable = false) => <button key={action} type="button" role="menuitemcheckbox" className="inspector-flex-menu-item" aria-checked={checked} disabled={disabled || unavailable} onClick={() => onAction(action)}><span className="inspector-flex-menu-check" aria-hidden="true">{checked && <Icon name="check" />}</span><span>{text}</span></button>
  const items = inspectorFlexOverflowItems(mainLabel, crossLabel, showCross)
  const checked = (action: InspectorFlexOverflowAction) => action === 'main-space-between' ? mainChecked : action === 'cross-space-between' ? crossChecked : action === 'first-baseline' ? firstBaselineChecked : lastBaselineChecked
  return <Popover.Root onOpenChange={open => { if (open) setContainer(floatingPortalContainer(trigger.current)) }}>
    <Popover.Trigger ref={trigger} className="inspector-flex-small-action" aria-label={label} title={label} disabled={disabled}><InspectorFlexGlyph kind="distribution" /></Popover.Trigger>
    <Popover.Portal container={container}><Popover.Positioner className="inspector-popover-positioner" side="left" align="start" sideOffset={4}><Popover.Popup className="inspector-popover-popup inspector-flex-menu" aria-label={label} role="menu">
      <div className="inspector-flex-menu-group" role="group" aria-label="Space between"><span className="inspector-flex-menu-label">Space between</span>{items.filter(entry => entry.group === 'space').map(entry => item(entry.action, entry.label, checked(entry.action)))}</div>
      <div className="inspector-flex-menu-divider" />
      <div className="inspector-flex-menu-group" role="group" aria-label="Align to baseline"><span className="inspector-flex-menu-label">Align to baseline</span>{items.filter(entry => entry.group === 'baseline').map(entry => item(entry.action, entry.label, checked(entry.action), entry.action === 'last-baseline' && lastBaselineDisabled))}</div>
    </Popover.Popup></Popover.Positioner></Popover.Portal>
  </Popover.Root>
}

export type InspectorSpacingModeValue = 'all' | 'axes' | 'sides'

/** Paper-style compact spacing topology selector. Icons come from the editor's existing icon set. */
export function InspectorSpacingMode({ label, value, labels, disabled = false, onChange }: { label: string; value: InspectorSpacingModeValue | null; labels: Record<InspectorSpacingModeValue, string>; disabled?: boolean; onChange: (value: InspectorSpacingModeValue) => void }) {
  const icons: Record<InspectorSpacingModeValue, IconName> = { all: 'block', axes: 'flex-row', sides: 'freeform' }
  return <div className="inspector-spacing-mode" role="group" aria-label={label}>{(['all', 'axes', 'sides'] as const).map(mode => <button key={mode} type="button" className="inspector-spacing-mode-button" aria-label={labels[mode]} title={labels[mode]} aria-pressed={value === mode} disabled={disabled} onClick={() => onChange(mode)}><Icon name={icons[mode]} /></button>)}</div>
}

/** One gradient stop: position, color, and a trailing action on the first line; the color source below. */
export function InspectorPaintStop({ label, position, color, binding, action }: { label: string; position: ReactNode; color: ReactNode; binding: ReactNode; action: ReactNode }) {
  return <div className="inspector-paint-stop" role="group" aria-label={label}><span className="inspector-paint-stop-position">{position}</span><span className="inspector-paint-stop-color">{color}</span><span className="inspector-paint-stop-action">{action}</span><span className="inspector-paint-stop-binding">{binding}</span></div>
}

export function InspectorTextButton({ label, icon, shortcut, wide = false, disabled = false, onClick }: { label: string; icon?: IconName; shortcut?: string; wide?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="inspector-text-button" data-wide={wide || undefined} disabled={disabled} onClick={onClick}>{icon && <Icon name={icon} />}<span>{label}</span>{shortcut && <span className="inspector-text-button-shortcut">{shortcut}</span>}</button>
}

export function InspectorFlexEntryAction({ label, shortcut, disabled = false, onClick }: { label: string; shortcut: string; disabled?: boolean; onClick: () => void }) {
  return <div className="inspector-flex-entry"><InspectorTextButton label={label} shortcut={shortcut} wide disabled={disabled} onClick={onClick} /></div>
}

export function InspectorCountButton({ label, count, disabled = false, onClick }: { label: string; count: number; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="inspector-count-button" aria-label={label} title={label} disabled={disabled} onClick={onClick}><Icon name="target" /><span>{count}</span></button>
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
      <InspectorScrubHandle className="inspector-field-suffix" value={parts.opacity} min={0} max={100} disabled={disabled} onPreview={next => setOpacityDraft(next === null ? null : String(next))} onCommit={next => commitOpacity(String(next))} onCancel={() => setOpacityDraft(null)}>%</InspectorScrubHandle>
    </label>}
  </span>
}

/** A pointer scrub owned by the caller: `move` previews, `end` commits once, `cancel` restores exactly. */
export type InspectorScrubSession = { move: (value: number) => void; end: () => void; cancel: () => void }

const roundTo = (value: number, precision: number) => { const factor = 10 ** precision; return Math.round(value * factor) / factor }

type ScrubFieldProps = {
  id: string
  label: string
  prefix?: ReactNode
  value: number | null
  placeholder?: string
  min?: number
  max?: number
  suffix?: string
  /** Decimal places kept on commit and per scrub pixel (0 scrubs by 1, 2 scrubs by 0.01). */
  precision?: number
  /** Paper's default accumulator rate is one quarter of the field's small step per horizontal pixel. */
  sensitivity?: number
  /** Quantized step used while Shift is held. Defaults to ten small steps. */
  largeStep?: number
  disabled?: boolean
  onCommit: (value: number) => void
  /** Called when a field holding a value is emptied; without it an empty field restores the value. */
  onClear?: () => void
  /** Starts a scrub once the pointer has moved on a visible prefix or unit affordance; returning null leaves the value alone. */
  onScrubStart?: () => InspectorScrubSession | null
  tokens?: readonly InspectorNumericToken[]
  tokenLabel?: string
}

export type InspectorNumericToken = Readonly<{ name: string; value: number; displayValue: string }>

type ScrubHandleProps = {
  children: ReactNode
  className?: string
  ariaHidden?: boolean
  value: number | null
  min?: number
  max?: number
  precision?: number
  sensitivity?: number
  largeStep?: number
  disabled?: boolean
  onPreview: (value: number | null) => void
  onCommit: (value: number) => void
  onCancel?: () => void
  onScrubStart?: () => InspectorScrubSession | null
}

/** Shared horizontal scrub gesture used by every numeric affordance, regardless of its visual field treatment. */
export function InspectorScrubHandle({ children, className, ariaHidden = true, value, min = -100000, max = 100000, precision = 0, sensitivity = 0.25, largeStep, disabled = false, onPreview, onCommit, onCancel, onScrubStart }: ScrubHandleProps) {
  const scrubbable = !disabled && value !== null
  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!scrubbable || value === null || event.button !== 0) return
    event.preventDefault()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const pointerId = event.pointerId
    const handle = event.currentTarget
    const start = value
    const step = 10 ** -precision
    let session: InspectorScrubSession | null = null
    let last = start
    let previousX = event.clientX
    let travel = 0
    let lockAcquired = false
    let finished = false
    const finish = (cancel: boolean) => {
      if (finished) return
      finished = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', lost)
      window.removeEventListener('keydown', key, true)
      document.removeEventListener('pointerlockchange', lockChange)
      document.removeEventListener('pointerlockerror', lockError)
      if (document.pointerLockElement === handle) document.exitPointerLock()
      const current = session
      session = null
      onPreview(null)
      if (!current) return
      if (cancel) current.cancel(); else current.end()
    }
    const begin = () => {
      if (onScrubStart) return onScrubStart()
      return { move: () => undefined, end: () => { if (last !== start) onCommit(last) }, cancel: () => onCancel?.() }
    }
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      const movement = document.pointerLockElement === handle ? next.movementX : next.clientX - previousX
      previousX = next.clientX
      travel += movement
      if (!session) {
        if (Math.abs(travel) < 3) return
        session = begin()
        if (!session) { finish(true); return }
      }
      const quantum = next.shiftKey ? largeStep ?? step * 10 : step
      const accumulated = travel * sensitivity * step
      const quantized = Math.trunc(accumulated / quantum) * quantum
      const current = clamp(roundTo(start + quantized, precision), min, max)
      if (current === last) return
      last = current
      onPreview(current)
      session.move(current)
    }
    const up = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(false) }
    const lost = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(true) }
    const lockChange = () => {
      if (document.pointerLockElement === handle) { lockAcquired = true; return }
      if (lockAcquired) finish(true)
    }
    const lockError = () => undefined
    const key = (next: globalThis.KeyboardEvent) => { if (next.key !== 'Escape') return; if (session) { next.preventDefault(); next.stopPropagation() } finish(true) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', lost)
    window.addEventListener('keydown', key, true)
    document.addEventListener('pointerlockchange', lockChange)
    document.addEventListener('pointerlockerror', lockError)
    try {
      void handle.requestPointerLock().then(() => { if (finished && document.pointerLockElement === handle) document.exitPointerLock() }).catch(error => { console.warn('Pointer lock was unavailable; scrubbing continues with client coordinates.', error) })
    } catch (error) { console.warn('Pointer lock was unavailable; scrubbing continues with client coordinates.', error) }
  }
  return <span className={className} data-scrub-area={scrubbable || undefined} data-scrub-handle={scrubbable || undefined} aria-hidden={ariaHidden || undefined} onPointerDown={onPointerDown}>{children}</span>
}

/**
 * Number field whose visible prefix and unit affordances scrub horizontally. The scrub only opens a session after a
 * few pixels of movement, so a click never starts a gesture; Escape or pointer cancel ends it without a commit.
 * Listeners live only for the drag.
 */
export function InspectorScrubField({ id, label, prefix, value, placeholder, min = -100000, max = 100000, suffix, precision = 0, sensitivity = 0.25, largeStep, disabled = false, onCommit, onClear, onScrubStart, tokens = [], tokenLabel = 'Choose numeric token' }: ScrubFieldProps) {
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
  const scrub = { value, min, max, precision, sensitivity, disabled, onPreview: setScrubbing, onCommit, ...(largeStep === undefined ? {} : { largeStep }), ...(onScrubStart ? { onScrubStart } : {}) }
  return <div className="inspector-field" data-disabled={disabled || undefined} data-scrubbing={scrubbing !== null || undefined}>
    {prefix !== undefined && <InspectorScrubHandle className="inspector-field-prefix" {...scrub}>{prefix}</InspectorScrubHandle>}
    <input id={id} className="inspector-input" aria-label={label} inputMode="decimal" autoComplete="off" spellCheck={false} disabled={disabled} value={shown} placeholder={placeholder} onChange={event => setDraft(event.currentTarget.value)} onBlur={event => { if (cancelled.current) { cancelled.current = false; return } if (draft !== null) commit(event.currentTarget.value) }} onKeyDown={onKeyDown} />
    {tokens.length > 0 && <InspectorNumericTokenMenu label={tokenLabel} tokens={tokens} disabled={disabled} onChoose={onCommit} />}
    {suffix && <InspectorScrubHandle className="inspector-field-suffix" {...scrub}>{suffix}</InspectorScrubHandle>}
  </div>
}

function InspectorNumericTokenMenu({ label, tokens, disabled, onChoose }: { label: string; tokens: readonly InspectorNumericToken[]; disabled: boolean; onChoose: (value: number) => void }) {
  const [open, setOpen] = useState(false)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, (current < 0 ? 0 : current) + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    items[next]?.focus()
  }
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) setContainer(floatingPortalContainer(trigger.current)) }}>
    <Popover.Trigger ref={trigger} className="inspector-numeric-token" aria-label={label} title={label} disabled={disabled}><Icon name="chevron" /></Popover.Trigger>
    <Popover.Portal container={container}><Popover.Positioner className="inspector-numeric-token-positioner" side="bottom" align="end" sideOffset={4}><Popover.Popup className="inspector-numeric-token-popup" onKeyDown={move}>
      <div className="inspector-numeric-token-list" role="menu" aria-label={label}>{tokens.map((token, index) => <button key={`${token.name}-${token.displayValue}`} type="button" role="menuitem" className="inspector-numeric-token-option" autoFocus={index === 0} onClick={() => { onChoose(token.value); setOpen(false) }}><span>{token.name}</span><span className="inspector-numeric-token-value">{token.displayValue}</span></button>)}</div>
    </Popover.Popup></Popover.Positioner></Popover.Portal>
  </Popover.Root>
}

export type InspectorAnchorCell = Readonly<{ key: string; label: string; pressed: boolean; x: number; y: number }>
export type InspectorFlexMatrixMode = 'normal' | 'space-horizontal' | 'space-vertical' | 'baseline'

/** Returns the next in-bounds Paper alignment cell. Special matrix modes move only on their remaining packed axis. */
export function moveFlexMatrixCell(key: string | null, arrow: string, mode: InspectorFlexMatrixMode): string | null {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(arrow)) return null
  const match = /^(\d)-(\d)$/.exec(key ?? '')
  let y = match ? Number(match[1]) : 0
  let x = match ? Number(match[2]) : 0
  if (mode === 'space-horizontal' && arrow !== 'ArrowUp' && arrow !== 'ArrowDown') return null
  if ((mode === 'space-vertical' || mode === 'baseline') && arrow !== 'ArrowLeft' && arrow !== 'ArrowRight') return null
  if (arrow === 'ArrowLeft') x -= 1
  if (arrow === 'ArrowRight') x += 1
  if (arrow === 'ArrowUp') y -= 1
  if (arrow === 'ArrowDown') y += 1
  return x < 0 || x > 2 || y < 0 || y > 2 ? null : `${y}-${x}`
}

/** One tab stop owns all nine hit regions, matching Paper's composite 3 by 3 alignment control. */
export function InspectorAnchorGrid({ label, cells, mode = 'normal', direction, disabled = false, onSelect, onSpaceBetween }: { label: string; cells: readonly InspectorAnchorCell[]; mode?: InspectorFlexMatrixMode; direction: 'row' | 'column'; disabled?: boolean; onSelect: (key: string) => void; onSpaceBetween: (key: string) => void }) {
  const selected = cells.find(cell => cell.pressed) ?? null
  const selectTarget = (target: EventTarget | null, callback: (key: string) => void) => {
    if (!(target instanceof Element)) return
    const cell = target.closest<HTMLElement>('[data-flex-cell]')
    if (cell?.dataset.flexCell) callback(cell.dataset.flexCell)
  }
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = moveFlexMatrixCell(selected?.key ?? null, event.key, mode)
    if (!next) return
    event.preventDefault()
    onSelect(next)
  }
  return <button type="button" className="inspector-anchor-grid" data-mode={mode} data-direction={direction} aria-label={`${label}${selected ? `: ${selected.label}` : ''}`} disabled={disabled} onPointerDown={event => { event.preventDefault(); selectTarget(event.target, onSelect) }} onDoubleClick={event => selectTarget(event.target, onSpaceBetween)} onKeyDown={keyDown}>
    {cells.map(cell => <span key={cell.key} id={`flex-cell-${cell.key}`} className="inspector-anchor-cell" data-flex-cell={cell.key} data-active={cell.pressed || undefined} data-x={cell.x} data-y={cell.y} title={cell.label} aria-hidden="true"><span className="inspector-anchor-dot" /><span className="inspector-anchor-bars"><i /><i /><i /></span><span className="inspector-anchor-baseline">Aa</span></span>)}
  </button>
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
