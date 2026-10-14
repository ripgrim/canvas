import type { ReactNode } from 'react'
import { Button } from './atoms'
import { CompLogo } from './brand'
import './auth.css'

export function AuthRoot({ label, children }: { label: string; children: ReactNode }) {
  return <main className="theme-dark auth-root" aria-label={label}>{children}</main>
}

export function AuthCenter({ children }: { children: ReactNode }) { return <div className="auth-center">{children}</div> }

export function AuthBrand({ label }: { label: string }) { return <span className="auth-brand"><CompLogo height={32} label={label} /></span> }

export function AuthCard({ children }: { children: ReactNode }) { return <section className="auth-card">{children}</section> }
export function AuthPrompt({ children }: { children: ReactNode }) { return <section className="auth-prompt">{children}</section> }

export function AuthTitle({ children }: { children: ReactNode }) { return <h1 className="auth-title">{children}</h1> }

export function AuthBody({ children }: { children: ReactNode }) { return <p className="auth-body">{children}</p> }
export function AuthErrorReference({ children }: { children: ReactNode }) { return <p className="auth-error-reference">{children}</p> }

export function AuthActions({ children }: { children: ReactNode }) { return <div className="auth-actions">{children}</div> }

export function AuthPrimaryAction({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return <Button variant="primary" disabled={disabled} onClick={onClick}>{children}</Button>
}

function GitHubMark() {
  return <svg className="auth-provider-icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.55 9.55 0 0 1 12 7.52a9.5 9.5 0 0 1 2.5.34c1.91-1.3 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.86v2.05c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" /></svg>
}

export function AuthGitHubAction({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return <Button variant="outline" disabled={disabled} onClick={onClick}><GitHubMark />Continue with GitHub</Button>
}

export function AuthSpinner() {
  return <svg className="auth-spinner" viewBox="0 0 22 22" aria-hidden="true" fill="none" strokeWidth="var(--icon-stroke-width)" strokeLinecap="round"><circle className="auth-spinner-track" cx="11" cy="11" r="9" /><path className="auth-spinner-arc" d="M11 2a9 9 0 0 1 9 9" /></svg>
}

export function AuthStatus({ title, body }: { title: string; body?: string | undefined }) {
  return <div className="auth-status" role="status" aria-live="polite"><AuthSpinner /><AuthTitle>{title}</AuthTitle>{body && <AuthBody>{body}</AuthBody>}</div>
}

export function AuthError({ children }: { children: ReactNode }) { return <p className="auth-error" role="alert">{children}</p> }
