import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Dialog } from '@base-ui/react/dialog'
import { Button, Heading, Icon, Text } from './atoms'
import { PropertyHint } from './property-atoms'
import type { IconName } from './atoms'
import { floatingPortalContainer } from './floating-portal'
import './component-kit.css'

export function ComponentKitList({ label, children }: { label: string; children: ReactNode }) {
  return <div className="component-kit-list" role="list" aria-label={label}>{children}</div>
}

export function ComponentKitSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="component-kit-section" aria-label={title}><header className="component-kit-section-header"><Text roleName="muted">{title}</Text></header>{children}</section>
}

export function ComponentKitRow({ name, source, disabled = false, onInspect, onPlace, onOpen }: { name: string; source: string; disabled?: boolean; onInspect: { label: string; action: () => void }; onPlace: { label: string; action: () => void }; onOpen?: { label: string; action: () => void } }) {
  return <div className="component-kit-row" role="listitem"><button className="component-kit-row-main" type="button" aria-label={onInspect.label} onClick={onInspect.action}><span className="component-kit-glyph" aria-hidden="true"><Icon name="component" /></span><span className="component-kit-copy"><Text roleName="strong">{name}</Text><Text roleName="muted">{source}</Text></span></button><span className="component-kit-row-actions">{onOpen && <Button label={onOpen.label} variant="ghost" disabled={disabled} onClick={onOpen.action}><Icon name="target" /></Button>}<Button label={onPlace.label} variant="ghost" disabled={disabled} onClick={onPlace.action}><Icon name="plus" /></Button></span></div>
}

export function ComponentKitEmpty({ title, action }: { title: string; action?: ReactNode }) {
  return <div className="component-kit-empty" role="status"><span className="component-kit-empty-glyph" aria-hidden="true"><Icon name="component" /></span><Text roleName="strong">{title}</Text>{action}</div>
}

export function ComponentKitAction({ children }: { children: ReactNode }) {
  return <div className="component-kit-action">{children}</div>
}

export function ComponentRepositorySummary({ name, status }: { name: string; status: string }) {
  return <div className="component-repository-summary"><span className="component-kit-glyph" aria-hidden="true"><Icon name="folder" /></span><span className="component-kit-copy"><Text roleName="strong">{name}</Text><Text roleName="muted">{status}</Text></span></div>
}

export function ComponentRepositoryChoices({ label, children }: { label: string; children: ReactNode }) {
  return <div className="component-repository-choices" role="list" aria-label={label}>{children}</div>
}

export function ComponentRepositoryChoice({ name, disabled, onChoose }: { name: string; disabled?: boolean; onChoose: () => void }) {
  return <button className="component-repository-choice" type="button" role="listitem" disabled={disabled} onClick={onChoose}><span className="component-kit-glyph" aria-hidden="true"><Icon name="folder" /></span><Text roleName="strong">{name}</Text><Icon name="chevron" /></button>
}

export function ComponentRepositoryError({ message, action }: { message: string; action: ReactNode }) {
  return <div className="component-repository-error" role="alert"><Text roleName="muted">{message}</Text>{action}</div>
}

export function ComponentRepositoryPreview({ src, title }: { src: string; title: string }) {
  return <div className="component-repository-preview"><iframe src={src} title={title} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" /></div>
}

export function ComponentRepositoryReview({ title, detail, files, action }: { title: string; detail: string; files: readonly string[]; action?: ReactNode }) {
  return <section className="component-repository-review" aria-label={title}><span className="component-repository-review-header"><span className="component-kit-glyph" aria-hidden="true"><Icon name="file" /></span><span className="component-kit-copy"><Text roleName="strong">{title}</Text><Text roleName="muted">{detail}</Text></span>{action}</span><ul className="component-repository-review-files">{files.map(file => <li key={file}><Text roleName="data">{file}</Text></li>)}</ul></section>
}

export function ComponentRepositoryCommitLink({ href, label }: { href: string; label: string }) {
  return <a className="button button-ghost" href={href} target="_blank" rel="noreferrer">{label}</a>
}

