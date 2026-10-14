import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SignInView } from './SignInScreen'
import type { HostedLoginSnapshot } from './hosted-login-service'

function state(overrides: Partial<HostedLoginSnapshot> = {}): HostedLoginSnapshot {
  return { request: null, invalidDesktopRequest: false, phase: 'ready', error: null, errorReference: null, ...overrides }
}

describe('AT-AUTH-001 hosted sign-in presentation', () => {
  it('shows the Canvas login and keeps unavailable providers disabled', () => {
    const html = renderToStaticMarkup(h(SignInView, { state: state(), onGitHub: vi.fn() }))
    expect(html).toContain('<h1 class="login-title">Canvas</h1>')
    expect(html).toContain('Enter your work email to receive a one-time password.')
    expect(html).toContain('id="work-email"')
    expect(html).not.toContain('email-provider-note')
    expect(html).toContain('href="https://www.trycomp.ai/"')
    expect(html).toContain('login-promo-shader')
    expect(html).toContain('Continue with Google')
    expect(html).not.toContain('sign-in is not configured')
    expect(html).not.toContain('login-provider-gap')
    expect(html).toMatch(/id="work-email"[^>]*disabled/)
    expect(html).toMatch(/login-button-primary[^>]*disabled/)
    expect(html).toMatch(/login-button-google[^>]*disabled/)
    expect(html).toContain('Continue with GitHub')
  })

  it('enables Google only when a real provider command is supplied', () => {
    const html = renderToStaticMarkup(h(SignInView, { state: state(), onGitHub: vi.fn(), onGoogle: vi.fn() }))
    expect(html).not.toMatch(/login-button-google[^>]*disabled/)
    expect(html).not.toContain('login-provider-gap')
  })

  it('disables every provider while submitting or for an invalid desktop request', () => {
    const submitting = renderToStaticMarkup(h(SignInView, { state: state({ phase: 'submitting' }), onGitHub: vi.fn(), onGoogle: vi.fn() }))
    const invalid = renderToStaticMarkup(h(SignInView, { state: state({ invalidDesktopRequest: true, error: 'Sign-in request is invalid.' }), onGitHub: vi.fn(), onGoogle: vi.fn() }))
    expect(submitting.match(/ disabled=""/g)).toHaveLength(4)
    expect(invalid.match(/ disabled=""/g)).toHaveLength(4)
    expect(invalid).toContain('role="alert"')
  })

  it('shows the native handoff state without provider controls', () => {
    const html = renderToStaticMarkup(h(SignInView, { state: state({ phase: 'opening' }), onGitHub: vi.fn() }))
    expect(html).toContain('Opening Canvas…')
    expect(html).toContain('You can close this tab after Canvas opens.')
    expect(html).not.toContain('Continue with GitHub')
  })
})
