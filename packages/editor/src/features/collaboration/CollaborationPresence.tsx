import { Fragment, useState, useSyncExternalStore } from 'react'
import type { EditorCollaborationAgent, EditorCollaborationLocalProfile, EditorCollaborationParticipant, EditorCollaborationSnapshot, EditorCollaborationTransform } from '../../capabilities'
import { CollaborationAgentAvatar, CollaborationAgentRosterItem, CollaborationAvatar, CollaborationCursor, CollaborationFollowFrame, CollaborationOverflow, CollaborationReadOnlyBanner, CollaborationRosterItem, CollaborationSelection, CollaborationStatusSurface, CollaborationStrip } from '../../design-system/collaboration-atoms'
import { collaborationService } from './collaboration-service'
import type { CollaborationViewSnapshot } from './collaboration-service'
import { collaborationCopy as copy } from './copy'
import { documentStore } from '../editor/document-store'
import { sceneGeometry } from '../editor/scene-geometry'
import { buildScene } from '../editor/canvas-scene'
import { unionRects, worldRectToScreen, worldToScreen } from '../editor/canvas-math'
import type { Rect } from '../editor/canvas-math'

const colors = [
  { background: 'var(--color-4)', foreground: 'var(--collaborator-color-4-foreground)' },
  { background: 'var(--color-2)', foreground: 'var(--collaborator-color-2-foreground)' },
  { background: 'var(--color-3)', foreground: 'var(--collaborator-color-3-foreground)' },
  { background: 'var(--color-1)', foreground: 'var(--collaborator-color-1-foreground)' },
] as const
type ColorIdentity = Pick<EditorCollaborationParticipant, 'subjectId'> | Readonly<{ subjectId: string }>
const anonymousSubject = (subjectId: string) => subjectId.startsWith('anonymous:')
export const participantColor = (participant: ColorIdentity) => {
  let value = 0
  for (const character of participant.subjectId) value = ((value << 5) - value + character.charCodeAt(0)) | 0
  return colors[Math.abs(value) % colors.length]!
}

export type CollaborationHuman = Readonly<{
  subjectId: string
  presenceId: string | null
  displayName: string
  avatarUrl: string | null
  local: boolean
}>
export type CollaborationIdentity = Readonly<{ kind: 'human'; human: CollaborationHuman }> | Readonly<{ kind: 'agent'; agent: EditorCollaborationAgent; local: boolean }>

const localHuman = (profile: EditorCollaborationLocalProfile | null, participant: EditorCollaborationParticipant | undefined): CollaborationHuman | null => profile ? {
  subjectId: profile.subjectId, presenceId: participant?.presenceId ?? null, displayName: profile.displayName, avatarUrl: profile.avatarUrl, local: true,
} : participant ? {
  subjectId: participant.subjectId, presenceId: participant.presenceId, displayName: participant.displayName, avatarUrl: participant.avatarUrl, local: true,
} : null

export function collaborationRoster(snapshot: Pick<EditorCollaborationSnapshot, 'localClientId' | 'localProfile' | 'participants' | 'agents'>) {
  const people = snapshot.participants.filter(participant => !participant.isHeadless)
  const localParticipant = people.find(participant => participant.clientId === snapshot.localClientId)
  const local = localHuman(snapshot.localProfile, localParticipant)
  const remote = people.filter(participant => participant.clientId !== snapshot.localClientId).map<CollaborationHuman>(participant => ({
    subjectId: participant.subjectId, presenceId: participant.presenceId, displayName: participant.displayName, avatarUrl: participant.avatarUrl, local: false,
  }))
  const agents = [...new Map(snapshot.agents.map(agent => [agent.agentId, agent])).values()]
  const visibleAgents = [...agents.slice(0, 2)]
  const hiddenAgents = [...agents.slice(2)]
  const visibleHumans = [...remote.slice(0, 4)]
  const hiddenHumans = [...remote.slice(4)]
  if (hiddenAgents.length + hiddenHumans.length === 1) {
    if (hiddenAgents.length) visibleAgents.push(hiddenAgents.shift()!)
    else visibleHumans.push(hiddenHumans.shift()!)
  }
  const visible: CollaborationIdentity[] = [
    ...(local ? [{ kind: 'human' as const, human: local }] : []),
    ...visibleAgents.map(agent => ({ kind: 'agent' as const, agent, local: agent.userId === snapshot.localProfile?.subjectId })),
    ...visibleHumans.map(human => ({ kind: 'human' as const, human })),
  ]
  const hidden: CollaborationIdentity[] = [
    ...hiddenAgents.map(agent => ({ kind: 'agent' as const, agent, local: agent.userId === snapshot.localProfile?.subjectId })),
    ...hiddenHumans.map(human => ({ kind: 'human' as const, human })),
  ]
  return { visible, hidden }
}

