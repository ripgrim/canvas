import { useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Icon } from './atoms'
import { floatingPortalContainer } from './floating-portal'
import './sizing-field.css'

export type SizingFieldOption = Readonly<{ value: string; label: string; selected: boolean; disabled?: boolean }>
export type SizingFieldToken = Readonly<{ name: string; value: number; displayValue: string }>
export type SizingFieldTokenGroup = Readonly<{ id: string; label: string; tokens: readonly SizingFieldToken[] }>

/** A numeric inspector field with its sizing mode attached to the trailing caret. */
export function SizingField({ label, currentLabel, options, tokenGroups = [], field, disabled = false, onChoose, onChooseToken }: { label: string; currentLabel: string; options: readonly SizingFieldOption[]; tokenGroups?: readonly SizingFieldTokenGroup[]; field: ReactNode; disabled?: boolean; onChoose: (value: string) => void; onChooseToken?: (value: number) => void }) {
  const [open, setOpen] = useState(false)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const enabled = options.filter(option => !option.disabled)
  const groups = tokenGroups.filter(group => group.tokens.length > 0)
  const focusValue = enabled.find(option => option.selected)?.value ?? enabled[0]?.value
  const choose = (option: SizingFieldOption) => {
    if (option.disabled) return
    onChoose(option.value)
    setOpen(false)
  }
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)'))
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, (current < 0 ? 0 : current) + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    items[next]?.focus()
  }
  return <div className="sizing-field-control">
    {field}
    <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) setContainer(floatingPortalContainer(trigger.current)) }}>
      <Popover.Trigger ref={trigger} className="sizing-field-trigger" aria-label={`${label}: ${currentLabel}`} title={currentLabel} disabled={disabled || !enabled.length && !groups.length}><Icon name="chevron" /></Popover.Trigger>
      <Popover.Portal container={container}><Popover.Positioner className="sizing-field-positioner" side="bottom" align="end" sideOffset={4}><Popover.Popup className="sizing-field-popup" onKeyDown={move}>
        <div className="sizing-field-options" role="menu" aria-label={label}>
          {options.map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={option.selected} className="sizing-field-option" disabled={option.disabled} autoFocus={option.value === focusValue} onClick={() => choose(option)}><span>{option.label}</span>{option.selected && <Icon name="check" />}</button>)}
          {groups.map((group, index) => <div key={group.id} className="sizing-field-token-group" role="group" aria-label={group.label} data-section-start={options.length > 0 || index > 0 || undefined}>
            {groups.length > 1 && <div className="sizing-field-caption">{group.label}</div>}
            {group.tokens.map(token => <button key={`${token.name}:${token.displayValue}`} type="button" role="menuitem" className="sizing-field-option sizing-field-token" onClick={() => { onChooseToken?.(token.value); setOpen(false) }}><span>{token.name}</span><span className="sizing-field-token-value">{token.displayValue}</span></button>)}
          </div>)}
        </div>
      </Popover.Popup></Popover.Positioner></Popover.Portal>
    </Popover.Root>
  </div>
}
