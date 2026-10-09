import type { KeyboardEvent, ReactNode } from 'react'
import { Icon } from './atoms'
import type { IconName } from './atoms'
import './sidebar.css'
import './theme-panel.css'

export function SidebarStack({ children }: { children: ReactNode }) {
  return <div className="sidebar-stack">{children}</div>
}

export function SidebarSection({ id, title, count, expanded, toggleLabel, actions, grow = false, onToggle, children }: { id: string; title: string; count?: number | undefined; expanded: boolean; toggleLabel: string; actions?: ReactNode; grow?: boolean; onToggle: () => void; children: ReactNode }) {
  const bodyId = `sidebar-section-${id}`
  return <div className="sidebar-section" data-section={id} data-expanded={expanded || undefined} data-grow={grow || undefined}>
    <div className="sidebar-section-header">
      <button type="button" className="sidebar-section-toggle" aria-label={toggleLabel} aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        <span className="sidebar-section-chevron" aria-hidden="true"><Icon name="chevron" /></span>
        <span className="sidebar-section-title">{title}</span>
        {count !== undefined && <span className="sidebar-section-count" aria-hidden="true">{count}</span>}
      </button>
      {actions && <span className="sidebar-section-actions">{actions}</span>}
    </div>
    {expanded && <div className="sidebar-section-body" id={bodyId}>{children}</div>}
  </div>
}

export function SidebarAction({ label, icon, disabled, reason, onSelect }: { label: string; icon: IconName; disabled?: boolean; reason?: string | undefined; onSelect?: () => void }) {
  return <button type="button" className="sidebar-action" aria-label={label} title={disabled && reason ? `${label}: ${reason}` : label} aria-disabled={disabled || undefined} onClick={() => { if (!disabled) onSelect?.() }}><Icon name={icon} /></button>
}

export function SidebarPageRow({ pageId, name, selected, onSelect }: { pageId?: string | undefined; name: string; selected: boolean; onSelect: () => void }) {
  return <div role="button" tabIndex={0} className="sidebar-page-row" data-page-id={pageId} data-selected={selected ? 'true' : 'false'} aria-current={selected ? 'page' : undefined} onClick={onSelect} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() } }}>
    <span className="sidebar-page-icon" aria-hidden="true"><Icon name="file" /></span>
    <span className="sidebar-page-name">{name}</span>
  </div>
}

/** Inset segmented tabs: Left, Right, Home, and End move selection and focus together. */
export function SidebarTabs<T extends string>({ label, idPrefix, value, options, onChange }: { label: string; idPrefix: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !options.length) return
    event.preventDefault()
    const index = Math.max(0, options.findIndex(option => option.value === value))
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length
    const next = options[nextIndex]!
    if (next.value !== value) onChange(next.value)
    document.getElementById(`${idPrefix}-tab-${next.value}`)?.focus()
  }
  return <div className="sidebar-tabs"><div className="sidebar-tabs-track" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
    {options.map(option => <button key={option.value} type="button" role="tab" id={`${idPrefix}-tab-${option.value}`} className="sidebar-tab" aria-selected={option.value === value} aria-controls={option.value === value ? `${idPrefix}-panel-${option.value}` : undefined} tabIndex={option.value === value ? 0 : -1} onClick={() => { if (option.value !== value) onChange(option.value) }}>{option.label}</button>)}
  </div></div>
}

export function SidebarTabPanel({ idPrefix, value, children }: { idPrefix: string; value: string; children: ReactNode }) {
  return <div className="sidebar-tab-panel" role="tabpanel" id={`${idPrefix}-panel-${value}`} aria-labelledby={`${idPrefix}-tab-${value}`}>{children}</div>
}