export function visiblePeople(participants: readonly EditorCollaborationParticipant[], localClientId: string | null) {
  const people = participants.filter(participant => !participant.isHeadless)
  const local = people.find(participant => participant.clientId === localClientId) ?? null
  const remote = people.filter(participant => participant.clientId !== localClientId)
  const ordered = local ? [local, ...remote] : remote
  const hiddenCount = Math.max(0, ordered.length - 5)
  const visibleCount = hiddenCount === 1 ? ordered.length : 5
  return { visible: ordered.slice(0, visibleCount), hidden: ordered.slice(visibleCount) }
}

export const remotePeopleOnPage = (participants: readonly EditorCollaborationParticipant[], localClientId: string | null, pageId: string) => participants.filter(participant => !participant.isHeadless && participant.clientId !== localClientId && participant.awareness.pageId === pageId)

export function collaborationSelectionRect(sceneRect: Rect | undefined, localTransientRect: Rect | undefined, remoteTransform: EditorCollaborationTransform | undefined): Rect | undefined {
  if (localTransientRect) return localTransientRect
  if (!sceneRect || !remoteTransform) return sceneRect
  return {
    x: sceneRect.x + remoteTransform.dx,
    y: sceneRect.y + remoteTransform.dy,
    width: remoteTransform.width ?? sceneRect.width,
    height: remoteTransform.height ?? sceneRect.height,
  }
}

export type CollaborationShellPresentation = Readonly<{ label: string; tone: 'progress' | 'danger'; action: 'retry' | 'leave' | null }>

export function collaborationShellPresentation(snapshot: Pick<CollaborationViewSnapshot, 'status' | 'shellState' | 'canRetry' | 'canLeave'>): CollaborationShellPresentation | null {
  const state = snapshot.shellState ?? (snapshot.status === 'connecting' ? 'connecting' : snapshot.status === 'reconnecting' ? 'reconnecting' : snapshot.status === 'error' ? 'file-busy' : null)
  if (!state) return null
  if (state === 'opening') return { label: copy.opening, tone: 'progress', action: null }
  if (state === 'connecting') return { label: copy.connecting, tone: 'progress', action: null }
  if (state === 'reconnecting') return { label: copy.reconnecting, tone: 'progress', action: null }
  if (state === 'access-removed') return { label: copy.accessRemoved, tone: 'danger', action: snapshot.canLeave ? 'leave' : null }
  if (state === 'update-required') return { label: copy.updateRequired, tone: 'danger', action: snapshot.canLeave ? 'leave' : null }
  return { label: copy.fileBusy, tone: 'danger', action: snapshot.canRetry ? 'retry' : snapshot.canLeave ? 'leave' : null }
}

function PresenceIdentity({ identity }: { identity: CollaborationIdentity }) {
  if (identity.kind === 'agent') {
    const color = participantColor({ subjectId: identity.agent.agentId })
    return <CollaborationAgentAvatar name={identity.agent.displayName} harness={identity.agent.harness} color={color.background} foreground={color.foreground} local={identity.local} />
  }
  const color = participantColor(identity.human)
  return <CollaborationAvatar name={identity.human.displayName} image={identity.human.avatarUrl} color={color.background} foreground={color.foreground} local={identity.human.local} anonymous={anonymousSubject(identity.human.subjectId)} {...(!identity.human.local && identity.human.presenceId ? { onSelect: () => collaborationService.follow(identity.human.presenceId!) } : {})} />
}

function RosterIdentity({ identity }: { identity: CollaborationIdentity }) {
  if (identity.kind === 'agent') {
    const color = participantColor({ subjectId: identity.agent.agentId })
    return <CollaborationAgentRosterItem name={identity.agent.displayName} harness={identity.agent.harness} color={color.background} foreground={color.foreground} local={identity.local} />
  }
  const color = participantColor(identity.human)
  return <CollaborationRosterItem name={identity.human.displayName} image={identity.human.avatarUrl} color={color.background} foreground={color.foreground} anonymous={anonymousSubject(identity.human.subjectId)} onSelect={() => { if (identity.human.presenceId) collaborationService.follow(identity.human.presenceId) }} />
}

