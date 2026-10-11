import { randomUUID } from 'node:crypto'
import { defaultMaxCollaborationMessageBytes, encodeCollaborationMessage, encodeSemanticCommandForPersistence, maxCollaborationIdentifierLength, maxPresenceParticipants, maxSnapshotBytes, maxSnapshotChunkBytes } from '@canvas/sync-protocol'
import { canonicalCollaborationJson } from '@canvas/database/collaboration'
import type {
  CollaborationClientMessage,
  CollaborationServerMessage,
  OperationSubmitMessage,
  PresenceParticipant,
  PresencePatch,
  PresenceState,
  PresenceUpdateMessage,
  RoomErrorCode,
  RoomOpenMessage,
  SemanticFileCommand,
  ServerRoomEnvelope,
  VerifiedRoomTicketClaims,
} from '@canvas/sync-protocol'
import type { CollaborationProjection, CollaborationPayload, CollaborationLease } from '@canvas/database/collaboration'
import type { RoomAuthorization, RoomCoreDependencies, RoomCoreOptions, RoomTicketContext } from './contracts.js'

export type RoomPhase = 'cold' | 'starting' | 'accepting' | 'draining' | 'stopped' | 'failed'

export interface RoomPeer {
  readonly connectionId: string
  send(message: string): void | Promise<void>
  close(code: number, reason: string): void
}

type Session = Readonly<{
  presenceId: string
  claims: VerifiedRoomTicketClaims
  peer: RoomPeer
  presenceSequence: number
  presence: PresenceState
  connectionNonce: string
  requestId: string
}>

export type RoomAdmission = Readonly<{
  peer: RoomPeer
  ticketContext: RoomTicketContext
  open: RoomOpenMessage
}>

type ProjectionStreamPlan = Readonly<{
  requestId: string
  role: VerifiedRoomTicketClaims['role']
  projection: CollaborationProjection
  snapshotId: string
  document: Buffer
  chunkCount: number
  envelope: ServerRoomEnvelope
}>

const emptyLogger = Object.freeze({ event(_event: Readonly<Record<string, string | number | boolean | null>>) {} })
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
const emptyPresence: PresenceState = Object.freeze({ pageId: null, focused: false, selection: null, camera: null, cursor: null })
const reservedPresenceParticipant: PresenceParticipant = Object.freeze({
  presenceId: '00000000-0000-4000-8000-000000000000',
  subjectId: 's'.repeat(maxCollaborationIdentifierLength),
  displayName: 'Reserved participant',
  avatarUrl: null,
  clientId: 'c'.repeat(maxCollaborationIdentifierLength),
  role: 'viewer',
  sequence: null,
  data: emptyPresence,
})

class RoomCapacityError extends Error {
  constructor(message: string) { super(message); this.name = 'RoomCapacityError' }
}

function mergePresence(current: PresenceState, patch: PresencePatch): PresenceState | null {
  const hasPageId = Object.hasOwn(patch, 'pageId')
  const pageId = hasPageId ? patch.pageId! : current.pageId
  const pageChanged = hasPageId && pageId !== current.pageId
  const selection = Object.hasOwn(patch, 'selection') ? patch.selection! : pageChanged ? null : current.selection
  const camera = Object.hasOwn(patch, 'camera') ? patch.camera! : pageChanged ? null : current.camera
  const cursor = Object.hasOwn(patch, 'cursor') ? patch.cursor! : pageChanged ? null : current.cursor
  const interaction = Object.hasOwn(patch, 'interaction') ? patch.interaction! : pageChanged ? null : current.interaction ?? null
  if ((selection && selection.pageId !== pageId) || (camera && camera.pageId !== pageId) || (cursor && cursor.pageId !== pageId) || (interaction && interaction.pageId !== pageId)) return null
  return Object.freeze({
    pageId,
    focused: Object.hasOwn(patch, 'focused') ? patch.focused! : current.focused,
    selection: selection ? Object.freeze({ ...selection, nodeIds: Object.freeze([...selection.nodeIds]) }) : null,
    camera: camera ? Object.freeze({ ...camera }) : null,
    cursor: cursor ? Object.freeze({ ...cursor }) : null,
    interaction: interaction ? Object.freeze({ ...interaction, nodeIds: Object.freeze([...interaction.nodeIds]), transforms: Object.freeze(interaction.transforms.map(transform => Object.freeze({ ...transform }))) }) : null,
  })
}

function sameInteractionLock(left: NonNullable<PresenceState['interaction']>, right: NonNullable<PresenceState['interaction']>): boolean {
  return left.interactionId === right.interactionId
    && left.pageId === right.pageId
    && left.kind === right.kind
    && left.nodeIds.length === right.nodeIds.length
    && left.nodeIds.every((nodeId, index) => nodeId === right.nodeIds[index])
}

function interactionTransformsAreScoped(interaction: NonNullable<PresenceState['interaction']>): boolean {
  const locked = new Set(interaction.nodeIds)
  return interaction.transforms.every(transform => locked.has(transform.nodeId))
}

type CommandScope = Readonly<{ nodeIds: ReadonlySet<string>; pageIds: ReadonlySet<string> }>

