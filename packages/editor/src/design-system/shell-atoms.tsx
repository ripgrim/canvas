import { useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Icon } from './atoms'
import type { IconName } from './atoms'
import { CompLogo } from './brand'
import './shell.css'

export function PanelHeaderBar({ children }: { children: ReactNode }) { return <div className="panel-header-bar">{children}</div> }

export function PanelHeaderTitle({ children, title }: { children: ReactNode; title: string }) {
  return <div className="panel-header-title" title={title}><span className="panel-header-title-text">{children}</span></div>
}

export function PanelHeaderActions({ children }: { children: ReactNode }) { return <div className="panel-header-actions">{children}</div> }

/** Secondary panel actions: a compact right-aligned row set below the rail's top edge. */
export function PanelToolbar({ label, children }: { label: string; children: ReactNode }) { return <div className="panel-toolbar" role="toolbar" aria-label={label}>{children}</div> }

export function PanelToolbarActions({ children }: { children: ReactNode }) { return <div className="panel-toolbar-actions">{children}</div> }

/** Mobile bottom sheet using the same Base UI Dialog primitive as the shadcn Base Sheet. */
export function MobileSheet({ open, mode, title, closeLabel, onOpenChange, children }: { open: boolean; mode: string; title: string; closeLabel: string; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Backdrop className={`theme-${mode} mobile-sheet-backdrop`} />
    <Dialog.Popup className={`theme-${mode} mobile-sheet-popup`}>
      <div className="mobile-sheet-header"><span className="mobile-sheet-handle" aria-hidden="true" /><Dialog.Title className="mobile-sheet-title">{title}</Dialog.Title><Dialog.Close className="mobile-sheet-close" aria-label={closeLabel} title={closeLabel}><Icon name="close" /></Dialog.Close></div>
      <div className="mobile-sheet-content">{children}</div>
    </Dialog.Popup>
  </Dialog.Portal></Dialog.Root>
}

export function HeaderIconButton({ label, icon, glyph, disabled, pressed, compact = false, onClick }: { label: string; icon?: IconName; glyph?: ReactNode; disabled?: boolean; pressed?: boolean; compact?: boolean; onClick: () => void }) {
  return <button type="button" className="header-icon-button" data-compact={compact || undefined} aria-label={label} title={label} disabled={disabled} aria-pressed={pressed} onClick={onClick}>{glyph ?? (icon ? <Icon name={icon} /> : null)}</button>
}

export function FileHomeButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return <HeaderIconButton label={label} glyph={<CompLogo height={16} />} {...(disabled === undefined ? {} : { disabled })} onClick={onClick} />
}

export function PanelResizer({ label, edge, offset, value, min, max, onChange }: { label: string; edge: 'left' | 'right'; offset: number; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const drag = useRef<{ id: number; x: number; start: number } | null>(null)
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)))
  const style = (edge === 'left' ? { left: offset - 6 } : { right: offset - 6 }) satisfies CSSProperties
  return <div className="panel-resizer" role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0} style={style}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, start: value } }}
    onPointerMove={event => { const current = drag.current; if (current?.id !== event.pointerId) return; const delta = event.clientX - current.x; onChange(clamp(current.start + (edge === 'left' ? delta : -delta))) }}
    onPointerUp={event => { if (drag.current?.id === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) } }}
    onPointerCancel={() => { drag.current = null }}
    onLostPointerCapture={() => { drag.current = null }}
    onKeyDown={event => {
      const step = event.shiftKey ? 32 : 8
      const grow = edge === 'left' ? 'ArrowRight' : 'ArrowLeft'
      const shrink = edge === 'left' ? 'ArrowLeft' : 'ArrowRight'
      if (event.key === grow) { event.preventDefault(); onChange(clamp(value + step)) }
      else if (event.key === shrink) { event.preventDefault(); onChange(clamp(value - step)) }
      else if (event.key === 'Home') { event.preventDefault(); onChange(min) }
      else if (event.key === 'End') { event.preventDefault(); onChange(max) }
    }} />
}
