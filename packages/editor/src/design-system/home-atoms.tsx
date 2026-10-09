import type { KeyboardEventHandler, ReactNode } from 'react'
import { Icon } from './atoms'
import { CompCanvasWordmark, CompLogo } from './brand'
import './home.css'

function Spinner() { return <svg className="home-spinner" viewBox="0 0 22 22" aria-hidden="true" fill="none" strokeWidth="var(--icon-stroke-width)" strokeLinecap="round"><circle className="home-spinner-track" cx="11" cy="11" r="9" /><path className="home-spinner-arc" d="M11 2a9 9 0 0 1 9 9" /></svg> }

export type HomePhaseState = 'active' | 'done'

export function HomeRoot({ mode, label, onKeyDown, children }: { mode: 'light' | 'dark'; label: string; onKeyDown?: KeyboardEventHandler<HTMLElement>; children: ReactNode }) {
  return <main className={`theme-${mode} home-root`} aria-label={label} onKeyDown={onKeyDown}>{children}</main>
}

export function HomeHeader({ children }: { children: ReactNode }) { return <header className="home-header">{children}</header> }

/** Product wordmark: the Comp mark followed by "canvas"; `name` is the accessible product name. */
export function HomeBrand({ name }: { name: string }) { return <span className="home-brand"><CompCanvasWordmark height={20} label={name} /></span> }

export function HomeHeaderActions({ children }: { children: ReactNode }) { return <span className="home-header-actions">{children}</span> }

export function HomeContent({ children }: { children: ReactNode }) { return <div className="home-content">{children}</div> }

export function HomeSection({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="home-section" aria-label={title}><div className="home-section-header"><h2 className="home-section-title">{title}</h2>{actions && <span className="home-section-actions">{actions}</span>}</div>{children}</section>
}

export function HomeSearch({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return <label className="home-search" htmlFor={id}><Icon name="search" /><input id={id} className="home-search-input" type="search" placeholder={label} aria-label={label} aria-keyshortcuts="Control+K Meta+K" value={value} onChange={event => onChange(event.currentTarget.value)} /></label>
}

export function HomeFileGrid({ label, children }: { label: string; children: ReactNode }) { return <ul className="home-file-grid" aria-label={label}>{children}</ul> }

export function HomeFileCard({ name, detail, meta, openLabel, disabled, busy, onOpen }: { name: string; detail: string; meta?: string | undefined; openLabel: string; disabled?: boolean; busy?: boolean; onOpen: () => void }) {
  return <li className="home-file-item"><button type="button" className="home-file-card" aria-label={openLabel} aria-busy={busy || undefined} disabled={disabled} onClick={onOpen}><span className="home-file-tile" aria-hidden="true"><Icon name="file" /></span><span className="home-file-text"><span className="home-file-name">{name}</span><span className="home-file-detail">{detail}</span>{meta && <span className="home-file-meta">{meta}</span>}</span></button></li>
}

export function HomeEmpty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="home-empty"><span className="home-empty-glyph" aria-hidden="true"><Icon name="folder" /></span><span className="home-empty-title">{title}</span><span className="home-empty-body">{body}</span>{action}</div>
}

export function HomeNote({ children }: { children: ReactNode }) { return <p className="home-note">{children}</p> }

export function HomeStatusScreen({ title, detail, children }: { title: string; detail?: string | undefined; children?: ReactNode }) {
  return <div className="home-status-screen" role="status" aria-live="polite"><span className="home-status-glyph" aria-hidden="true"><CompLogo height={18} /><Spinner /></span><span className="home-status-title">{title}</span>{detail && <span className="home-status-detail">{detail}</span>}{children}</div>
}

export function HomePhaseList({ label, phases }: { label: string; phases: readonly { name: string; state: HomePhaseState; detail?: string | undefined }[] }) {
  return <ol className="home-phase-list" aria-label={label}>{phases.map(phase => <li key={phase.name} className="home-phase" data-state={phase.state}><span className="home-phase-mark" aria-hidden="true">{phase.state === 'done' ? <Icon name="check" /> : <Spinner />}</span><span className="home-phase-name">{phase.name}</span>{phase.detail && <span className="home-phase-detail">{phase.detail}</span>}</li>)}</ol>
}

export function HomeErrorPanel({ title, body, actions }: { title: string; body: string; actions: ReactNode }) {
  return <div className="home-error" role="alert"><span className="home-error-glyph" aria-hidden="true"><Icon name="alert" /></span><span className="home-error-title">{title}</span><span className="home-error-body">{body}</span><span className="home-error-actions">{actions}</span></div>
}
