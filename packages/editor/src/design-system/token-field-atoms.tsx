import { useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Icon } from './atoms'
import './token-field.css'

/**
 * Read-only presentation of a color bound to a theme token. Nothing here edits the color: changing the binding goes
 * through `TokenActions` (Rebind, Unlink, Edit token), so a bound value can never be detached by typing into it.
 */

/** Swatch, token name in the value position, and the resolved value as static context. */
export function TokenBoundField({ label, color, name, context }: { label: string; color: string; name: string; context: string }) {
  return <div className="token-field" role="group" aria-label={label} title={label}>
    <span className="token-field-swatch" aria-hidden="true"><span className="token-field-swatch-fill" style={{ background: color }} /></span>
    <span className="token-chip" aria-hidden="true">{name}</span>
    <span className="token-field-context" aria-hidden="true">{context}</span>
  </div>
}

/** A selection whose values disagree (different tokens, or tokens and literals). */
export function MixedTokensField({ label, text }: { label: string; text: string }) {
  return <div className="token-field" data-tone="mixed" role="group" aria-label={label} title={label}>
    <span className="token-field-text" aria-hidden="true">{text}</span>
  </div>
}

/** A binding that produces no color (missing, unresolvable, or not a color token). No swatch is drawn for it. */
export function MissingTokenField({ id, label, text }: { id: string; label: string; text: string }) {
  return <div id={id} className="token-field" data-tone="error" role="group" aria-label={label} title={text}>
    <span className="token-field-alert" aria-hidden="true"><Icon name="alert" /></span>
    <span className="token-field-text" aria-hidden="true">{text}</span>
  </div>
}

/** One line of binding actions under the field. */
export function TokenActions({ children }: { children: ReactNode }) { return <div className="token-actions">{children}</div> }

export type TokenChooserOption = Readonly<{ value: string; label: string; color?: string; disabled?: boolean }>

function TokenGlyph() {
  return <svg className="token-chooser-glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="5" r="2.25" /><circle cx="11" cy="5" r="2.25" /><circle cx="5" cy="11" r="2.25" /><circle cx="11" cy="11" r="2.25" /></svg>
}

/** Paper-style color-token menu. The four-circle trigger stays compact beside the color value. */
export function TokenChooser({ id, label, placeholder, options, disabled = false, onChoose }: { id: string; label: string; placeholder: string; options: readonly TokenChooserOption[]; disabled?: boolean; onChoose: (tokenId: string) => void }) {
  const unavailable = disabled || !options.some(option => !option.disabled)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const visible = options.filter(option => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const choose = (option: TokenChooserOption) => { if (!option.disabled) { onChoose(option.value); setOpen(false); setQuery('') } }
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(current => Math.max(0, Math.min(visible.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(Math.max(0, visible.length - 1)) }
    else if (event.key === 'Enter' && visible[active]) { event.preventDefault(); choose(visible[active]!) }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() }
  }
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) { setContainer(trigger.current?.closest<HTMLElement>('.editor-root') ?? null); setQuery(''); setActive(0) } }}>
    <Popover.Trigger ref={trigger} id={id} className="token-chooser" aria-label={label} title={label} disabled={unavailable} data-disabled={unavailable || undefined}><TokenGlyph /></Popover.Trigger>
    <Popover.Portal container={container}><Popover.Positioner className="token-chooser-positioner" side="left" align="start" sideOffset={4}><Popover.Popup className="token-chooser-popup">
      <div className="token-chooser-header"><Icon name="search" /><input autoFocus value={query} aria-label={placeholder} aria-controls={listId} aria-activedescendant={visible[active] ? `${listId}-${visible[active]!.value}` : undefined} placeholder={placeholder} onChange={event => { setQuery(event.currentTarget.value); setActive(0) }} onKeyDown={keys} /></div>
      <div id={listId} className="token-chooser-list" role="listbox" aria-label={label}>
        {visible.map((option, index) => <button key={option.value} id={`${listId}-${option.value}`} type="button" role="option" aria-selected={index === active} className="token-chooser-option" data-active={index === active || undefined} disabled={option.disabled} onPointerMove={() => setActive(index)} onClick={() => choose(option)}>
          <span className="token-chooser-swatch" aria-hidden="true"><span style={{ background: option.color ?? 'transparent' }} /></span><span>{option.label}</span>
        </button>)}
        {!visible.length && <div className="token-chooser-empty">No matching color tokens</div>}
      </div>
    </Popover.Popup></Popover.Positioner></Popover.Portal>
  </Popover.Root>
}

/**
 * A text action. `reason` keeps the button focusable but unavailable, and names why; `describedBy` points at the
 * visible diagnostic it depends on.
 */
export function TokenActionButton({ label, text, disabled = false, reason, describedBy, onClick }: { label: string; text: string; disabled?: boolean; reason?: string | undefined; describedBy?: string | undefined; onClick: () => void }) {
  const blocked = reason !== undefined
  return <button type="button" className="token-action" aria-label={label} title={reason ?? label} disabled={disabled} aria-disabled={blocked || undefined} aria-describedby={blocked ? describedBy : undefined} onClick={() => { if (!blocked) onClick() }}>{text}</button>
}
