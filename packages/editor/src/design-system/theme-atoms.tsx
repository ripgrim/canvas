import type { KeyboardEvent, ReactNode, Ref } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Icon } from './atoms'
import type { IconName } from './atoms'
import './theme-panel.css'

export function ThemePanelLayout({ children }: { children: ReactNode }) { return <div className="theme-panel">{children}</div> }

/** Count or search on the left, icon actions on the right, with a hairline below. */
export function ThemeToolbar({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return <div className="theme-toolbar"><div className="theme-toolbar-lead">{children}</div><div className="theme-toolbar-actions">{actions}</div></div>
}

export function ThemeCount({ children }: { children: ReactNode }) { return <span className="theme-count">{children}</span> }

export function ThemeIconButton({ label, icon, direction, disabled = false, autoFocus = false, buttonRef, onClick }: { label: string; icon: IconName; direction?: 'up' | 'down'; disabled?: boolean; autoFocus?: boolean; buttonRef?: Ref<HTMLButtonElement>; onClick: () => void }) {
  return <button ref={buttonRef} type="button" className="theme-icon-button" data-direction={direction} aria-label={label} title={label} disabled={disabled} autoFocus={autoFocus} onClick={onClick}><Icon name={icon} /></button>
}

/** Escape clears a non-empty query first; Escape or blur on an empty query closes the field. */
export function ThemeSearchField({ id, label, value, onChange, onClose }: { id: string; label: string; value: string; onChange: (value: string) => void; onClose: (refocus: boolean) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (value) onChange('')
    else onClose(true)
  }
  return <label className="theme-search" htmlFor={id}>
    <span className="theme-search-icon" aria-hidden="true"><Icon name="search" /></span>
    <input id={id} className="theme-search-input" type="text" role="searchbox" aria-label={label} placeholder={label} autoComplete="off" spellCheck={false} autoFocus value={value} onChange={event => onChange(event.currentTarget.value)} onKeyDown={onKeyDown} onBlur={() => { if (!value) onClose(false) }} />
  </label>
}

export function ThemeGroup({ id, title, count, expanded, toggleLabel, onToggle, children }: { id: string; title: string; count: number; expanded: boolean; toggleLabel: string; onToggle: () => void; children: ReactNode }) {
  const bodyId = `theme-group-${id}`
  return <div className="theme-group" data-expanded={expanded || undefined}>
    <button type="button" className="theme-group-toggle" aria-label={toggleLabel} aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined} onClick={onToggle}>
      <span className="theme-group-chevron" aria-hidden="true"><Icon name="chevron" /></span>
      <span className="theme-group-title">{title}</span>
      <span className="theme-group-count" aria-hidden="true">{count}</span>
    </button>
    {expanded && <div className="theme-group-body" id={bodyId}>{children}</div>}
  </div>
}

/** Listbox of token rows; Up, Down, Home, and End move focus between options. */
export function ThemeTokenList({ label, children }: { label: string; children: ReactNode }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'))
    if (!options.length) return
    const current = options.indexOf(event.target as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    options[next]?.focus()
  }
  return <div className="theme-token-list" role="listbox" aria-label={label} onKeyDown={onKeyDown}>{children}</div>
}

export function ThemeTokenRow({ label, swatch, name, value, selected, focusable, rowRef, onSelect, onOpen, onDelete }: { label: string; swatch: ReactNode; name: string; value: ReactNode; selected: boolean; focusable: boolean; rowRef: Ref<HTMLDivElement>; onSelect: () => void; onOpen: () => void; onDelete?: (() => void) | undefined }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && onDelete) { event.preventDefault(); onDelete() }
  }
  return <div ref={rowRef} role="option" className="theme-token-row" aria-label={label} aria-selected={selected} data-selected={selected || undefined} tabIndex={focusable ? 0 : -1} onFocus={onSelect} onClick={onOpen} onKeyDown={onKeyDown}>
    {swatch}
    <span className="theme-token-name" title={name}>{name}</span>
    <span className="theme-token-value">{value}</span>
  </div>
}

/** 16 px checkered swatch with a text equivalent; `color` is any CSS color, or null when unresolved. */
export function ThemeSwatch({ color, label, size = 'row' }: { color: string | null; label: string; size?: 'row' | 'preview' }) {
  return <span className="theme-swatch" role="img" aria-label={label} data-size={size} data-unresolved={color === null || undefined}><span className="theme-swatch-fill" style={{ background: color ?? 'transparent' }} /></span>
}

/** Compact read only value: hex plus opacity, in the inspector color field style. */
export function ThemeColorValue({ hex, opacity }: { hex: string; opacity: number }) {
  return <span className="theme-color-value" aria-hidden="true"><span className="theme-color-hex">{hex}</span><span className="theme-color-opacity">{opacity}%</span></span>
}

export function ThemeChip({ children, title }: { children: ReactNode; title?: string }) { return <span className="theme-chip" title={title}>{children}</span> }

export function ThemeEmpty({ title, action }: { title: string; action?: ReactNode }) {
  return <div className="theme-empty"><span className="theme-empty-title">{title}</span>{action}</div>
}

export function ThemeNote({ children }: { children: ReactNode }) { return <p className="theme-note">{children}</p> }

export function ThemeButton({ children, variant = 'default', disabled = false, onClick }: { children: ReactNode; variant?: 'default' | 'danger' | 'primary'; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="theme-button" data-variant={variant} disabled={disabled} onClick={onClick}>{children}</button>
}

/** Token editor popover anchored beside a row. The portal carries the editor appearance class. */
export function ThemeEditorPopover({ open, mode, title, titleActions, anchor, finalFocus, onOpenChange, children }: { open: boolean; mode: string; title: string; titleActions?: ReactNode; anchor: () => Element | null; finalFocus: () => HTMLElement | null; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  // Keys typed inside the editor never reach canvas shortcuts; Escape and Tab stay with the popover.
  const isolate = (event: KeyboardEvent<HTMLDivElement>) => { if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation() }
  return <Popover.Root open={open} onOpenChange={next => onOpenChange(next)}>
    <Popover.Portal className={`theme-${mode}`}>
      <Popover.Positioner side="right" align="start" sideOffset={8} anchor={anchor} className="theme-editor-positioner">
        <Popover.Popup className="theme-editor" finalFocus={() => finalFocus() ?? true} onKeyDown={isolate}>
          <div className="theme-editor-title-row"><Popover.Title className="theme-editor-title">{title}</Popover.Title>{titleActions && <span className="theme-editor-title-actions">{titleActions}</span>}</div>
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}

/** Visual label column plus control; controls carry their own accessible names. */
export function ThemeEditorField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="theme-editor-field"><span className="theme-editor-label" aria-hidden="true">{label}</span><div className="theme-editor-control">{children}</div></div>
}

export function ThemeReadonly({ children, title }: { children: ReactNode; title?: string }) { return <span className="theme-readonly" title={title}>{children}</span> }

export function ThemeEditorActions({ children }: { children: ReactNode }) { return <div className="theme-editor-actions">{children}</div> }

export function ThemeConfirm({ label, children }: { label: string; children: ReactNode }) { return <div className="theme-confirm" role="group" aria-label={label}>{children}</div> }
