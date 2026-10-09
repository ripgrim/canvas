import type { ReactNode } from 'react'
import { Icon } from './atoms'
import type { IconName } from './atoms'
import './property.css'

export type PropertyOption = { value: string; label: string; disabled?: boolean }

export function PropertyField({ id, label, value, onChange, readOnly = false, disabled = false, type = 'text', prefix, suffix, mixed }: { id: string; label: string; value: string; onChange?: (value: string) => void; readOnly?: boolean; disabled?: boolean; type?: 'text' | 'number'; prefix?: string; suffix?: string; mixed?: string }) {
  return <label className="property-field" htmlFor={id} data-compact={prefix ? true : undefined}>
    <span className="property-label">{label}</span>
    <span className="property-control" data-readonly={readOnly || undefined} data-disabled={disabled || undefined} data-mixed={mixed ? true : undefined}>
      {prefix && <span className="property-affix" aria-hidden="true">{prefix}</span>}
      <input className="property-input" id={id} type={mixed ? 'text' : type} value={mixed ? '' : value} placeholder={mixed} readOnly={readOnly} disabled={disabled} onChange={event => onChange?.(event.currentTarget.value)} />
      {suffix && <span className="property-affix" aria-hidden="true">{suffix}</span>}
    </span>
  </label>
}

export function PropertySelect({ id, label, value, options, onChange, disabled = false }: { id: string; label: string; value: string; options: PropertyOption[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <label className="property-field" htmlFor={id}><span className="property-label">{label}</span><span className="property-select-control"><select className="property-select" id={id} value={value} disabled={disabled} onChange={event => onChange(event.currentTarget.value)}>{options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select><Icon name="chevron" /></span></label>
}

export function PropertyToggle({ id, label, checked, onChange, disabled = false }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <label className="property-toggle" htmlFor={id}><input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} /><span className="property-toggle-label">{label}</span></label>
}

export function PropertyGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="property-group" aria-label={title}><div className="property-group-header"><h3 className="property-group-title">{title}</h3>{action && <span className="property-group-actions">{action}</span>}</div>{children}</section>
}

export function PropertyGrid({ children }: { children: ReactNode }) { return <div className="property-grid">{children}</div> }

export function PropertyHint({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'read-only' }) {
  return <p className="property-hint" data-tone={tone === 'default' ? undefined : tone}>{tone === 'read-only' && <Icon name="lock" />}<span>{children}</span></p>
}

export function PropertyValue({ label, value }: { label: string; value: string }) { return <div className="property-value"><span>{label}</span><output>{value}</output></div> }

export function PropertySource({ label, value }: { label: string; value: string }) { return <div className="property-value property-source"><span>{label}</span><span className="property-source-tag"><Icon name="code" />{value}</span></div> }

export function PropertyActionRow({ children }: { children: ReactNode }) { return <div className="property-actions">{children}</div> }

export function PropertyEmpty({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: ReactNode }) {
  return <div className="property-empty" role="status"><span className="property-empty-glyph" aria-hidden="true"><Icon name={icon} /></span><span className="property-empty-title">{title}</span>{body && <span className="property-empty-body">{body}</span>}{action}</div>
}

export function PropertySelectionSummary({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="property-selection-summary" role="status"><Icon name="selection" /><span className="property-selection-text"><span className="property-selection-title">{title}</span>{detail && <span className="property-selection-detail">{detail}</span>}</span>{action}</div>
}