function pageRootIds(document: CollaborationPayload): ReadonlySet<string> {
  if (!Array.isArray(document.pages)) return new Set()
  return new Set(document.pages.flatMap(page => page && typeof page === 'object' && typeof (page as Record<string, unknown>).rootNodeId === 'string' ? [(page as Record<string, unknown>).rootNodeId as string] : []))
}

function addStructuralParent(document: CollaborationPayload, nodeIds: Set<string>, nodeId: string): void {
  if (!pageRootIds(document).has(nodeId)) nodeIds.add(nodeId)
}

function commandScope(document: CollaborationPayload, command: SemanticFileCommand, nodeIds = new Set<string>(), pageIds = new Set<string>()): CommandScope {
  if (command.type === 'batch') {
    for (const nested of command.commands) commandScope(document, nested, nodeIds, pageIds)
    return { nodeIds, pageIds }
  }
  if (command.type === 'node.insert') {
    nodeIds.add(command.node.id)
    addStructuralParent(document, nodeIds, command.placement.parentId)
    return { nodeIds, pageIds }
  }
  if (command.type === 'node.delete') {
    for (const nodeId of command.nodeIds) {
      nodeIds.add(nodeId)
      const parent = parentId(document, nodeId)
      if (parent) addStructuralParent(document, nodeIds, parent)
    }
    return { nodeIds, pageIds }
  }
  if (command.type === 'node.reparent') {
    nodeIds.add(command.nodeId)
    const sourceParent = parentId(document, command.nodeId)
    if (sourceParent) addStructuralParent(document, nodeIds, sourceParent)
    addStructuralParent(document, nodeIds, command.placement.parentId)
    return { nodeIds, pageIds }
  }
  if (command.type === 'node.reorder' || command.type === 'node.duplicate') {
    nodeIds.add(command.nodeId)
    const parent = parentId(document, command.nodeId)
    if (parent) addStructuralParent(document, nodeIds, parent)
    return { nodeIds, pageIds }
  }
  if (command.type === 'page.delete') pageIds.add(command.pageId)
  if ('nodeId' in command && typeof command.nodeId === 'string') nodeIds.add(command.nodeId)
  return { nodeIds, pageIds }
}

function parentId(document: CollaborationPayload, nodeId: string): string | null {
  const relationships = document.relationships
  if (!relationships || typeof relationships !== 'object' || Array.isArray(relationships)) return null
  const relationship = (relationships as Record<string, unknown>)[nodeId]
  if (!relationship || typeof relationship !== 'object' || Array.isArray(relationship)) return null
  const parent = (relationship as Record<string, unknown>).parentId
  return typeof parent === 'string' ? parent : null
}

function interactionTargetsProjection(document: CollaborationPayload, interaction: NonNullable<PresenceState['interaction']>): boolean {
  if (!Array.isArray(document.pages)) return false
  const page = document.pages.find(candidate => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).id === interaction.pageId) as Record<string, unknown> | undefined
  if (!page || typeof page.rootNodeId !== 'string') return false
  const nodes = document.nodes
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return false
  const records = nodes as Record<string, unknown>
  for (const nodeId of interaction.nodeIds) {
    if (!records[nodeId] || nodeId === page.rootNodeId) return false
    const visited = new Set<string>()
    let current: string | null = nodeId
    while (current && current !== page.rootNodeId && !visited.has(current)) {
      visited.add(current)
      current = parentId(document, current)
    }
    if (current !== page.rootNodeId) return false
  }
  return true
}

function nodeScopeContains(document: CollaborationPayload, nodeIds: ReadonlySet<string>, nodeId: string): boolean {
  const visited = new Set<string>()
  let current: string | null = nodeId
  while (current && !visited.has(current)) {
    if (nodeIds.has(current)) return true
    visited.add(current)
    current = parentId(document, current)
  }
  return false
}

function nodeScopesOverlap(document: CollaborationPayload, left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const nodeId of left) if (nodeScopeContains(document, right, nodeId)) return true
  for (const nodeId of right) if (nodeScopeContains(document, left, nodeId)) return true
  return false
}

function scopeTouchesInteraction(document: CollaborationPayload, scope: CommandScope, interaction: NonNullable<PresenceState['interaction']>): boolean {
  return scope.pageIds.has(interaction.pageId) || nodeScopesOverlap(document, scope.nodeIds, new Set(interaction.nodeIds))
}

export class RoomNotAcceptingError extends Error {
  constructor() { super('Room is not accepting connections.'); this.name = 'RoomNotAcceptingError' }
}

export class RoomAuthorityUnavailableError extends Error {
  constructor(readonly reason: 'generation-conflict' | 'lease-held' | 'invalid-generation') {
    super(`Room authority is unavailable: ${reason}.`)
    this.name = 'RoomAuthorityUnavailableError'
  }
}

export class CollaborationRoomCore {
  readonly #dependencies: RoomCoreDependencies
  readonly #options: RoomCoreOptions
  readonly #sessions = new Map<string, Session>()
  readonly #connectionNonces = new Set<string>()
  #phase: RoomPhase = 'cold'
  #lease: CollaborationLease | null = null
  #projection: CollaborationProjection | null = null
  #mutationTail: Promise<void> = Promise.resolve()
  #presenceTail: Promise<void> = Promise.resolve()
  #pendingMutationScope: CommandScope | null = null
  #renewal: NodeJS.Timeout | null = null
  #renewalTask: Promise<void> | null = null
  #shutdownTimedOut = false
  #drain: Promise<Readonly<{ status: 'stopped' | 'checkpoint-failed' | 'timeout' }>> | null = null

