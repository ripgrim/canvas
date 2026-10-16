import type { ReactNode } from 'react'
import { CompLogo } from './brand'
import './startup.css'

function StartupSpinner() {
  return <svg className="startup-spinner" viewBox="0 0 22 22" aria-hidden="true" fill="none" strokeWidth="var(--icon-stroke-width)" strokeLinecap="round"><circle className="startup-spinner-track" cx="11" cy="11" r="9" /><path className="startup-spinner-arc" d="M11 2a9 9 0 0 1 9 9" /></svg>
}

export function StartupRoot({ label, children }: { label: string; children: ReactNode }) {
  return <main className="startup-root" aria-label={label}>{children}</main>
}

export function StartupStatus({ title, detail, children }: { title: string; detail?: string | undefined; children?: ReactNode }) {
  return <div className="startup-status" role="status" aria-live="polite"><span className="startup-mark" aria-hidden="true"><CompLogo height={18} /><StartupSpinner /></span><span className="startup-title">{title}</span><span className="startup-detail" aria-hidden={!detail}>{detail ?? '\u00a0'}</span><span className="startup-actions">{children}</span></div>
}