export function ComponentDocsHeader({ name, source, description, backLabel, onBack }: { name: string; source: string; description?: string; backLabel: string; onBack: () => void }) {
  return <header className="component-docs-header"><Button label={backLabel} variant="ghost" onClick={onBack}><Icon name="back" /></Button><span className="component-kit-glyph" aria-hidden="true"><Icon name="component" /></span><span className="component-docs-copy"><Heading>{name}</Heading><Text roleName="muted">{source}</Text>{description && <Text roleName="body">{description}</Text>}</span></header>
}

export function ComponentDocsActions({ children }: { children: ReactNode }) {
  return <div className="component-docs-actions">{children}</div>
}

export function ComponentDocsPreview({ src, title, status, statusText, action, attach, onReady }: { src: string; title: string; status: 'connecting' | 'ready' | 'error'; statusText: string; action?: ReactNode; attach: (element: HTMLIFrameElement | null) => void; onReady: (element: HTMLIFrameElement) => void }) {
  return <div className="component-docs-preview" data-status={status}><iframe ref={attach} src={src} title={title} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" onLoad={event => onReady(event.currentTarget)} />{status !== 'ready' && <div className="component-docs-preview-status" role={status === 'error' ? 'alert' : 'status'}><Text roleName="muted">{statusText}</Text>{action}</div>}</div>
}

export function ComponentCombinationList({ label, children }: { label: string; children: ReactNode }) {
  return <div className="component-combination-list" role="list" aria-label={label}>{children}</div>
}

export function ComponentPlaygroundControl({ description, children }: { description?: string; children: ReactNode }) {
  return <div className="component-playground-control">{children}{description && <PropertyHint>{description}</PropertyHint>}</div>
}

export function ComponentCombinationRow({ summary, preview, action }: { summary: string; preview: { label: string; selected: boolean; onSelect: () => void }; action: ReactNode }) {
  return <div className="component-combination-row" role="listitem"><button className="component-combination-preview" type="button" aria-label={preview.label} aria-pressed={preview.selected} onClick={preview.onSelect}><Text>{summary}</Text></button>{action}</div>
}

export function ComponentUseRow({ name, detail, action }: { name: string; detail: string; action: ReactNode }) {
  return <div className="component-use-row" role="listitem"><span className="component-kit-glyph" aria-hidden="true"><Icon name="component" /></span><span className="component-kit-copy"><Text roleName="strong">{name}</Text><Text roleName="muted">{detail}</Text></span>{action}</div>
}

type ComponentMenuOption = Readonly<{ value: string; label: string; disabled?: boolean; reason?: string; icon?: IconName; group?: string }>

