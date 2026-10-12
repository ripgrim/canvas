import { existsSync, readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EditorCollaborationAgent, EditorCollaborationParticipant } from '../../capabilities'
import { CollaborationAgentAvatar, CollaborationAvatar, CollaborationCursor, CollaborationFollowFrame, CollaborationReadOnlyBanner, CollaborationSelection, CollaborationStatusSurface } from '../../design-system/collaboration-atoms'
import { FileScreen } from '../application/FileScreen'
import { documentStore } from '../editor/document-store'
import { collaborationCopy as copy } from './copy'
import { collaborationRoster, collaborationSelectionRect, collaborationShellPresentation, remotePeopleOnPage, visiblePeople } from './CollaborationPresence'

const participant = (id: string, clientId = id, pageId: string | null = 'page-1', focused = true, isHeadless = false): EditorCollaborationParticipant => ({
  presenceId: id,
  subjectId: `user-${id}`,
  displayName: id,
  avatarUrl: null,
  clientId,
  role: id === 'viewer' ? 'viewer' : 'owner',
  isHeadless,
  sequence: 1,
  awareness: { pageId, focused, selection: null, camera: null, cursor: null },
})

describe('UI-COLLAB-PRESENCE-001 presence presentation', () => {
  it('keeps local first, preserves remote insertion order, and excludes headless participants', () => {
    const people = visiblePeople([participant('remote-b'), participant('headless', 'headless', 'page-1', true, true), participant('local', 'tab-local'), participant('remote-a')], 'tab-local')
    expect(people.visible.map(person => person.presenceId)).toEqual(['local', 'remote-b', 'remote-a'])
    expect(people.hidden).toEqual([])
  })

  it('keeps the local profile stable, orders agents before remote humans, and hides agents first', () => {
    const agents: EditorCollaborationAgent[] = Array.from({ length: 4 }, (_, index) => ({ agentId: `agent-${index}`, displayName: `Agent ${index}`, harness: index === 3 ? 'unknown' : 'Codex', userId: index === 0 ? 'local-user' : null }))
    const roster = collaborationRoster({
      localClientId: 'tab-local',
      localProfile: { subjectId: 'local-user', displayName: 'Local profile', avatarUrl: null, role: 'owner' },
      participants: [participant('remote-a'), participant('headless', 'headless', 'page-1', true, true), ...Array.from({ length: 6 }, (_, index) => participant(`remote-${index}`))],
      agents,
    })
    expect(roster.visible.map(identity => identity.kind === 'agent' ? identity.agent.agentId : identity.human.displayName)).toEqual(['Local profile', 'agent-0', 'agent-1', 'remote-a', 'remote-0', 'remote-1', 'remote-2'])
    expect(roster.hidden.map(identity => identity.kind === 'agent' ? identity.agent.agentId : identity.human.displayName)).toEqual(['agent-2', 'agent-3', 'remote-3', 'remote-4', 'remote-5'])
  })

  it('deduplicates active agents by stable agent identity before applying limits', () => {
    const repeated = { agentId: 'agent-a', displayName: 'Agent A', harness: 'Codex', userId: null }
    const roster = collaborationRoster({
      localClientId: 'tab-local',
      localProfile: { subjectId: 'local-user', displayName: 'Local', avatarUrl: null, role: 'owner' },
      participants: [],
      agents: [repeated, { ...repeated, displayName: 'Agent A current' }, { agentId: 'agent-b', displayName: 'Agent B', harness: 'Codex', userId: null }],
    })
    expect(roster.visible.filter(identity => identity.kind === 'agent').map(identity => identity.kind === 'agent' ? identity.agent.displayName : '')).toEqual(['Agent A current', 'Agent B'])
  })

  it('keeps a single excess identity visible instead of showing a one-item overflow', () => {
    const roster = collaborationRoster({
      localClientId: 'tab-local',
      localProfile: { subjectId: 'local-user', displayName: 'Local', avatarUrl: null, role: 'owner' },
      participants: Array.from({ length: 4 }, (_, index) => participant(`remote-${index}`)),
      agents: Array.from({ length: 3 }, (_, index) => ({ agentId: `agent-${index}`, displayName: `Agent ${index}`, harness: 'Codex', userId: null })),
    })
    expect(roster.visible).toHaveLength(8)
    expect(roster.hidden).toEqual([])
  })

  it('keeps exactly one person beyond the nominal four remote slots visible and collapses two', () => {
    const six = visiblePeople([participant('local', 'tab-local'), ...Array.from({ length: 5 }, (_, index) => participant(`remote-${index}`))], 'tab-local')
    expect(six.visible).toHaveLength(6)
    expect(six.hidden).toHaveLength(0)
    const seven = visiblePeople([participant('local', 'tab-local'), ...Array.from({ length: 6 }, (_, index) => participant(`remote-${index}`))], 'tab-local')
    expect(seven.visible).toHaveLength(5)
    expect(seven.hidden.map(person => person.presenceId)).toEqual(['remote-4', 'remote-5'])
  })

  it('filters cursors and selections to remote people on the active page', () => {
    const people = remotePeopleOnPage([participant('local', 'tab-local'), participant('same'), participant('other', 'other', 'page-2')], 'tab-local', 'page-1')
    expect(people.map(person => person.presenceId)).toEqual(['same'])
  })

  it('CLOUD-SYNC-GESTURE-001 keeps a remote selection attached to a locally dragged node', () => {
    const saved = { x: 20, y: 30, width: 120, height: 80 }
    const live = { x: 84, y: -12, width: 120, height: 80 }
    expect(collaborationSelectionRect(saved, live, undefined)).toEqual(live)
    expect(collaborationSelectionRect(saved, undefined, { nodeId: 'node-1', dx: 9, dy: 7 })).toEqual({ x: 29, y: 37, width: 120, height: 80 })
    expect(collaborationSelectionRect(saved, live, { nodeId: 'node-1', dx: -500, dy: -500 })).toEqual(live)
  })

  it('uses the same human avatar for viewers without a viewer badge or join toast', () => {
    const html = renderToStaticMarkup(h(CollaborationAvatar, { name: 'viewer', image: null, color: 'var(--color-4)', foreground: 'var(--neutral-10)', local: false, onSelect: () => undefined }))
    expect(html).toContain('>V<')
    expect(html).not.toContain('viewer-icon')
    expect(html).not.toContain('toast')
  })

  it('UI-COLLAB-ANON-001 renders signed-out viewers with the stable placeholder mark', () => {
    const html = renderToStaticMarkup(h(CollaborationAvatar, { name: 'Guest', image: null, color: 'var(--color-4)', foreground: 'var(--neutral-10)', local: false, anonymous: true }))
    expect(html).toContain('collaboration-anonymous-glyph')
    expect(html).toContain('aria-label="Guest"')
    expect(html).toContain('tabindex="0"')
    expect(html).not.toContain('>G<')
  })

  it('keeps roster avatars decorative so the row announces each name once', () => {
    const html = renderToStaticMarkup(h(CollaborationAvatar, { name: 'Maya', image: null, color: 'var(--color-4)', foreground: 'var(--neutral-10)', local: false, decorative: true }))
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('aria-label="Maya"')
    expect(html).not.toContain('title="Maya"')
  })

  it('renders known and unknown agent marks without inventing a viewer badge', () => {
    const known = renderToStaticMarkup(h(CollaborationAgentAvatar, { name: 'Agent', harness: 'Codex', color: 'var(--color-4)', foreground: 'var(--neutral-10)', local: true }))
    const unknown = renderToStaticMarkup(h(CollaborationAgentAvatar, { name: 'Agent', harness: 'unknown', color: 'var(--color-4)', foreground: 'var(--neutral-10)', local: false }))
    expect(known).toContain('collaboration-agent-letter')
    expect(known).toContain('Codex, Agent (you)')
    expect(known).toContain('tabindex="0"')
    expect(unknown).toContain('collaboration-agent-robot')
    expect(unknown).not.toContain('viewer-icon')
  })

  it('uses the themed identity tooltip for header agents and a decorative mark in the roster', () => {
    const header = renderToStaticMarkup(h(CollaborationAgentAvatar, { name: 'Maya', harness: 'Codex', color: 'var(--color-4)', foreground: 'var(--neutral-10)', local: false }))
    const roster = renderToStaticMarkup(h(CollaborationAgentAvatar, { name: 'Maya', harness: 'Codex', color: 'var(--color-4)', foreground: 'var(--neutral-10)', local: false, decorative: true }))
    expect(header).toContain('aria-label="Codex, Maya"')
    expect(header).not.toContain('title="Codex, Maya"')
    expect(roster).toContain('aria-hidden="true"')
    expect(roster).not.toContain('aria-label="Codex, Maya"')
  })

  it('renders Paper cursor dots instead of invented arrow artwork', () => {
    const html = renderToStaticMarkup(h(CollaborationCursor, { name: 'Maya', color: 'var(--color-4)', foreground: 'var(--neutral-10)', x: 2, y: 3, focused: true, snap: false }))
    expect(html).toContain('collaboration-cursor-dot')
    expect(html).not.toContain('<svg')
  })

  it('shows focus-off status inside the blurred cursor pill without treating viewers specially', () => {
    const blurred = renderToStaticMarkup(h(CollaborationCursor, { name: 'Maya', color: 'var(--color-4)', foreground: 'var(--neutral-10)', x: 2, y: 3, focused: false, snap: false }))
    const focused = renderToStaticMarkup(h(CollaborationCursor, { name: 'Maya', color: 'var(--color-4)', foreground: 'var(--neutral-10)', x: 2, y: 3, focused: true, snap: false }))
    expect(blurred).toContain('collaboration-cursor-blurred')
    expect(focused).not.toContain('collaboration-cursor-blurred')
  })
})

