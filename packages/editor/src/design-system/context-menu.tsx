import { useRef, useState } from 'react'
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import './context-menu.css'

export type ContextMenuAction = {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  reason?: string
  onSelect?: (target?: EventTarget | null) => void
  children?: ContextMenuAction[]
}

export type ContextSubmenuPosition = {
  side: 'left' | 'right'
  x: number
  y: number
}

export function contextSubmenuPosition(rect: Pick<DOMRect, 'left' | 'right' | 'top'>, viewportWidth: number, expectedWidth = 240): ContextSubmenuPosition {
  const availableRight = viewportWidth - rect.right
  const side = availableRight >= expectedWidth || availableRight >= rect.left ? 'right' : 'left'
  return { side, x: side === 'right' ? rect.right : rect.left, y: rect.top }
}

const enabledItems = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')).filter(item => item.offsetParent !== null)
const contains = (root: HTMLElement | null, target: EventTarget | null) => target instanceof Node && Boolean(root?.contains(target))

function MenuEntry({ action, onClose, focus, portalRoot }: { action: ContextMenuAction; onClose: () => void; focus: boolean; portalRoot: HTMLElement | null }) {
  const entryRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const [submenuPosition, setSubmenuPosition] = useState<ContextSubmenuPosition | null>(null)
  const hasSubmenu = Boolean(action.children?.length)
  const openSubmenu = () => {
    if (!hasSubmenu || !triggerRef.current) return
    setSubmenuPosition(contextSubmenuPosition(triggerRef.current.getBoundingClientRect(), window.innerWidth))
  }
  const closeUnlessMovingWithinSubmenu = (event: PointerEvent<HTMLDivElement> | FocusEvent<HTMLButtonElement>) => {
    if (!contains(submenuRef.current, event.relatedTarget)) setSubmenuPosition(null)
  }
  const closeUnlessMovingToTrigger = (event: PointerEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>) => {
    if (!contains(entryRef.current, event.relatedTarget) && !contains(submenuRef.current, event.relatedTarget)) setSubmenuPosition(null)
  }
  const activate = () => {
    if (action.disabled) return
    if (hasSubmenu) { openSubmenu(); return }
    if (!action.onSelect) return
    action.onSelect(triggerRef.current)
    onClose()
  }
  const navigateSubmenu = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!hasSubmenu || event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    openSubmenu()
    requestAnimationFrame(() => submenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus())
  }
  const returnToTrigger = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft') return
    event.preventDefault()
    event.stopPropagation()
    setSubmenuPosition(null)
    triggerRef.current?.focus()
  }
  const submenuStyle = submenuPosition ? {
    '--context-submenu-x': `${submenuPosition.x}px`,
    '--context-submenu-y': `${submenuPosition.y}px`,
  } as CSSProperties : undefined

  return <>
    <div ref={entryRef} className="context-menu-entry" data-submenu={hasSubmenu ? 'true' : undefined} onPointerEnter={openSubmenu} onPointerLeave={closeUnlessMovingWithinSubmenu}>
      <button ref={triggerRef} type="button" className="context-menu-item" role="menuitem" disabled={action.disabled} aria-disabled={action.disabled || undefined} aria-haspopup={hasSubmenu ? 'menu' : undefined} aria-expanded={hasSubmenu ? Boolean(submenuPosition) : undefined} title={action.reason} autoFocus={focus} onFocus={openSubmenu} onBlur={closeUnlessMovingWithinSubmenu} onKeyDown={navigateSubmenu} onClick={activate}>
        <span className="context-menu-label">{action.label}</span>
        {action.shortcut && <kbd className="context-menu-shortcut">{action.shortcut}</kbd>}
        {hasSubmenu ? <span className="context-menu-arrow" aria-hidden="true">›</span> : null}
      </button>
    </div>
    {action.children?.length && submenuPosition && portalRoot ? createPortal(
      <div ref={submenuRef} className="context-menu-submenu-layer" data-side={submenuPosition.side} style={submenuStyle} onPointerDown={event => event.stopPropagation()} onPointerLeave={closeUnlessMovingToTrigger} onBlur={closeUnlessMovingToTrigger} onKeyDown={returnToTrigger}>
        <div className="context-menu-submenu" role="menu" aria-label={action.label}>
          <MenuItems groups={[action.children]} onClose={onClose} portalRoot={portalRoot} />
        </div>
      </div>,
      portalRoot,
    ) : null}
  </>
}

function MenuItems({ groups, onClose, focusId, portalRoot }: { groups: ContextMenuAction[][]; onClose: () => void; focusId?: string; portalRoot: HTMLElement | null }) {
  return <>{groups.map((group, groupIndex) => <div key={groupIndex} className="context-menu-group" role="group">
    {group.map(action => <MenuEntry key={action.id} action={action} onClose={onClose} focus={action.id === focusId} portalRoot={portalRoot} />)}
  </div>)}</>
}

export function ContextMenu({ position, label, groups, onClose }: { position: { x: number; y: number }; label: string; groups: ContextMenuAction[][]; onClose: () => void }) {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  const focusId = groups.flat().find(action => !action.disabled)?.id
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    // The menu owns the first Escape. Do not let this same key event reach the editor and clear its selection.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = enabledItems(event.currentTarget)
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    items[index]?.focus()
  }
  const stop = (event: MouseEvent<HTMLDivElement>) => event.stopPropagation()
  const style = { '--context-menu-x': `${position.x}px`, '--context-menu-y': `${position.y}px` } as CSSProperties
  const menu = <div ref={setLayer} className="context-menu-layer" onPointerDown={onClose} onContextMenu={event => { event.preventDefault(); onClose() }} onKeyDown={navigate}>
    <div className="context-menu-surface" role="menu" aria-label={label} style={style} onPointerDown={stop}>
      <MenuItems groups={groups} onClose={onClose} portalRoot={layer} {...(focusId ? { focusId } : {})} />
    </div>
  </div>
  if (typeof document === 'undefined') return null
  return createPortal(menu, document.querySelector('.editor-root') ?? document.body)
}
