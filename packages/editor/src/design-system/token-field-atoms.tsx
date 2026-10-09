import type { ReactNode } from 'react'
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

export type TokenChooserOption = Readonly<{ value: string; label: string; disabled?: boolean }>

/** A token list that always shows its action as the face; choosing an entry reports it and the face resets. */
export function TokenChooser({ id, label, placeholder, options, disabled = false, onChoose }: { id: string; label: string; placeholder: string; options: readonly TokenChooserOption[]; disabled?: boolean; onChoose: (tokenId: string) => void }) {
  const unavailable = disabled || !options.some(option => !option.disabled)
  return <label className="token-chooser" htmlFor={id} data-disabled={unavailable || undefined}>
    <select id={id} className="token-chooser-input" aria-label={label} title={label} value="" disabled={unavailable} onChange={event => { const value = event.currentTarget.value; if (value) onChoose(value) }}>
      <option value="" disabled hidden>{placeholder}</option>
      {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
    <span className="token-chooser-chevron" aria-hidden="true"><Icon name="chevron" /></span>
  </label>
}

/**
 * A text action. `reason` keeps the button focusable but unavailable, and names why; `describedBy` points at the
 * visible diagnostic it depends on.
 */
export function TokenActionButton({ label, text, disabled = false, reason, describedBy, onClick }: { label: string; text: string; disabled?: boolean; reason?: string | undefined; describedBy?: string | undefined; onClick: () => void }) {
  const blocked = reason !== undefined
  return <button type="button" className="token-action" aria-label={label} title={reason ?? label} disabled={disabled} aria-disabled={blocked || undefined} aria-describedby={blocked ? describedBy : undefined} onClick={() => { if (!blocked) onClick() }}>{text}</button>
}