describe('UI-COLLAB-FOLLOW-001 following presentation', () => {
  it('uses Paper wording and a dedicated stop action', () => {
    const html = renderToStaticMarkup(h(CollaborationFollowFrame, { label: copy.following('Maya'), stopLabel: copy.stopFollowing, color: 'var(--color-4)', foreground: 'var(--neutral-10)', onStop: () => undefined }))
    expect(copy.following('Maya')).toBe('following Maya')
    expect(html).toContain('stop following')
    expect(html).not.toContain('watching')
  })

  it('stops following from the whole colored pill target', () => {
    let stopped = false
    const frame = CollaborationFollowFrame({ label: copy.following('Maya'), stopLabel: copy.stopFollowing, color: 'var(--color-4)', foreground: 'var(--neutral-10)', onStop: () => { stopped = true } })
    const pill = frame.props.children as ReactElement<{ onClick: () => void }>
    pill.props.onClick()
    expect(stopped).toBe(true)
  })

  it('marks blurred selections independently from focused selections', () => {
    const blurred = renderToStaticMarkup(h(CollaborationSelection, { color: 'var(--color-4)', foreground: 'var(--neutral-10)', x: 0, y: 0, width: 10, height: 10, focused: false }))
    const focused = renderToStaticMarkup(h(CollaborationSelection, { color: 'var(--color-4)', foreground: 'var(--neutral-10)', x: 0, y: 0, width: 10, height: 10, focused: true }))
    expect(blurred).not.toContain('data-focused')
    expect(focused).toContain('data-focused="true"')
  })
})