export function ComponentPropertyTypeMenu({ label, disabled = false, options, onSelect }: { label: string; disabled?: boolean; options: readonly ComponentMenuOption[]; onSelect: (value: string, target: EventTarget | null) => void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const groups = options.reduce<{ name?: string; options: ComponentMenuOption[] }[]>((result, option) => {
    const current = result.at(-1)
    if (!current || current.name !== option.group) result.push({ ...(option.group ? { name: option.group } : {}), options: [option] })
    else current.options.push(option)
    return result
  }, [])
  return <Popover.Root onOpenChange={open => { if (open) setContainer(floatingPortalContainer(trigger.current)) }}><Popover.Trigger ref={trigger} className="button button-ghost component-property-add" aria-label={label} title={label} disabled={disabled}><Icon name="plus" /></Popover.Trigger><Popover.Portal container={container}><Popover.Positioner className="component-property-menu-positioner" side="bottom" align="end" sideOffset={4}><Popover.Popup className="component-property-menu" role="menu" aria-label={label}>{groups.map((group, index) => <div key={`${group.name ?? 'options'}-${index}`} className="component-property-menu-group" role="group" {...(group.name ? { 'aria-label': group.name } : {})}>{group.name && <span className="component-property-menu-label" aria-hidden="true">{group.name}</span>}{group.options.map(option => <Popover.Close key={option.value} className="component-property-menu-item" role="menuitem" disabled={option.disabled} {...(option.reason ? { title: option.reason, 'aria-description': option.reason } : {})} onClick={event => { if (!option.disabled) onSelect(option.value, event.currentTarget) }}>{option.icon && <Icon name={option.icon} />}{option.label}</Popover.Close>)}</div>)}</Popover.Popup></Popover.Positioner></Popover.Portal></Popover.Root>
}

export function ComponentPropertyCard({ type, action, children }: { type: string; action: ReactNode; children: ReactNode }) {
  return <section className="component-property-card" aria-label={type}><div className="component-property-card-header"><Text roleName="muted">{type}</Text>{action}</div><div className="component-property-card-fields">{children}</div></section>
}

export function ComponentPropertyValueRow({ description, action, children }: { description?: string; action?: ReactNode; children: ReactNode }) {
  return <div className="component-property-value-row"><div className="component-property-value-field">{children}{description && <PropertyHint>{description}</PropertyHint>}</div>{action}</div>
}

export function ComponentDefinitionList({ children }: { children: ReactNode }) {
  return <div className="component-definition-list">{children}</div>
}

export function ComponentDefinitionGroup({ name, children }: { name: string; children: ReactNode }) {
  return <section className="component-definition-group" aria-label={name}><Text roleName="muted">{name}</Text><ComponentDefinitionList>{children}</ComponentDefinitionList></section>
}

export function ComponentDefinitionRow({ name, type, typeIcon, detail, controlLabel, control, editLabel, editText, disabled = false, onEdit }: { name: string; type: string; typeIcon?: IconName; detail?: string; controlLabel?: string; control?: ReactNode; editLabel: string; editText: string; disabled?: boolean; onEdit: (target: EventTarget | null) => void }) {
  return <div className="component-definition-row"><span className="component-definition-copy"><Text roleName="strong">{name}</Text><span className="component-definition-type">{typeIcon && <Icon name={typeIcon} />}<Text roleName="muted">{type}</Text></span>{detail && <Text roleName="body">{detail}</Text>}</span>{control && <span className="component-definition-control">{controlLabel && <Text roleName="muted">{controlLabel}</Text>}{control}</span>}<Button label={editLabel} variant="ghost" disabled={disabled} onClick={event => onEdit(event.currentTarget)}>{editText}</Button></div>
}

export function ComponentAuthoringDialog({ open, container, title, closeLabel, saveLabel, leadingAction, saveDisabled = false, onOpenChange, onSave, children }: { open: boolean; container: HTMLElement | null; title: string; closeLabel: string; saveLabel: string; leadingAction?: ReactNode; saveDisabled?: boolean; onOpenChange: (open: boolean) => void; onSave: () => void; children: ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal container={container}><Dialog.Backdrop className="component-authoring-backdrop" /><Dialog.Popup className="component-authoring-dialog" aria-describedby={undefined}><header className="component-authoring-header"><Dialog.Title className="component-authoring-title">{title}</Dialog.Title><Dialog.Close className="button button-ghost component-authoring-close" aria-label={closeLabel} title={closeLabel}><Icon name="close" /></Dialog.Close></header><div className="component-authoring-body">{children}</div><footer className="component-authoring-actions">{leadingAction && <span className="component-authoring-leading-action">{leadingAction}</span>}<Dialog.Close className="button button-ghost">{closeLabel}</Dialog.Close><Button variant="primary" disabled={saveDisabled} onClick={onSave}>{saveLabel}</Button></footer></Dialog.Popup></Dialog.Portal></Dialog.Root>
}

export function ComponentAuthoringSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="component-authoring-section" aria-label={title}><header className="component-authoring-section-header"><Text roleName="strong">{title}</Text>{action}</header>{children}</section>
}

export function ComponentOptionList({ children }: { children: ReactNode }) {
  return <div className="component-option-list">{children}</div>
}

export function ComponentOptionRow({ action, children }: { action: ReactNode; children: ReactNode }) {
  return <div className="component-option-row"><div className="component-option-field">{children}</div>{action}</div>
}

export function ComponentAuthoringError({ children }: { children: ReactNode }) {
  return <div className="component-authoring-error" role="alert">{children}</div>
}
