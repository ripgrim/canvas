import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import fixtureMark from '@/assets/stateful-mark.svg'
import { usePreviewBrand } from '@/preview/context'

type DialogProps = Readonly<{
  children?: ReactNode
  content?: ReactNode
  defaultOpen?: boolean
  variant?: 'default' | 'danger'
}>

export function Dialog({
  children = 'Open dialog',
  content = 'Stateful dialog content',
  defaultOpen = true,
  variant = 'default',
}: DialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const trigger = useRef<HTMLButtonElement>(null)
  const brand = usePreviewBrand()

  const close = () => {
    setUncontrolledOpen(false)
    trigger.current?.focus()
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  return (
    <>
      <button
        ref={trigger}
        className="stateful-dialog-trigger"
        data-provider-brand={brand}
        data-testid="dialog-trigger"
        type="button"
        onClick={() => setUncontrolledOpen(true)}
      >
        {children}
      </button>
      {uncontrolledOpen ? createPortal(
        <div className="stateful-dialog-portal" data-testid="dialog-portal">
          <div className="stateful-dialog-backdrop" aria-hidden="true" />
          <div
            aria-labelledby="stateful-dialog-title"
            className="stateful-dialog-panel"
            data-provider-brand={brand}
            data-testid="dialog-panel"
            data-variant={variant}
            onKeyDown={handleKeyDown}
            role="dialog"
          >
            <img alt="Fixture mark" className="stateful-dialog-mark" src={fixtureMark} />
            <h2 id="stateful-dialog-title">{brand}</h2>
            <div data-testid="dialog-content">{content}</div>
            <button autoFocus className="stateful-dialog-close" data-testid="dialog-close" type="button" onClick={close}>
              Close
            </button>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  )
}
