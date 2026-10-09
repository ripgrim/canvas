import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import './context-menu.css'

export type ContextMenuAction = {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  reason?: string
  onSelect?: () => void
  children?: ContextMenuAction[]
}

const enabledItems = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')).filter(item => item.offsetParent !== null)

function MenuItems({ groups, onClose, nested = false }: { groups: ContextMenuAction[][]; onClose: () => void; nested?: boolean }) {
  const activate = (action: ContextMenuAction) => {
    if (action.disabled || action.children?.length || !action.onSelect) return
    action.onSelect()
    onClose()
  }
  return <>{groups.map((group, groupIndex) => <div key={groupIndex} className="context-menu-group" role="group">
    {group.map((action, itemIndex) => <div className="context-menu-entry" key={action.id} data-submenu={action.children?.length ? 'true' : undefined}>
      <button type="button" className="context-menu-item" role="menuitem" disabled={action.disabled} aria-disabled={action.disabled || undefined} aria-haspopup={action.children?.length ? 'menu' : undefined} title={action.reason} autoFocus={!nested && groupIndex === 0 && itemIndex === 0 && !action.disabled} onClick={() => activate(action)}>
        <span className="context-menu-label">{action.label}</span>
        {action.shortcut && <kbd className="context-menu-shortcut">{action.shortcut}</kbd>}
        {action.children?.length ? <span className="context-menu-arrow" aria-hidden="true">›</span> : null}
      </button>
      {action.children?.length ? <div className="context-menu-submenu" role="menu" aria-label={action.label}><MenuItems groups={[action.children]} onClose={onClose} nested /></div> : null}
    </div>)}
  </div>)}</>
}

export function ContextMenu({ position, label, groups, onClose }: { position: { x: number; y: number }; label: string; groups: ContextMenuAction[][]; onClose: () => void }) {
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = enabledItems(event.currentTarget)
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    items[index]?.focus()
  }
  const stop = (event: MouseEvent<HTMLDivElement>) => event.stopPropagation()
  const style = { '--context-menu-x': `${position.x}px`, '--context-menu-y': `${position.y}px` } as CSSProperties
  return <div className="context-menu-layer" onPointerDown={onClose} onContextMenu={event => { event.preventDefault(); onClose() }}>
    <div className="context-menu-surface" role="menu" aria-label={label} style={style} onPointerDown={stop} onKeyDown={navigate}><MenuItems groups={groups} onClose={onClose} /></div>
  </div>
}
