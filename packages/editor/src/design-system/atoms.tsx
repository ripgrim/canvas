import type { ComponentProps, CSSProperties, HTMLAttributes, InputHTMLAttributes, KeyboardEventHandler, ReactNode } from 'react'
import { Button as BaseButton } from '@base-ui/react/button'
import { Dialog } from '@base-ui/react/dialog'
import { Tabs } from '@base-ui/react/tabs'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Radio } from '@base-ui/react/radio'

type LayoutProps = HTMLAttributes<HTMLDivElement> & { roleName?: string }
export function Layout({ roleName = 'stack', className, ...props }: LayoutProps) { return <div className={[roleName, className].filter(Boolean).join(' ')} {...props} /> }
export function Surface({ children, label, roleName = 'panel' }: { children: ReactNode; label?: string; roleName?: string }) { return <section className={roleName} aria-label={label}>{children}</section> }
export function Text({ children, roleName = 'body' }: { children: ReactNode; roleName?: string }) { return <span className={`text text-${roleName}`}>{children}</span> }
export function Heading({ children }: { children: ReactNode }) { return <h2 className="heading">{children}</h2> }
export function Button({ children, label, variant = 'ghost', active, ...props }: ComponentProps<typeof BaseButton> & { label?: string; variant?: 'ghost' | 'primary' | 'outline' | 'secondary'; active?: boolean | undefined }) { return <BaseButton {...props} className={`button button-${variant}`} aria-label={label} title={props.title ?? label ?? (typeof children === 'string' ? children : undefined)} data-active={active || undefined}>{children}</BaseButton> }
export function Input({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) { return <input className="input" aria-label={label} {...props} /> }
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor: string }) { return <label className="field-label" htmlFor={htmlFor}>{children}</label> }
export function Check({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: (checked: boolean) => void; disabled?: boolean }) { return <label className="check"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label> }
const iconPaths = {
  scale: <><path d="M9 4H4v14h14v-5" /><path d="M13 4h5v5M18 4l-7 7" /></>, hand: <path d="M6 11V6m3 4V4m3 6V5m3 7V8c4 1 2 9-3 10H9c-2 0-5-5-5-7 0-1 1-2 2 0Z" />, shader: <><rect x="3" y="3" width="16" height="16" rx="4" /><path d="M6.5 9c1.5-1.5 3 1.5 4.5 0s3-1.5 4.5 0M6.5 13.5c1.5-1.5 3 1.5 4.5 0s3-1.5 4.5 0" /></>, rectangle: <rect x="3.5" y="5.5" width="15" height="11" rx="1.5" />, shape: <rect x="4" y="4" width="14" height="14" rx="2" />, pen: <path d="m4 18 3-8 7-7 5 5-7 7-8 3Zm3-8 5 5M14 3l5 5" />, media: <><rect x="3" y="4" width="16" height="14" rx="2" /><path d="m3 15 5-5 4 4 3-3 4 4" /></>, layers: <><path d="m3 8 8-5 8 5-8 5Z" /><path d="m3 12 8 5 8-5M3 16l8 5 8-5" /></>, back: <path d="m13 5-6 6 6 6" />, plus: <path d="M11 4v14M4 11h14" />, sun: <><circle cx="11" cy="11" r="4" /><path d="M11 1v2M11 19v2M1 11h2M19 11h2M4 4l2 2M16 16l2 2M18 4l-2 2M6 16l-2 2" /></>, moon: <path d="M18 14A8 8 0 0 1 8 3a8 8 0 1 0 10 11Z" />, code: <path d="m7 6-5 5 5 5m8-10 5 5-5 5M13 3l-4 16" />, chevron: <path d="m8 6 5 5-5 5" />, refresh: <path d="M18 8a8 8 0 1 0 1 7M18 3v5h-5" />, grid: <><rect x="3" y="3" width="16" height="16" rx="1" /><path d="M3 11h16M11 3v16" /></>, search: <><circle cx="9" cy="9" r="5" /><path d="m13 13 6 6" /></>, lock: <><rect x="5" y="9" width="12" height="10" rx="2" /><path d="M7 9V6a4 4 0 0 1 8 0v3" /></>, close: <path d="m5 5 12 12M17 5 5 17" />, minus: <path d="M4 11h14" />, undo: <path d="M8 5 4 9l4 4M4 9h9a5 5 0 0 1 0 10h-3" />, redo: <path d="m14 5 4 4-4 4m4-4H9a5 5 0 0 0 0 10h3" />, file: <><path d="M5 2h8l4 4v14H5Z" /><path d="M13 2v4h4" /></>, folder: <path d="M2 5h7l2 2h9v11H2Z" />, check: <path d="m4 11 5 5 9-10" />, alert: <><path d="M11 3 2 19h18Z" /><path d="M11 9v4M11 16v.5" /></>,
  selection: <><rect x="3" y="3" width="10" height="10" rx="1.5" /><path d="M9 17v2h10V9h-2" /></>, eye: <><path d="M2 11s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" /><circle cx="11" cy="11" r="2.5" /></>,
} satisfies Record<string, ReactNode>

