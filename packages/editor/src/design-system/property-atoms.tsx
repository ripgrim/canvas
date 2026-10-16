import { useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './atoms'
import type { IconName } from './atoms'
import { InspectorScrubHandle } from './inspector-atoms'
import { AppearanceSelect } from './appearance-atoms'
import './property.css'

export type PropertyOption = { value: string; label: string; icon?: IconName; disabled?: boolean; group?: string }

export function PropertyField({ id, label, value, onChange, onBlur, readOnly = false, disabled = false, type = 'text', prefix, suffix, mixed, placeholder, maxLength }: { id: string; label: string; value: string; onChange?: (value: string) => void; onBlur?: () => void; readOnly?: boolean; disabled?: boolean; type?: 'text' | 'number'; prefix?: string; suffix?: string; mixed?: string; placeholder?: string; maxLength?: number }) {
  const [scrubbing, setScrubbing] = useState<number | null>(null)
  const parsed = Number(value)
  const numeric = type === 'number' && value.trim() && Number.isFinite(parsed) ? parsed : null
  const fieldLabel = type === 'number'
    ? <InspectorScrubHandle className="property-label property-scrub-label" ariaHidden={false} value={numeric} disabled={disabled || readOnly || !onChange} onPreview={setScrubbing} onCommit={next => onChange?.(String(next))}>{label}</InspectorScrubHandle>
    : <span className="property-label">{label}</span>
  return <label className="property-field" htmlFor={id} data-compact={prefix ? true : undefined}>
    {fieldLabel}
    <span className="property-control" data-readonly={readOnly || undefined} data-disabled={disabled || undefined} data-mixed={mixed ? true : undefined}>
      {prefix && <span className="property-affix" aria-hidden="true">{prefix}</span>}
      <input className="property-input" id={id} type={mixed ? 'text' : type} value={mixed ? '' : scrubbing === null ? value : String(scrubbing)} placeholder={mixed ?? placeholder} readOnly={readOnly} disabled={disabled} {...(maxLength === undefined ? {} : { maxLength })} onChange={event => onChange?.(event.currentTarget.value)} onBlur={onBlur} />
      {suffix && <span className="property-affix" aria-hidden="true">{suffix}</span>}
    </span>
  </label>
}

export function PropertySelect({ id, label, value, options, onChange, disabled = false }: { id: string; label: string; value: string; options: PropertyOption[]; onChange: (value: string) => void; disabled?: boolean }) {
  const grouped = options.some(option => option.group) ? options.reduce<Array<{ label?: string; options: PropertyOption[] }>>((result, option) => {
    const set = result.find(candidate => candidate.label === option.group)
    if (set) set.options.push(option)
    else result.push({ ...(option.group ? { label: option.group } : {}), options: [option] })
    return result
  }, []) : undefined
  return <div className="property-field"><span className="property-label">{label}</span><span className="property-select-control"><AppearanceSelect id={id} label={label} value={value} {...(grouped ? { groups: grouped } : { options })} align="start" layer="dialog" placement="bottom" className="property-select" disabled={disabled} onChange={onChange} /></span></div>
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
