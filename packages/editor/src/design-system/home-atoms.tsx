import type { KeyboardEventHandler, ReactNode } from 'react'
import { Icon } from './atoms'
import { CompLogo } from './brand'
import './home.css'

function Spinner() { return <svg className="home-spinner" viewBox="0 0 22 22" aria-hidden="true" fill="none" strokeWidth="var(--icon-stroke-width)" strokeLinecap="round"><circle className="home-spinner-track" cx="11" cy="11" r="9" /><path className="home-spinner-arc" d="M11 2a9 9 0 0 1 9 9" /></svg> }

export type HomePhaseState = 'active' | 'done'
export type HomeViewMode = 'grid' | 'list'

export function HomeRoot({ mode, label, onKeyDown, children }: { mode: 'light' | 'dark'; label: string; onKeyDown?: KeyboardEventHandler<HTMLElement>; children: ReactNode }) {
  return <main className={`theme-${mode} home-root`} aria-label={label} onKeyDown={onKeyDown}>{children}</main>
}

export function HomeSidebar({ accountName, search, current, footer }: { accountName: string; search: ReactNode; current: string; footer?: ReactNode }) {
  const initial = accountName.trim().charAt(0).toLocaleUpperCase() || 'C'
  return <aside className="home-sidebar"><div className="home-account"><span className="home-account-avatar" aria-hidden="true">{initial}</span><span className="home-account-name">{accountName}</span></div>{search}<nav className="home-nav" aria-label="Home"><span className="home-nav-item" aria-current="page"><Icon name="file" />{current}</span></nav><span className="home-sidebar-spacer" />{footer && <footer className="home-sidebar-footer">{footer}</footer>}</aside>
}

export function HomeMain({ children }: { children: ReactNode }) { return <div className="home-main">{children}</div> }

export function HomeToolbar({ title, actions }: { title: string; actions: ReactNode }) { return <header className="home-toolbar"><div className="home-toolbar-inner"><h1 className="home-title">{title}</h1><span className="home-toolbar-actions">{actions}</span></div></header> }

export function HomeContent({ children }: { children: ReactNode }) { return <div className="home-content">{children}</div> }

export function HomeSection({ title, children }: { title: string; children: ReactNode }) { return <section className="home-section" aria-label={title}>{children}</section> }

export function HomeSearch({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return <label className="home-search" htmlFor={id}><Icon name="search" /><input id={id} className="home-search-input" type="search" placeholder={label} aria-label={label} aria-keyshortcuts="Control+K Meta+K" value={value} onChange={event => onChange(event.currentTarget.value)} /></label>
}

export function HomeViewSwitch({ value, gridLabel, listLabel, onChange }: { value: HomeViewMode; gridLabel: string; listLabel: string; onChange: (value: HomeViewMode) => void }) {
  return <span className="home-view-switch" role="group" aria-label="View"><button type="button" className="home-view-button" aria-label={gridLabel} aria-pressed={value === 'grid'} onClick={() => onChange('grid')}><Icon name="grid" /></button><button type="button" className="home-view-button" aria-label={listLabel} aria-pressed={value === 'list'} onClick={() => onChange('list')}><Icon name="list" /></button></span>
}

export function HomeFileGrid({ label, mode, children }: { label: string; mode: HomeViewMode; children: ReactNode }) { return <ul className="home-file-grid" data-view={mode} aria-label={label}>{children}</ul> }

export function HomeFileCard({ name, meta, thumbnailUrl, openLabel, disabled, busy, onOpen }: { name: string; meta?: string | undefined; thumbnailUrl?: string | undefined; openLabel: string; disabled?: boolean; busy?: boolean; onOpen: () => void }) {
  return <li className="home-file-item"><button type="button" className="home-file-card" aria-label={openLabel} aria-busy={busy || undefined} disabled={disabled} onClick={onOpen}><span className="home-file-text"><span className="home-file-name">{name}</span>{meta && <span className="home-file-meta">{meta}</span>}</span><span className="home-file-thumbnail" aria-hidden="true">{thumbnailUrl && <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" />}</span></button></li>
}

export function HomeEmpty({ title, action }: { title: string; action?: ReactNode }) { return <div className="home-empty"><span className="home-empty-title">{title}</span>{action}</div> }

export function HomeNote({ children }: { children: ReactNode }) { return <p className="home-note">{children}</p> }

export function HomeStatusScreen({ title, detail, children }: { title: string; detail?: string | undefined; children?: ReactNode }) {
  return <div className="home-status-screen" role="status" aria-live="polite"><span className="home-status-glyph" aria-hidden="true"><CompLogo height={18} /><Spinner /></span><span className="home-status-title">{title}</span>{detail && <span className="home-status-detail">{detail}</span>}{children}</div>
}

export function HomePhaseList({ label, phases }: { label: string; phases: readonly { name: string; state: HomePhaseState; detail?: string | undefined }[] }) {
  return <ol className="home-phase-list" aria-label={label}>{phases.map(phase => <li key={phase.name} className="home-phase" data-state={phase.state}><span className="home-phase-mark" aria-hidden="true">{phase.state === 'done' ? <Icon name="check" /> : <Spinner />}</span><span className="home-phase-name">{phase.name}</span>{phase.detail && <span className="home-phase-detail">{phase.detail}</span>}</li>)}</ol>
}

export function HomeErrorPanel({ title, body, reference, actions }: { title: string; body: string; reference?: string; actions: ReactNode }) {
  return <div className="home-error" role="alert"><span className="home-error-glyph" aria-hidden="true"><Icon name="alert" /></span><span className="home-error-title">{title}</span><span className="home-error-body">{body}</span>{reference && <span className="home-error-reference">{reference}</span>}<span className="home-error-actions">{actions}</span></div>
}
