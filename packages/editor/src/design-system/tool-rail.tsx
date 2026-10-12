import type { KeyboardEvent } from 'react'
import { Icon } from './atoms'
import type { IconName } from './atoms'
import './tool-rail.css'

export type ToolRailItem<T extends string> = Readonly<{ id: T; label: string; icon: IconName; shortcut?: string } & ({ available: true; detail?: string } | { available: false; reason: string })>

export function ToolRail<T extends string>({ label, groups, active, orientation = 'vertical', onSelect }: { label: string; groups: readonly (readonly ToolRailItem<T>[])[]; active: T | null; orientation?: 'horizontal' | 'vertical'; onSelect: (id: T) => void }) {
  const items = groups.flat()
  const focusId = items.some(item => item.id === active) ? active : items[0]?.id
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const prior = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
    const nextKey = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
    if (![prior, nextKey, 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    const current = buttons.indexOf(event.target as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, current + (event.key === nextKey ? 1 : -1)))
    event.preventDefault()
    buttons[next]?.focus()
  }
  return <div className="tool-rail" role="toolbar" aria-label={label} aria-orientation={orientation} data-orientation={orientation} onKeyDown={navigate}>
    {groups.map((group, index) => <div key={group.map(item => item.id).join(':')} className="tool-rail-group">
      {index > 0 && <span className="tool-rail-separator" role="separator" aria-orientation={orientation === 'horizontal' ? 'vertical' : 'horizontal'} />}
      {group.map(item => {
        const noteId = `tool-rail-note-${item.id}`
        const note = item.available ? item.detail : item.reason
        return <button key={item.id} type="button" role="radio" className="tool-rail-button" aria-label={item.label} aria-checked={item.id === active} aria-disabled={!item.available || undefined} aria-describedby={note ? noteId : undefined} aria-keyshortcuts={item.available ? item.shortcut : undefined} tabIndex={item.id === focusId ? 0 : -1} data-active={item.id === active || undefined} data-unavailable={!item.available || undefined} onClick={() => { if (item.available) onSelect(item.id) }}>
          <Icon name={item.icon} />
          <span className="tool-rail-tip">
            <span className="tool-rail-tip-title"><span className="tool-rail-tip-label">{item.label}</span>{item.available && item.shortcut && <kbd className="tool-rail-tip-shortcut">{item.shortcut}</kbd>}</span>
            {note && <span id={noteId} className="tool-rail-tip-note">{note}</span>}
          </span>
        </button>
      })}
    </div>)}
  </div>
}