export function CollaborationPresence({ floating = false }: { floating?: boolean }) {
  const snapshot = useSyncExternalStore(collaborationService.subscribe, collaborationService.getSnapshot, collaborationService.getSnapshot)
  if (snapshot.status === 'unavailable') return null
  const roster = collaborationRoster(snapshot)
  if (!roster.visible.length) return null
  return <CollaborationStrip label={copy.people} floating={floating}>
    {roster.visible.map(identity => <PresenceIdentity key={identity.kind === 'agent' ? `agent:${identity.agent.agentId}` : `human:${identity.human.presenceId ?? identity.human.subjectId}`} identity={identity} />)}
    {roster.hidden.length > 1 && <CollaborationOverflow count={roster.hidden.length} label={copy.moreIdentities(roster.hidden.length)}>{roster.hidden.map(identity => <RosterIdentity key={identity.kind === 'agent' ? `agent:${identity.agent.agentId}` : `human:${identity.human.presenceId ?? identity.human.subjectId}`} identity={identity} />)}</CollaborationOverflow>}
  </CollaborationStrip>
}

export function CollaborationCanvasPresence() {
  const collaboration = useSyncExternalStore(collaborationService.subscribe, collaborationService.getSnapshot, collaborationService.getSnapshot)
  const document = useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot, documentStore.getSnapshot)
  const geometry = useSyncExternalStore(sceneGeometry.subscribe, sceneGeometry.getSnapshot, sceneGeometry.getSnapshot)
  if (!document.file || !document.pageId) return null
  const scene = buildScene(document.file, document.pageId, geometry.nodes)
  const localTransientRects: Record<string, Rect> = document.transient?.kind === 'move' || document.transient?.kind === 'resize' ? document.transient.rects : {}
  return <>{remotePeopleOnPage(collaboration.participants, collaboration.localClientId, document.pageId).map(participant => {
    const awareness = participant.awareness
    const color = participantColor(participant)
    const transforms = new Map(awareness.interaction?.transforms.map(transform => [transform.nodeId, transform]) ?? [])
    const selection = awareness.selection?.pageId === document.pageId ? unionRects(awareness.selection.nodeIds.map(id => {
      return collaborationSelectionRect(scene.byId.get(id)?.rect, localTransientRects[id], transforms.get(id))
    }).filter(rect => rect !== undefined)) : null
    const selectionScreen = selection ? worldRectToScreen(selection, document.viewport, document.viewportSize) : null
    const smoothed = collaboration.cursorPositions[participant.presenceId]
    const cursor = smoothed?.pageId === document.pageId ? worldToScreen(smoothed, document.viewport, document.viewportSize) : null
    const rawCursor = awareness.cursor?.pageId === document.pageId ? awareness.cursor : null
    const snap = Boolean(rawCursor && smoothed && rawCursor.x === smoothed.x && rawCursor.y === smoothed.y)
    return <Fragment key={participant.presenceId}>
      {selectionScreen && <CollaborationSelection color={color.background} foreground={color.foreground} x={selectionScreen.x} y={selectionScreen.y} width={selectionScreen.width} height={selectionScreen.height} focused={awareness.focused} />}
      {cursor && <CollaborationCursor name={participant.displayName} color={color.background} foreground={color.foreground} x={cursor.x} y={cursor.y} focused={awareness.focused} snap={snap} />}
    </Fragment>
  })}</>
}

export function CollaborationFollowIndicator() {
  const snapshot = useSyncExternalStore(collaborationService.subscribe, collaborationService.getSnapshot, collaborationService.getSnapshot)
  const participant = snapshot.participants.find(item => item.presenceId === snapshot.followingPresenceId)
  const presentation = collaborationShellPresentation(snapshot)
  const action = presentation?.action === 'retry'
    ? { label: copy.tryAgain, onSelect: () => collaborationService.retry() }
    : presentation?.action === 'leave'
      ? { label: copy.leaveFile, onSelect: () => collaborationService.leave() }
      : undefined
  const color = participant ? participantColor(participant) : null
  return <>
    {presentation && <CollaborationStatusSurface label={presentation.label} tone={presentation.tone} {...(action ? { action } : {})} />}
    {participant && color && <CollaborationFollowFrame label={copy.following(participant.displayName)} stopLabel={copy.stopFollowing} color={color.background} foreground={color.foreground} onStop={() => collaborationService.stopFollowing()} />}
  </>
}

export function CollaborationReadOnlyNotice() {
  const document = useSyncExternalStore(documentStore.subscribe, documentStore.getShellSnapshot, documentStore.getShellSnapshot)
  const [dismissed, setDismissed] = useState(false)
  if (!document.readOnly || dismissed) return null
  return <CollaborationReadOnlyBanner title={copy.readOnlyTitle} body={copy.readOnlyBody} dismissLabel={copy.dismissReadOnly} onDismiss={() => setDismissed(true)} />
}