describe('UI-COLLAB-PRESENCE-001 collaboration shell status', () => {
  const shell = (status: 'unavailable' | 'connecting' | 'live' | 'read-only' | 'reconnecting' | 'error', shellState?: 'opening' | 'connecting' | 'reconnecting' | 'access-removed' | 'update-required' | 'file-busy' | 'connection-failed', canRetry = false, canLeave = false) => collaborationShellPresentation({ status, ...(shellState ? { shellState } : {}), canRetry, canLeave })

  it('uses the documented short copy for progress and terminal states', () => {
    expect(shell('connecting', 'opening')?.label).toBe('Opening file…')
    expect(shell('connecting', 'connecting')?.label).toBe('Connecting…')
    expect(shell('reconnecting', 'reconnecting')?.label).toBe('Reconnecting…')
    expect(shell('error', 'access-removed', false, true)).toEqual({ label: 'Access removed', tone: 'danger', action: 'leave' })
    expect(shell('error', 'update-required', false, true)).toEqual({ label: 'Update required', tone: 'danger', action: 'leave' })
    expect(shell('error', 'file-busy', true, true)).toEqual({ label: 'File is busy', tone: 'danger', action: 'retry' })
  })

  it('does not render a no-op recovery action and keeps live states quiet', () => {
    expect(shell('error', 'file-busy')).toEqual({ label: 'File is busy', tone: 'danger', action: null })
    expect(shell('error', undefined, true)).toEqual({ label: 'Connection failed', tone: 'danger', action: 'retry' })
    expect(shell('live')).toBeNull()
    expect(shell('read-only')).toBeNull()
    expect(shell('unavailable')).toBeNull()
  })

  it('announces progress politely and terminal failures assertively', () => {
    const progress = renderToStaticMarkup(h(CollaborationStatusSurface, { label: copy.connecting, tone: 'progress' }))
    const terminal = renderToStaticMarkup(h(CollaborationStatusSurface, { label: copy.fileBusy, tone: 'danger', action: { label: copy.tryAgain, onSelect: () => undefined } }))
    expect(progress).toContain('role="status"')
    expect(progress).toContain('aria-live="polite"')
    expect(terminal).toContain('role="alert"')
    expect(terminal).toContain('aria-live="assertive"')
    expect(terminal).toContain('>Try again<')
  })
})

