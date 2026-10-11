import { useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Tooltip } from '@base-ui/react/tooltip'
import { Icon } from './atoms'
import { AppearanceFieldGlyph } from './appearance-atoms'
import './collaboration.css'

type CollaborationStyle = CSSProperties & { '--collaboration-color': string; '--collaboration-foreground': string }

function CollaborationTooltip({ label, children }: { label: string; children: ReactElement }) {
  const trigger = useRef<HTMLButtonElement | null>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  return <Tooltip.Root onOpenChange={open => { if (open) setContainer(trigger.current?.closest<HTMLElement>('.editor-root') ?? null) }}><Tooltip.Trigger ref={trigger} render={children} delay={300} closeOnClick /><Tooltip.Portal container={container}><Tooltip.Positioner side="bottom" sideOffset={4}><Tooltip.Popup className="collaboration-tooltip">{label}</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal></Tooltip.Root>
}

function CollaborationAnonymousGlyph() {
  return <svg className="collaboration-anonymous-glyph" aria-hidden="true" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5.5" r="2.5" /><path d="M3.5 14c.4-3 2-4.5 4.5-4.5s4.1 1.5 4.5 4.5" /></svg>
}

export function CollaborationAvatar({ name, image, color, foreground, local, anonymous = false, decorative = false, onSelect }: { name: string; image: string | null; color: string; foreground: string; local: boolean; anonymous?: boolean; decorative?: boolean; onSelect?: () => void }) {
  const label = local ? `${name} (you)` : name
  const content = image ? <img src={image} alt="" referrerPolicy="no-referrer" /> : anonymous ? <CollaborationAnonymousGlyph /> : <span aria-hidden="true">{name.trim().charAt(0).toUpperCase() || '?'}</span>
  const style = { '--collaboration-color': color, '--collaboration-foreground': foreground } as CollaborationStyle
  if (decorative) return <span className="collaboration-avatar" style={style} aria-hidden="true">{content}</span>
  const avatar = onSelect
    ? <button type="button" className="collaboration-avatar collaboration-avatar-action" style={style} aria-label={label} onClick={onSelect}>{content}</button>
    : <span className="collaboration-avatar" style={style} role="img" aria-label={label} tabIndex={0}>{content}</span>
  return <CollaborationTooltip label={label}>{avatar}</CollaborationTooltip>
}

function CollaborationAgentGlyph({ known, label }: { known: boolean; label: string }) {
  if (known) return <span className="collaboration-agent-letter" aria-hidden="true">{label.trim().charAt(0).toUpperCase() || '?'}</span>
  return <svg className="collaboration-agent-robot" aria-hidden="true" viewBox="0 0 14 14" fill="none"><rect x="2" y="3.5" width="10" height="8" rx="2" /><path d="M7 1.5v2M4.5 7h.01M9.5 7h.01M5 9h4" /></svg>
}

export function CollaborationAgentAvatar({ name, harness, color, foreground, local, decorative = false }: { name: string; harness: string; color: string; foreground: string; local: boolean; decorative?: boolean }) {
  const known = harness.trim().length > 0 && harness.trim().toLowerCase() !== 'unknown'
  const profile = name.trim() && name.trim() !== harness.trim() ? `, ${name.trim()}` : ''
  const label = `${harness.trim() || name.trim() || 'Agent'}${profile}${local ? ' (you)' : ''}`
  const avatar = <span className="collaboration-avatar collaboration-agent-avatar" style={{ '--collaboration-color': color, '--collaboration-foreground': foreground } as CollaborationStyle} {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label, tabIndex: 0 })}><CollaborationAgentGlyph known={known} label={harness || name} /></span>
  return decorative ? avatar : <CollaborationTooltip label={label}>{avatar}</CollaborationTooltip>
}