const filledPaths = {
  move: <path d="M5.6 3.3 18.7 9.7a.7.7 0 0 1-.1 1.3l-5.7 1.8-2.6 5.8a.7.7 0 0 1-1.3-.1L5 4a.6.6 0 0 1 .6-.7Z" />,
  frame: <path d="M3 3h6.5v2.2H5.2v4.3H3Zm11.5 0H21v6.5h-2.2V5.2h-4.3ZM18.8 14.5H21V21h-6.5v-2.2h4.3ZM3 14.5h2.2v4.3h4.3V21H3Z" />,
  text: <path d="M4.5 4h15v4.2h-1.9l-.6-2.1h-3.8v12h2.3V20H8.5v-1.9h2.3v-12H7l-.6 2.1H4.5Z" />,
  component: <path d="m12 2.2 3.8 3.8-3.8 3.8L8.2 6Zm0 12 3.8 3.8-3.8 3.8L8.2 18ZM2.2 12 6 8.2 9.8 12 6 15.8Zm12 0L18 8.2l3.8 3.8-3.8 3.8Z" />,
  'flex-column': <path d="M5.5 4h13A1.5 1.5 0 0 1 20 5.5v4A1.5 1.5 0 0 1 18.5 11h-13A1.5 1.5 0 0 1 4 9.5v-4A1.5 1.5 0 0 1 5.5 4Zm0 9h13a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-4A1.5 1.5 0 0 1 5.5 13Z" />,
  'flex-row': <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h5A1.5 1.5 0 0 1 12 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 18.5Zm10 2A1.5 1.5 0 0 1 15.5 6h3A1.5 1.5 0 0 1 20 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5Z" />,
  freeform: <path d="M4.5 4h6A1.5 1.5 0 0 1 12 5.5v4A1.5 1.5 0 0 1 10.5 11h-6A1.5 1.5 0 0 1 3 9.5v-4A1.5 1.5 0 0 1 4.5 4Zm9 8h6a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-6a1.5 1.5 0 0 1-1.5-1.5v-5a1.5 1.5 0 0 1 1.5-1.5Z" />,
  block: <path d="M5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11A1.5 1.5 0 0 1 5.5 5Z" />,
  'display-grid': <path d="M5 4h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm9 0h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM5 13h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Zm9 0h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof iconPaths | keyof typeof filledPaths

export function Icon({ name }: { name: IconName }) {
  if (name in filledPaths) return <svg viewBox="0 0 24 24" className="icon" data-icon-style="filled" aria-hidden="true" fill="currentColor" stroke="none">{filledPaths[name as keyof typeof filledPaths]}</svg>
  return <svg viewBox="0 0 22 22" className="icon" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="var(--icon-stroke-width)" strokeLinecap="round" strokeLinejoin="round">{iconPaths[name as keyof typeof iconPaths]}</svg>
}
export function CodeBlock({ value }: { value: string }) { return <pre className="code-block"><code>{value}</code></pre> }
export function Disclosure({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) { return <details className="disclosure" open={open}><summary><Icon name="chevron" />{title}</summary><div className="disclosure-content">{children}</div></details> }
export function PreviewFrame({ src, title, zoom, onReady, onError }: { src: string; title: string; zoom: number; onReady: (target: Window | null) => void; onError: () => void }) { return <iframe title={title} src={src} className="preview-frame" sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" style={{ transform: `scale(${zoom / 100})` }} onLoad={event => onReady(event.currentTarget.contentWindow)} onError={onError} /> }
export function Popup({ open, onOpenChange, title, children, mode, closeLabel }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; mode: string; closeLabel: string }) { return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Backdrop className={`theme-${mode} dialog-backdrop`} /><Dialog.Popup className={`theme-${mode} dialog-popup`}><Dialog.Title className="heading">{title}</Dialog.Title>{children}<Dialog.Close className="button button-outline">{closeLabel}</Dialog.Close></Dialog.Popup></Dialog.Portal></Dialog.Root> }
export function ThemeRoot({ mode, children, onKeyDown, onKeyUp, label }: { mode: string; children: ReactNode; onKeyDown: KeyboardEventHandler<HTMLDivElement>; onKeyUp?: KeyboardEventHandler<HTMLDivElement>; label: string }) { return <div className={`theme-${mode} editor-root`} role="group" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown} onKeyUp={onKeyUp}>{children}</div> }
export function ColorSwatch({ color }: { color: string }) { return <span className="color-swatch" style={{ background: color } as CSSProperties} /> }
export function SourceTabs({ value, onChange, panes }: { value: string; onChange: (value: string) => void; panes: { value: string; content: ReactNode }[] }) { return <Tabs.Root value={value} onValueChange={next => { if (typeof next === 'string') onChange(next) }}><Tabs.List className="tabs">{panes.map(pane => <Tabs.Tab className="source-tab" key={pane.value} value={pane.value}>{pane.value}</Tabs.Tab>)}</Tabs.List>{panes.map(pane => <Tabs.Panel key={pane.value} value={pane.value}>{pane.content}</Tabs.Panel>)}</Tabs.Root> }
export function ScopePicker<T extends string>({ label, value, values, onChange, disabled }: { label: string; value: T; values: readonly T[]; onChange: (value: T) => void; disabled: boolean }) { return <RadioGroup className="scope-options" aria-label={label} value={value} onValueChange={onChange} disabled={disabled}>{values.map(option => <Radio.Root className="button button-ghost scope-radio" key={option} value={option} aria-label={option}>{option}</Radio.Root>)}</RadioGroup> }
export function LayerTree({ label, children }: { label: string; children: ReactNode }) {
  const onKeyDown: KeyboardEventHandler<HTMLDivElement> = event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    const current = items.indexOf(event.target as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    items[next]?.focus()
  }
  return <div className="component-list" role="tree" aria-label={label} onKeyDown={onKeyDown}>{children}</div>
}