describe('UI-COLLAB-READONLY-001 read-only presentation', () => {
  it('uses the exact compact copy and exposes a dismiss control', () => {
    const html = renderToStaticMarkup(h(CollaborationReadOnlyBanner, { title: copy.readOnlyTitle, body: copy.readOnlyBody, dismissLabel: copy.dismissReadOnly, onDismiss: () => undefined }))
    expect(html).toContain('You can only view this file')
    expect(html).toContain('To edit, ask the owner to add you as an editor')
    expect(html).toContain('aria-label="Dismiss"')
    expect(html.match(/<svg/g)).toHaveLength(2)
  })

  it('anchors the only read-only notice above the mobile controls', () => {
    const css = readFileSync(new URL('../../design-system/collaboration.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.collaboration-read-only \{[^}]*position: fixed;[^}]*bottom: var\(--space-l\);/)
    expect(css).toContain('.collaboration-read-only { bottom: calc(48px + 2 * var(--space-m));')
    const packageManifest = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
    expect(packageManifest).not.toContain('"./shared-file"')
    expect(existsSync(new URL('../sharing/SharedFileViewer.tsx', import.meta.url))).toBe(false)
    const workspace = readFileSync(new URL('../editor/CanvasWorkspace.tsx', import.meta.url), 'utf8')
    expect(workspace.match(/<CollaborationReadOnlyNotice/g)).toHaveLength(1)
  })

  it('renders one bottom notice through the active public file screen', () => {
    documentStore.load({
      schemaVersion: 9,
      fileId: 'public-file',
      revision: 1,
      pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
      nodes: { 'root-1': { id: 'root-1', type: 'root' } },
      relationships: {},
      theme: { tokens: {} },
    }, [], { replace: true })
    documentStore.setReadOnly(true)

    const html = renderToStaticMarkup(h(FileScreen, {
      result: { status: 'ok', fileId: 'public-file', pageId: 'page-1', fileName: 'Public file' },
      onHome: () => undefined,
      onPageChange: () => undefined,
      onOpenDefaultPage: () => undefined,
    }))

    expect(html.match(/<aside class="collaboration-read-only"/g)).toHaveLength(1)
    expect(html).toContain('You can only view this file')
    expect(html).toContain('data-read-only="true"')
    expect(html).toContain('aria-label="Layers"')
    documentStore.clear()
  })
})
