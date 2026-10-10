import { useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Icon } from './atoms'
import './sizing-field.css'

export type SizingFieldOption = Readonly<{ value: string; label: string; selected: boolean; disabled?: boolean }>

/** A numeric inspector field with its sizing mode attached to the trailing caret. */
export function SizingField({ label, currentLabel, options, field, disabled = false, onChoose }: { label: string; currentLabel: string; options: readonly SizingFieldOption[]; field: ReactNode; disabled?: boolean; onChoose: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const enabled = options.filter(option => !option.disabled)
  const focusValue = enabled.find(option => option.selected)?.value ?? enabled[0]?.value
  const choose = (option: SizingFieldOption) => {
    if (option.disabled) return
    onChoose(option.value)
    setOpen(false)
  }
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'))
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, (current < 0 ? 0 : current) + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    items[next]?.focus()
  }
  return <div className="sizing-field-control">
    {field}
    <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) setContainer(trigger.current?.closest<HTMLElement>('.editor-root') ?? null) }}>
      <Popover.Trigger ref={trigger} className="sizing-field-trigger" aria-label={`${label}: ${currentLabel}`} title={currentLabel} disabled={disabled || !enabled.length}><Icon name="chevron" /></Popover.Trigger>
      <Popover.Portal container={container}><Popover.Positioner className="sizing-field-positioner" side="bottom" align="end" sideOffset={4}><Popover.Popup className="sizing-field-popup" onKeyDown={move}>
        <div className="sizing-field-options" role="radiogroup" aria-label={label}>
          {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.selected} className="sizing-field-option" disabled={option.disabled} autoFocus={option.value === focusValue} onClick={() => choose(option)}><span>{option.label}</span>{option.selected && <Icon name="check" />}</button>)}
        </div>
      </Popover.Popup></Popover.Positioner></Popover.Portal>
    </Popover.Root>
  </div>
}
