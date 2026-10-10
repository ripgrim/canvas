import { ScrollArea } from '@base-ui/react/scroll-area'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import './repository.css'

function scrollRepositoryList(event: KeyboardEvent<HTMLDivElement>) {
  const viewport = event.currentTarget
  const distances: Partial<Record<string, number>> = {
    ArrowDown: 36,
    ArrowUp: -36,
    PageDown: viewport.clientHeight,
    PageUp: -viewport.clientHeight,
  }
  const distance = distances[event.key]
  if (distance !== undefined) {
    event.preventDefault()
    viewport.scrollBy({ top: distance })
    return
  }
  if (event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  viewport.scrollTo({ top: event.key === 'Home' ? 0 : viewport.scrollHeight })
}

export function RepositoryScrollArea({ label, header, action, children }: { label: string; header?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return <ScrollArea.Root className="repository-scroll-area" data-has-action={action ? true : undefined}>
    {header}
    <ScrollArea.Viewport className="repository-scroll-viewport" aria-label={label} tabIndex={0} onKeyDown={scrollRepositoryList}>
      <ScrollArea.Content className="repository-scroll-content">{children}</ScrollArea.Content>
    </ScrollArea.Viewport>
    <ScrollArea.Scrollbar className="repository-scrollbar" orientation="vertical" keepMounted>
      <ScrollArea.Thumb className="repository-scroll-thumb" />
    </ScrollArea.Scrollbar>
    {action}
  </ScrollArea.Root>
}

export function RepositoryList({ label, header, action, children, scrollable = false }: { label: string; header?: ReactNode; action?: ReactNode; children: ReactNode; scrollable?: boolean }) {
  const list = <div className="repository-list" role="list" aria-label={label}>{children}</div>
  if (scrollable) return <RepositoryScrollArea label={label} header={header} action={action}>{list}</RepositoryScrollArea>
  return header || action ? <div className="repository-list-static">{header}{list}{action}</div> : list
}
export function RepositoryRow({ selected, kind = 'token', onSelect, children }: { selected?: boolean; kind?: 'token' | 'component'; onSelect?: ((range: boolean) => void) | undefined; children: ReactNode }) {
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onSelect || !(event.target instanceof Element) || event.target.closest('button, input, a, [role="button"]')) return
    onSelect(event.shiftKey)
  }
  return <div className="repository-row" role="listitem" data-kind={kind} data-selected={selected || undefined} data-selectable={onSelect ? true : undefined} onClick={onClick}>{children}</div>
}
export function RepositorySelect({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean, range: boolean) => void }) { return <input className="repository-select" type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked, 'shiftKey' in event.nativeEvent && event.nativeEvent.shiftKey === true)} /> }
export function RepositorySelectionToggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) { return <label className="repository-selection-toggle"><input className="repository-select" type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} /><span>{label}</span></label> }
export function RepositoryMark({ children }: { children: ReactNode }) { return <span className="repository-mark" aria-hidden="true">{children}</span> }
export function RepositoryRowBody({ name, detail }: { name: string; detail: string }) { return <span className="repository-row-body"><span className="repository-row-name" title={name}>{name}</span><span className="repository-row-detail" title={detail}>{detail}</span></span> }
export function RepositoryRowAction({ children }: { children: ReactNode }) { return <span className="repository-row-action">{children}</span> }
export function RepositoryBulkBar({ children }: { children: ReactNode }) { return <div className="repository-bulk-bar" role="toolbar">{children}</div> }
export function RepositorySummary({ children }: { children: ReactNode }) { return <div className="repository-summary">{children}</div> }
export function RepositoryDiagnosticList({ children }: { children: ReactNode }) { return <div className="repository-diagnostics" role="list">{children}</div> }
export function RepositoryDiagnostic({ name, count, detail }: { name: string; count: number; detail: string }) { return <div className="repository-diagnostic" role="listitem"><span className="repository-diagnostic-name">{name}</span><span className="repository-diagnostic-count">{count}</span><span className="repository-row-detail">{detail}</span></div> }