export function CollaborationOverflow({ count, label, children }: { count: number; label: string; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement | null>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const overflow = <Popover.Trigger ref={trigger} className="collaboration-overflow" aria-label={label}><span>{count}</span></Popover.Trigger>
  return <Popover.Root onOpenChange={open => { if (open) setContainer(trigger.current?.closest<HTMLElement>('.editor-root') ?? null) }}><CollaborationTooltip label={label}>{overflow}</CollaborationTooltip><Popover.Portal container={container}><Popover.Positioner className="collaboration-roster-positioner" side="bottom" align="end" sideOffset={4}><Popover.Popup className="collaboration-roster" aria-label={label}><ul>{children}</ul></Popover.Popup></Popover.Positioner></Popover.Portal></Popover.Root>
}

export function CollaborationRosterItem({ name, image, color, foreground, anonymous = false, onSelect }: { name: string; image: string | null; color: string; foreground: string; anonymous?: boolean; onSelect: () => void }) {
  return <li><Popover.Close className="collaboration-roster-item" onClick={onSelect}><CollaborationAvatar name={name} image={image} color={color} foreground={foreground} local={false} anonymous={anonymous} decorative /><span>{name}</span></Popover.Close></li>
}

export function CollaborationAgentRosterItem({ name, harness, color, foreground, local }: { name: string; harness: string; color: string; foreground: string; local: boolean }) {
  return <li className="collaboration-roster-item collaboration-roster-agent"><CollaborationAgentAvatar name={name} harness={harness} color={color} foreground={foreground} local={local} decorative /><span><strong>{name}</strong><small>{harness}</small></span></li>
}

export function CollaborationStrip({ label, floating = false, children }: { label: string; floating?: boolean; children: ReactNode }) { return <div className="collaboration-strip" data-floating={floating || undefined} role="group" aria-label={label}>{children}</div> }

export function CollaborationCursor({ name, color, foreground, x, y, focused, snap }: { name: string; color: string; foreground: string; x: number; y: number; focused: boolean; snap: boolean }) {
  return <span className="collaboration-cursor" data-focused={focused || undefined} data-snap={snap || undefined} style={{ left: x, top: y, '--collaboration-color': color, '--collaboration-foreground': foreground } as CollaborationStyle} aria-hidden="true"><span className="collaboration-cursor-dot" /><span className="collaboration-cursor-name"><span className="collaboration-cursor-name-text">{name}</span>{!focused && <span className="collaboration-cursor-blurred"><AppearanceFieldGlyph name="eye-off" /></span>}</span></span>
}

export function CollaborationSelection({ color, foreground, x, y, width, height, focused }: { color: string; foreground: string; x: number; y: number; width: number; height: number; focused: boolean }) {
  return <span className="collaboration-selection" data-focused={focused || undefined} style={{ left: x, top: y, width, height, '--collaboration-color': color, '--collaboration-foreground': foreground } as CollaborationStyle} aria-hidden="true" />
}

export function CollaborationFollowFrame({ label, stopLabel, color, foreground, onStop }: { label: string; stopLabel: string; color: string; foreground: string; onStop: () => void }) {
  return <div className="collaboration-follow-frame" style={{ '--collaboration-color': color, '--collaboration-foreground': foreground } as CollaborationStyle} role="region" aria-label={label}><button type="button" className="collaboration-follow-pill" onClick={onStop}><span>{label}</span><span className="collaboration-follow-stop">{stopLabel}</span></button></div>
}

export function CollaborationReadOnlyBanner({ title, body, dismissLabel, onDismiss }: { title: string; body: string; dismissLabel: string; onDismiss: () => void }) {
  return <aside className="collaboration-read-only" aria-label={title}><span className="collaboration-read-only-eye"><Icon name="eye" /></span><span className="collaboration-read-only-copy"><strong>{title}</strong><span>{body}</span></span><button type="button" aria-label={dismissLabel} onClick={onDismiss}><Icon name="close" /></button></aside>
}

export function CollaborationStatusSurface({ label, tone, action }: { label: string; tone: 'progress' | 'danger'; action?: Readonly<{ label: string; onSelect: () => void }> }) {
  return <section className="collaboration-status" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'} aria-live={tone === 'danger' ? 'assertive' : 'polite'} aria-label={label}>
    <span className="collaboration-status-mark" aria-hidden="true" />
    <strong>{label}</strong>
    {action && <button type="button" onClick={action.onSelect}>{action.label}</button>}
  </section>
}
