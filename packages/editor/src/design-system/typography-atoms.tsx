import type { CSSProperties, ReactNode } from 'react'
import './typography.css'

export function TypographyPreview({ label, caption, style, text }: { label: string; caption?: string; style?: CSSProperties; text: string }) {
  return <div className="typography-preview" role="img" aria-label={label}><span className="typography-preview-text" style={style}>{text}</span>{caption && <span className="typography-preview-caption">{caption}</span>}</div>
}

export function TypographyStatus({ children }: { children: ReactNode }) {
  return <div className="typography-status" role="status">{children}</div>
}

export function TypographyControlRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="typography-control-row"><span className="typography-control-label">{label}</span><span className="typography-control-value">{children}</span></div>
}

export function TypographyBooleanControl({ label, value, disabled = false, onChange, onPreview }: { label: string; value: boolean | null; disabled?: boolean; onChange: (value: boolean) => void; onPreview?: (value: boolean | null) => void }) {
  return <div className="typography-boolean" role="radiogroup" aria-label={label} onPointerLeave={() => onPreview?.(null)} onBlur={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) onPreview?.(null) }}>
    {[false, true].map(option => <button key={String(option)} type="button" role="radio" aria-label={option ? 'On' : 'Off'} aria-checked={value === option} disabled={disabled} data-checked={value === option || undefined} onPointerEnter={() => onPreview?.(option)} onFocus={() => onPreview?.(option)} onClick={() => onChange(option)}>{option ? 'On' : 'Off'}</button>)}
  </div>
}

export function TypographyFeatureList({ groups, disabled = false, onChange, onPreview }: { groups: readonly Readonly<{ label: string; features: readonly Readonly<{ tag: string; name: string; value: boolean | null }>[] }>[]; disabled?: boolean; onChange: (tag: string, value: boolean) => void; onPreview: (tag: string, value: boolean | null) => void }) {
  return <div className="typography-feature-list">{groups.map(group => <section key={group.label} className="typography-feature-group" aria-label={group.label}><h4>{group.label}</h4>{group.features.map(feature => <TypographyControlRow key={feature.tag} label={feature.name}><TypographyBooleanControl label={feature.name} value={feature.value} disabled={disabled} onChange={value => onChange(feature.tag, value)} onPreview={value => onPreview(feature.tag, value)} /></TypographyControlRow>)}</section>)}</div>
}

export function TypographyFormattingControls({ children }: { children: ReactNode }) { return <div className="typography-formatting-controls">{children}</div> }