  constructor(options: RoomCoreOptions, dependencies: RoomCoreDependencies) {
    if (options.identity.protocolEpoch !== 2) throw new Error('Room core requires collaboration protocol epoch 2.')
    if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs < 1) throw new Error('Lease duration must be positive.')
    if (!Number.isSafeInteger(options.leaseRenewalMs) || options.leaseRenewalMs < 1 || options.leaseRenewalMs >= options.leaseDurationMs) throw new Error('Lease renewal must be positive and shorter than the lease duration.')
    if (!Number.isSafeInteger(options.drainTimeoutMs) || options.drainTimeoutMs < 1) throw new Error('Drain timeout must be positive.')
    if (options.maxMessageBytes !== undefined && (!Number.isSafeInteger(options.maxMessageBytes) || options.maxMessageBytes < 1)) throw new Error('Message byte limit must be positive.')
    this.#options = options
    this.#dependencies = dependencies
  }

  get phase(): RoomPhase { return this.#phase }
  get identity(): RoomCoreOptions['identity'] { return this.#options.identity }
  get activeConnections(): number { return this.#sessions.size }
  get sequence(): bigint | null { return this.#projection?.sequence ?? null }

  async start(): Promise<void> {
    if (this.#phase !== 'cold') throw new Error('Room core can only start once.')
    this.#phase = 'starting'
    const identity = this.#options.identity
    try {
      const registered = await this.#dependencies.persistence.registerGeneration(identity)
      if (registered.status === 'generation-conflict') throw new RoomAuthorityUnavailableError('generation-conflict')
      const acquired = await this.#dependencies.persistence.acquireLease({ ...identity, leaseDurationMs: this.#options.leaseDurationMs })
      if (acquired.status !== 'acquired') throw new RoomAuthorityUnavailableError(acquired.status === 'held' ? 'lease-held' : 'invalid-generation')
      this.#lease = acquired.lease
      const bootstrapped = await this.#dependencies.persistence.bootstrapProjectionFromLegacy({
        ...identity,
        fencingToken: acquired.lease.fencingToken,
        documentSchemaVersion: 7,
      })
      if (bootstrapped.status === 'stale-fence' || bootstrapped.status === 'source-not-found' || bootstrapped.status === 'invalid-source') throw new Error(`Room projection bootstrap failed: ${bootstrapped.status}.`)
      this.#projection = bootstrapped.projection
      this.#phase = 'accepting'
      this.#renewal = setInterval(() => this.#scheduleRenewal(), this.#options.leaseRenewalMs)
      this.#renewal.unref()
      this.#log('room_started')
    } catch (error) {
      this.#phase = 'failed'
      const lease = this.#lease
      this.#lease = null
      if (!lease) throw error
      try {
        const released = await this.#dependencies.persistence.releaseLease({ ...this.#options.identity, fencingToken: lease.fencingToken })
        if (!released) throw new Error('Room startup lease could not be released.')
      }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Room startup and lease cleanup both failed.') }
      throw error
    }
  }

  async authorize(ticketContext: RoomTicketContext): Promise<RoomAuthorization | null> {
    if (this.#phase !== 'accepting') throw new RoomNotAcceptingError()
    const authorization = await this.#dependencies.tickets.verify(ticketContext)
    const claims = authorization?.claims
    if (!authorization || !claims
      || claims.protocolEpoch !== 2
      || claims.fileId !== this.#options.identity.fileId
      || claims.generationId !== this.#options.identity.generationId
      || claims.clientId !== ticketContext.clientId
      || claims.connectionNonce !== ticketContext.connectionNonce
      || claims.expiresAtUnixMs <= ticketContext.nowUnixMs) return null
    return authorization
  }

  async admit(admission: RoomAdmission): Promise<boolean> {
    const authorization = await this.authorize(admission.ticketContext)
    return authorization ? this.admitAuthorized(admission.peer, authorization, admission.open) : false
  }

  async admitAuthorized(peer: RoomPeer, authorization: RoomAuthorization, open: RoomOpenMessage): Promise<boolean> {
    if (this.#phase !== 'accepting') throw new RoomNotAcceptingError()
    return this.#serialize(async () => {
      return this.#enqueuePresence(async () => {
        if (this.#phase !== 'accepting') throw new RoomNotAcceptingError()
        const currentClaims = await this.#dependencies.tickets.consume(authorization, { nowUnixMs: Date.now(), buildId: open.buildId })
        if (!currentClaims
          || currentClaims.protocolEpoch !== 2
          || currentClaims.fileId !== this.#options.identity.fileId
          || currentClaims.generationId !== this.#options.identity.generationId
          || currentClaims.expiresAtUnixMs <= Date.now()) return false
        await this.#pruneUnauthorizedSessions()
        if (this.#sessions.has(peer.connectionId)
          || this.#connectionNonces.has(currentClaims.connectionNonce)
          || [...this.#sessions.values()].some(session => session.claims.clientId === currentClaims.clientId)) return false
        if (open.fileId !== currentClaims.fileId || open.clientId !== currentClaims.clientId) return false
        const currentParticipants = [...this.#sessions.values()].map(current => this.#participant(current))
        if (currentParticipants.length >= maxPresenceParticipants
          || (currentParticipants.length > 0 && !this.#presenceAdmissionFits(currentParticipants))) return false
        const session = Object.freeze({
          presenceId: randomUUID(),
          claims: currentClaims,
          peer,
          presenceSequence: -1,
          presence: emptyPresence,
          connectionNonce: currentClaims.connectionNonce,
          requestId: open.requestId,
        })
        const envelope = this.#envelope()
        const assigned: CollaborationServerMessage = {
          type: 'room.assigned',
          envelope,
          requestId: session.requestId,
          role: currentClaims.role,
        }
        const plannedRoster: Extract<CollaborationServerMessage, { type: 'presence.roster' }> = {
          type: 'presence.roster',
          envelope,
          participants: [...currentParticipants, this.#participant(session)],
        }
        let projectionStream: ProjectionStreamPlan
        try {
          projectionStream = this.#prepareProjectionStream(session.requestId, currentClaims.role)
          this.#assertMessageFits(assigned)
          this.#assertPresenceRosterFits(plannedRoster)
        } catch (error) {
          if (error instanceof RoomCapacityError) return false
          throw error
        }
        await this.#send(peer, assigned)
        if (!await this.#verifyCurrentClaims(currentClaims)) return false
        await this.#streamProjection(peer, projectionStream)
        await this.#send(peer, plannedRoster)
        this.#sessions.set(peer.connectionId, session)
        this.#connectionNonces.add(session.connectionNonce)
        await this.#broadcastPresence({ type: 'presence.join', envelope: this.#envelope(), participant: this.#participant(session) }, session.peer.connectionId)
        this.#log('room_admission_accepted', { connectionId: peer.connectionId, role: currentClaims.role })
        return true
      })
    })
  }

  disconnect(connectionId: string): void {
    const session = this.#removeSession(connectionId)
    if (session) {
      void this.#enqueuePresence(() => this.#broadcastPresence({
        type: 'presence.leave',
        envelope: this.#envelope(),
        presenceId: session.presenceId,
        subjectId: session.claims.subjectId,
        clientId: session.claims.clientId,
      })).catch(error => {
        this.#log('presence_leave_failed', { connectionId, error: errorMessage(error) })
      })
    }
  }

  receive(connectionId: string, message: CollaborationClientMessage): Promise<void> {
    const session = this.#sessions.get(connectionId)
    if (!session) return Promise.reject(new Error('Connection is not admitted.'))
    if (message.type === 'operation.submit') {
      if (this.#phase !== 'accepting') return this.#roomError(session, 'draining', 'Room is draining.', 'reconnect', message.operation.mutationId, 250)
      return this.#enqueueMutation(async () => {
        await this.#presenceTail
        await this.#operation(session, message)
      })
    }
    if (message.type === 'presence.update') {
      if (this.#phase !== 'accepting') return this.#roomError(session, 'draining', 'Room is draining.', 'reconnect', undefined, 250)
      return this.#enqueuePresence(() => this.#presence(session, message))
    }
    if (message.type === 'room.resume') {
      if (message.requestId !== session.requestId) return this.#rejectScope(session)
      return Promise.resolve()
    }
    if (message.type === 'room.leave') {
      this.disconnect(connectionId)
      session.peer.close(1000, 'Room left')
      return Promise.resolve()
    }
    if (message.type === 'room.open') return this.#rejectProtocol(session)
    return Promise.resolve()
  }

  drain(): Promise<Readonly<{ status: 'stopped' | 'checkpoint-failed' | 'timeout' }>> {
    if (this.#drain) return this.#drain
    if (this.#phase === 'stopped') return Promise.resolve(Object.freeze({ status: 'stopped' }))
    this.#phase = 'draining'
    if (this.#renewal) { clearInterval(this.#renewal); this.#renewal = null }
    this.#drain = this.#beginDrain()
    return this.#drain
  }

  async #operation(session: Session, message: OperationSubmitMessage): Promise<void> {
    const currentClaims = await this.#refreshClaims(session)
    if (!currentClaims) {
      await this.#roomError(session, 'access_revoked', 'File access changed.', 'none', message.operation.mutationId)
      session.peer.close(4403, 'File access changed')
      this.disconnect(session.peer.connectionId)
      return
    }
    if (currentClaims.role !== 'owner') { await this.#roomError(session, 'read_only', 'This file is read only.', 'none', message.operation.mutationId); return }
    const projection = this.#projection
    const lease = this.#lease
    if (!projection || !lease) throw new Error('Room authority is unavailable.')
    await this.#presenceTail
    const scope = commandScope(projection.document, message.operation.command)
    if (this.#commandTouchesForeignInteraction(session, scope, projection.document)) {
      await this.#roomError(session, 'invalid_operation', 'Node is being edited in another session.', 'none', message.operation.mutationId)
      return
    }
    const baseSequence = BigInt(message.operation.baseSequence)
    let projected: CollaborationPayload
    try { projected = baseSequence === projection.sequence ? this.#dependencies.projector.apply(projection.document, message.operation.command) : projection.document }
    catch { await this.#roomError(session, 'invalid_operation', 'Operation is invalid.', 'none', message.operation.mutationId); return }
    const persisted = encodeSemanticCommandForPersistence(message.operation.command)
    this.#pendingMutationScope = scope
    let result
    try {
      result = await this.#dependencies.persistence.appendOperation({
        ...this.#options.identity,
        fencingToken: lease.fencingToken,
        expectedSubjectId: currentClaims.subjectId,
        expectedAccessEpoch: BigInt(currentClaims.accessEpoch),
        clientId: session.claims.clientId,
        clientMutationId: message.operation.mutationId,
        operationType: persisted.operationType,
        operationPayload: persisted.operationPayload,
        baseSequence,
        projection: { documentSchemaVersion: 7, document: projected },
      })
      if (result.status === 'committed') this.#projection = result.projection
    } finally {
      this.#pendingMutationScope = null
    }
    if (result.status === 'committed') {
      try { await this.#send(session.peer, { type: 'operation.ack', envelope: this.#envelope(), mutationId: message.operation.mutationId, sequence: result.operation.sequence.toString(), status: 'applied' }) }
      catch { session.peer.close(1011, 'Acknowledgement failed'); this.disconnect(session.peer.connectionId) }
      const applied: CollaborationServerMessage = { type: 'operation.applied', envelope: this.#envelope(), mutationId: message.operation.mutationId, sequence: result.operation.sequence.toString(), subjectId: session.claims.subjectId, command: message.operation.command }
      const recipients = [...this.#sessions.values()].filter(recipient => recipient.peer !== session.peer)
      await Promise.all(recipients.map(async recipient => {
        try {
          if (!await this.#refreshClaims(recipient)) {
            await this.#roomError(recipient, 'access_revoked', 'File access changed.', 'none').catch(error => {
              this.#log('room_error_delivery_failed', { connectionId: recipient.peer.connectionId, error: errorMessage(error) })
            })
            recipient.peer.close(4403, 'File access changed')
            this.disconnect(recipient.peer.connectionId)
            return
          }
          await this.#send(recipient.peer, applied)
        } catch {
          recipient.peer.close(1011, 'Operation delivery failed')
          this.disconnect(recipient.peer.connectionId)
        }
      }))
      return
    }
    if (result.status === 'replayed') {
      await this.#send(session.peer, { type: 'operation.ack', envelope: this.#envelope(), mutationId: message.operation.mutationId, sequence: result.operation.sequence.toString(), status: 'duplicate' })
      return
    }
    if (result.status === 'sequence-conflict') {
      await this.#send(session.peer, { type: 'operation.rebase_required', envelope: this.#envelope(), mutationId: message.operation.mutationId, baseSequence: message.operation.baseSequence, authoritativeSequence: result.currentSequence.toString(), retry: 'resync' })
      return
    }
    if (result.status === 'access-revoked' || result.status === 'access-conflict') {
      await this.#roomError(session, 'access_revoked', 'File access changed.', 'none', message.operation.mutationId)
      session.peer.close(4403, 'File access changed')
      this.disconnect(session.peer.connectionId)
      return
    }
    await this.#roomError(
      session,
      result.status === 'mutation-conflict' ? 'mutation_id_reused' : 'internal_error',
      'Operation was rejected.',
      result.status === 'stale-fence' ? 'reconnect' : 'none',
      message.operation.mutationId,
    )
  }

  async #presence(session: Session, message: PresenceUpdateMessage): Promise<void> {
    if (!this.#claimsAreLocallyCurrent(session.claims)) {
      await this.#roomError(session, 'access_revoked', 'File access changed.', 'none')
      session.peer.close(4403, 'File access changed')
      this.disconnect(session.peer.connectionId)
      return
    }
    if (session.claims.role !== 'owner') {
      await this.#roomError(session, 'read_only', 'This file is read only.', 'none')
      return
    }
    const current = this.#sessions.get(session.peer.connectionId)
    if (!current || current.presenceId !== session.presenceId || message.sequence <= current.presenceSequence) return
    const presence = mergePresence(current.presence, message.data)
    if (!presence) {
      await this.#roomError(current, 'invalid_operation', 'Presence update is invalid.', 'none')
      return
    }
    const previousInteraction = current.presence.interaction ?? null
    const nextInteraction = presence.interaction ?? null
    if (nextInteraction && !interactionTransformsAreScoped(nextInteraction)) return
    if (nextInteraction && (!this.#projection || !interactionTargetsProjection(this.#projection.document, nextInteraction))) return
    if (previousInteraction && nextInteraction && !sameInteractionLock(previousInteraction, nextInteraction)) return
    if (!previousInteraction && nextInteraction && this.#interactionConflicts(current, nextInteraction)) return
    const updated = Object.freeze({ ...current, presenceSequence: message.sequence, presence })
    const changed: CollaborationServerMessage = { type: 'presence.changed', envelope: this.#envelope(), participant: this.#participant(updated) }
    const currentParticipants = [...this.#sessions.values()].map(candidate => this.#participant(candidate))
    const updatedParticipants = [...this.#sessions.values()].map(candidate => this.#participant(candidate.presenceId === updated.presenceId ? updated : candidate))
    try {
      this.#assertMessageFits(changed)
      this.#assertPresenceRosterFits(this.#presenceRoster(updatedParticipants))
      if (this.#presenceAdmissionFits(currentParticipants)) {
        this.#assertPresenceRosterFits(this.#presenceRoster([...updatedParticipants, reservedPresenceParticipant]))
      }
    } catch {
      await this.#roomError(current, 'invalid_operation', 'Presence update exceeds the room limit.', 'none')
      return
    }
    this.#sessions.set(session.peer.connectionId, updated)
    const interactionTransition = Boolean(previousInteraction) !== Boolean(nextInteraction)
    await this.#broadcastPresence(changed, interactionTransition ? undefined : session.peer.connectionId)
  }

  #interactionConflicts(session: Session, interaction: NonNullable<PresenceState['interaction']>): boolean {
    const requested = new Set(interaction.nodeIds)
    const document = this.#projection?.document
    if (!document) return true
    if (this.#pendingMutationScope && scopeTouchesInteraction(document, this.#pendingMutationScope, interaction)) return true
    for (const candidate of this.#sessions.values()) {
      if (candidate.peer.connectionId === session.peer.connectionId) continue
      const active = candidate.presence.interaction
      if (!active || active.pageId !== interaction.pageId) continue
      if (nodeScopesOverlap(document, requested, new Set(active.nodeIds))) return true
    }
    return false
  }

  #commandTouchesForeignInteraction(session: Session, scope: CommandScope, document: CollaborationPayload): boolean {
    if (scope.nodeIds.size === 0 && scope.pageIds.size === 0) return false
    for (const candidate of this.#sessions.values()) {
      if (candidate.peer.connectionId === session.peer.connectionId) continue
      const active = candidate.presence.interaction
      if (active && scopeTouchesInteraction(document, scope, active)) return true
    }
    return false
  }

  #participant(session: Session): PresenceParticipant {
    return Object.freeze({
      presenceId: session.presenceId,
      subjectId: session.claims.subjectId,
      displayName: session.claims.displayName,
      avatarUrl: session.claims.avatarUrl,
      clientId: session.claims.clientId,
      role: session.claims.role,
      sequence: session.presenceSequence < 0 ? null : session.presenceSequence,
      data: session.presence,
    })
  }

  async #broadcastPresence(message: CollaborationServerMessage, excludedConnectionId?: string): Promise<void> {
    const recipients = [...this.#sessions.values()].filter(recipient => recipient.peer.connectionId !== excludedConnectionId)
    await Promise.all(recipients.map(async recipient => {
      try {
        if (!this.#claimsAreLocallyCurrent(recipient.claims)) {
          await this.#roomError(recipient, 'access_revoked', 'File access changed.', 'none').catch(error => {
            this.#log('room_error_delivery_failed', { connectionId: recipient.peer.connectionId, error: errorMessage(error) })
          })
          recipient.peer.close(4403, 'File access changed')
          this.disconnect(recipient.peer.connectionId)
          return
        }
        await this.#send(recipient.peer, message)
      } catch {
        recipient.peer.close(1011, 'Presence delivery failed')
        this.disconnect(recipient.peer.connectionId)
      }
    }))
  }

  async #pruneUnauthorizedSessions(): Promise<void> {
    const removed: Session[] = []
    for (const session of [...this.#sessions.values()]) {
      if (await this.#refreshClaims(session)) continue
      await this.#roomError(session, 'access_revoked', 'File access changed.', 'none').catch(error => {
        this.#log('room_error_delivery_failed', { connectionId: session.peer.connectionId, error: errorMessage(error) })
      })
      session.peer.close(4403, 'File access changed')
      const stale = this.#removeSession(session.peer.connectionId)
      if (stale) removed.push(stale)
    }
    for (const session of removed) {
      await this.#broadcastPresence({
        type: 'presence.leave',
        envelope: this.#envelope(),
        presenceId: session.presenceId,
        subjectId: session.claims.subjectId,
        clientId: session.claims.clientId,
      })
    }
  }

  async #beginDrain(): Promise<Readonly<{ status: 'stopped' | 'checkpoint-failed' | 'timeout' }>> {
    await Promise.all([...this.#sessions.values()].map(session => this.#roomError(session, 'draining', 'Room is draining.', 'reconnect', undefined, 250).catch(error => {
      this.#log('room_error_delivery_failed', { connectionId: session.peer.connectionId, error: errorMessage(error) })
    })))
    return this.#drainWithBudget()
  }

  async #drainWithBudget(): Promise<Readonly<{ status: 'stopped' | 'checkpoint-failed' | 'timeout' }>> {
    const outcome = await Promise.race([
      this.#finishDrain(),
      new Promise<'timeout'>(resolve => { const timer = setTimeout(() => resolve('timeout'), this.#options.drainTimeoutMs); timer.unref() }),
    ])
    if (outcome === 'timeout') { this.#shutdownTimedOut = true; this.#phase = 'failed'; this.#closeAll(1012, 'Room restart required'); return Object.freeze({ status: 'timeout' }) }
    return outcome
  }

  async #finishDrain(): Promise<Readonly<{ status: 'stopped' | 'checkpoint-failed' }>> {
    try {
      await this.#mutationTail
      await this.#presenceTail
      if (this.#renewalTask) await this.#renewalTask
      if (this.#shutdownTimedOut) throw new Error('Room shutdown budget expired.')
      const projection = this.#projection
      const lease = this.#lease
      if (!projection || !lease) throw new Error('Room authority is unavailable.')
      const artifact = await this.#dependencies.checkpoints.write(projection)
      if (this.#shutdownTimedOut) throw new Error('Room shutdown budget expired.')
      const committed = await this.#dependencies.persistence.commitVerifiedCheckpoint({
        ...this.#options.identity, fencingToken: lease.fencingToken, sequence: projection.sequence,
        documentSchemaVersion: projection.documentSchemaVersion, ...artifact,
      })
      if (committed.status !== 'committed' && committed.status !== 'replayed') throw new Error(`Checkpoint rejected: ${committed.status}.`)
      if (this.#shutdownTimedOut) throw new Error('Room shutdown budget expired.')
      const released = await this.#dependencies.persistence.releaseLease({ ...this.#options.identity, fencingToken: lease.fencingToken })
      if (!released) throw new Error('Room lease could not be released.')
      this.#lease = null
      if (this.#shutdownTimedOut) throw new Error('Room shutdown budget expired.')
      this.#phase = 'stopped'
      this.#closeAll(1001, 'Room stopped')
      this.#log('room_stopped')
      return Object.freeze({ status: 'stopped' })
    } catch {
      this.#phase = 'failed'
      const lease = this.#lease
      if (lease) {
        await this.#dependencies.persistence.releaseLease({ ...this.#options.identity, fencingToken: lease.fencingToken }).catch(() => false)
        this.#lease = null
      }
      this.#closeAll(1012, 'Checkpoint failed')
      this.#log('room_checkpoint_failed')
      return Object.freeze({ status: 'checkpoint-failed' })
    }
  }

  async #renewLease(): Promise<void> {
    const lease = this.#lease
    if (!lease || this.#phase !== 'accepting') return
    const renewed = await this.#dependencies.persistence.renewLease({ ...this.#options.identity, fencingToken: lease.fencingToken, leaseDurationMs: this.#options.leaseDurationMs }).catch(() => null)
    if (renewed) {
      this.#lease = renewed
      await this.#enqueuePresence(() => this.#pruneUnauthorizedSessions())
      return
    }
    this.#phase = 'failed'
    this.#closeAll(1012, 'Room authority changed')
    this.#log('room_lease_lost')
  }

  async #verifyCurrentClaims(expected: VerifiedRoomTicketClaims): Promise<VerifiedRoomTicketClaims | null> {
    const nowUnixMs = Date.now()
    if (!this.#claimsAreLocallyCurrent(expected, nowUnixMs)) return null
    const current = await this.#dependencies.tickets.isCurrent(expected, nowUnixMs).catch(() => false)
    return current ? expected : null
  }

  #claimsAreLocallyCurrent(expected: VerifiedRoomTicketClaims, nowUnixMs = Date.now()): boolean {
    return expected.protocolEpoch === 2
      && expected.fileId === this.#options.identity.fileId
      && expected.generationId === this.#options.identity.generationId
      && expected.expiresAtUnixMs > nowUnixMs
  }

  #refreshClaims(session: Session): Promise<VerifiedRoomTicketClaims | null> {
    return this.#verifyCurrentClaims(session.claims)
  }

  #scheduleRenewal(): void {
    if (this.#renewalTask || this.#phase !== 'accepting') return
    this.#renewalTask = this.#renewLease().finally(() => { this.#renewalTask = null })
  }

  #enqueueMutation(work: () => Promise<void>): Promise<void> {
    return this.#serialize(work)
  }

  #enqueuePresence<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#presenceTail.then(work)
    this.#presenceTail = result.then(() => undefined, () => undefined)
    return result
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(work)
    this.#mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  #envelope(): ServerRoomEnvelope {
    if (!this.#lease) throw new Error('Room lease is unavailable.')
    return { protocolEpoch: 2, schemaVersion: 1, room: { fileId: this.#options.identity.fileId, generationId: this.#options.identity.generationId }, fenceToken: this.#lease.fencingToken.toString() }
  }

  #removeSession(connectionId: string): Session | null {
    const session = this.#sessions.get(connectionId) ?? null
    if (!session) return null
    this.#sessions.delete(connectionId)
    this.#connectionNonces.delete(session.connectionNonce)
    this.#log('room_connection_closed', { connectionId })
    return session
  }

  async #rejectScope(session: Session): Promise<void> {
    await this.#roomError(session, 'room_scope_mismatch', 'Message does not match this room.', 'none')
    session.peer.close(4403, 'Room scope mismatch')
    this.disconnect(session.peer.connectionId)
  }

  async #rejectProtocol(session: Session): Promise<void> {
    await this.#roomError(session, 'invalid_operation', 'Room is already open.', 'none')
    session.peer.close(4400, 'Duplicate room open')
    this.disconnect(session.peer.connectionId)
  }

  #roomError(session: Session, code: RoomErrorCode, message: string, retry: 'none' | 'refresh' | 'reconnect', mutationId?: string, retryAfterMs?: number): Promise<void> {
    return this.#send(session.peer, { type: 'room.error', envelope: this.#envelope(), code, message, retry, ...(mutationId ? { mutationId } : {}), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) })
  }

  #prepareProjectionStream(requestId: string, role: VerifiedRoomTicketClaims['role']): ProjectionStreamPlan {
    const projection = this.#projection
    if (!projection) throw new Error('Room projection is unavailable.')
    const snapshotId = `projection:${projection.sequence}`
    const document = Buffer.from(canonicalCollaborationJson(projection.document), 'utf8')
    if (document.byteLength < 1 || document.byteLength > maxSnapshotBytes) throw new Error('Projection exceeds the snapshot limit.')
    const chunkCount = Math.ceil(document.byteLength / maxSnapshotChunkBytes)
    const envelope = this.#envelope()
    this.#assertMessageFits({ type: 'load.phase', envelope, requestId, phase: 'stream' })
    this.#assertMessageFits({
      type: 'snapshot.begin', envelope, requestId, snapshotId, documentSchemaVersion: 7,
      baseSequence: projection.sequence.toString(), compression: 'none', contentEncoding: 'utf-8',
      storedByteLength: document.byteLength, documentByteLength: document.byteLength,
      objectDigest: projection.documentDigest, documentDigest: projection.documentDigest, chunkCount,
    })
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * maxSnapshotChunkBytes
      const data = document.subarray(start, Math.min(start + maxSnapshotChunkBytes, document.byteLength)).toString('base64')
      this.#assertMessageFits({ type: 'snapshot.chunk', envelope, requestId, snapshotId, chunkIndex, chunkCount, data })
    }
    this.#assertMessageFits({ type: 'snapshot.end', envelope, requestId, snapshotId })
    this.#assertMessageFits({ type: 'load.phase', envelope, requestId, phase: 'apply' })
    this.#assertMessageFits({ type: 'sync.ready', envelope, requestId, snapshotId, serverSequence: projection.sequence.toString(), role })
    return Object.freeze({ requestId, role, projection, snapshotId, document, chunkCount, envelope })
  }

  async #streamProjection(peer: RoomPeer, plan: ProjectionStreamPlan): Promise<void> {
    const { requestId, role, projection, snapshotId, document, chunkCount, envelope } = plan
    await this.#send(peer, { type: 'load.phase', envelope, requestId, phase: 'stream' })
    await this.#send(peer, {
      type: 'snapshot.begin', envelope, requestId, snapshotId, documentSchemaVersion: 7,
      baseSequence: projection.sequence.toString(), compression: 'none', contentEncoding: 'utf-8',
      storedByteLength: document.byteLength, documentByteLength: document.byteLength,
      objectDigest: projection.documentDigest, documentDigest: projection.documentDigest, chunkCount,
    })
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * maxSnapshotChunkBytes
      const data = document.subarray(start, Math.min(start + maxSnapshotChunkBytes, document.byteLength)).toString('base64')
      await this.#send(peer, { type: 'snapshot.chunk', envelope, requestId, snapshotId, chunkIndex, chunkCount, data })
    }
    await this.#send(peer, { type: 'snapshot.end', envelope, requestId, snapshotId })
    await this.#send(peer, { type: 'load.phase', envelope, requestId, phase: 'apply' })
    await this.#send(peer, { type: 'sync.ready', envelope, requestId, snapshotId, serverSequence: projection.sequence.toString(), role })
  }

  async #send(peer: RoomPeer, message: CollaborationServerMessage): Promise<void> {
    this.#assertMessageFits(message)
    await peer.send(encodeCollaborationMessage(message))
  }

  #assertMessageFits(message: CollaborationServerMessage): void {
    if (Buffer.byteLength(encodeCollaborationMessage(message), 'utf8') > (this.#options.maxMessageBytes ?? defaultMaxCollaborationMessageBytes)) throw new RoomCapacityError('Collaboration message exceeds the byte limit.')
  }

  #assertPresenceRosterFits(message: Extract<CollaborationServerMessage, { type: 'presence.roster' }>): void {
    if (message.participants.length > maxPresenceParticipants) throw new RoomCapacityError('Presence roster exceeds the participant limit.')
    this.#assertMessageFits(message)
  }

  #presenceRoster(participants: readonly PresenceParticipant[]): Extract<CollaborationServerMessage, { type: 'presence.roster' }> {
    return { type: 'presence.roster', envelope: this.#envelope(), participants }
  }

  #presenceAdmissionFits(participants: readonly PresenceParticipant[]): boolean {
    if (participants.length >= maxPresenceParticipants) return false
    try {
      this.#assertPresenceRosterFits(this.#presenceRoster([...participants, reservedPresenceParticipant]))
      return true
    } catch (error) {
      if (error instanceof RoomCapacityError) return false
      throw error
    }
  }

  #closeAll(code: number, reason: string): void {
    for (const session of this.#sessions.values()) session.peer.close(code, reason)
    this.#sessions.clear()
    this.#connectionNonces.clear()
  }

  #log(event: string, details: Readonly<Record<string, string | number | boolean | null>> = {}): void {
    ;(this.#dependencies.logger ?? emptyLogger).event({ event, fileId: this.#options.identity.fileId, generationId: this.#options.identity.generationId, phase: this.#phase, ...details })
  }
}
