import { createHash, randomUUID } from 'node:crypto'
import { collaborationProtocolEpoch, defaultMaxCollaborationMessageBytes, encodeCollaborationMessage, encodeSemanticCommandForPersistence, maxCollaborationIdentifierLength, maxPresenceParticipants, maxSnapshotBytes, maxSnapshotChunkBytes, validateFlowDragPresentation } from '@canvas/sync-protocol'
import { canonicalCollaborationJson } from '@canvas/database/collaboration'
import { fileSchemaVersion } from '@canvas/repo-engine/file-document'
import type {
  CollaborationClientMessage,
  CollaborationServerMessage,
  FlowDragDenialCode,
  FlowDragPresentation,
  InteractionAcquireMessage,
  InteractionReleaseMessage,
  InteractionReserveMessage,
  InteractionResultAction,
  InteractionSampleMessage,
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
import { createFlowTopologyAuthority, flowTargetDenial, sourcePositionMode } from './flow-authority.js'
import { canonicalPeerFlowPresentation, containsReservedPeerFlowInteractionId, FlowReservationAuthority, peerFlowInteractionId } from './flow-reservations.js'
import type { FlowLease, FlowLeaseOwner } from './flow-reservations.js'

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

type ClaimsCheck =
  | Readonly<{ status: 'current'; claims: VerifiedRoomTicketClaims }>
  | Readonly<{ status: 'refresh-required' | 'revoked' }>

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

function replayScopeId(claims: VerifiedRoomTicketClaims): string {
  return createHash('sha256')
    .update(claims.subjectId)
    .update('\0')
    .update(claims.fileId)
    .update('\0')
    .update(claims.role)
    .update('\0')
    .update(claims.accessEpoch)
    .digest('hex')
}

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
  if ((selection && selection.pageId !== pageId) || (camera && camera.pageId !== pageId) || (cursor && cursor.pageId !== pageId)) return null
  return Object.freeze({
    pageId,
    focused: Object.hasOwn(patch, 'focused') ? patch.focused! : current.focused,
    selection: selection ? Object.freeze({ ...selection, nodeIds: Object.freeze([...selection.nodeIds]) }) : null,
    camera: camera ? Object.freeze({ ...camera }) : null,
    cursor: cursor ? Object.freeze({ ...cursor }) : null,
  })
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
  readonly #flow = new FlowReservationAuthority()
  #renewal: NodeJS.Timeout | null = null
  #renewalTask: Promise<void> | null = null
  #shutdownTimedOut = false
  #drain: Promise<Readonly<{ status: 'stopped' | 'checkpoint-failed' | 'timeout' }>> | null = null

  constructor(options: RoomCoreOptions, dependencies: RoomCoreDependencies) {
    if (options.identity.protocolEpoch !== collaborationProtocolEpoch) throw new Error(`Room core requires collaboration protocol epoch ${collaborationProtocolEpoch}.`)
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
        documentSchemaVersion: fileSchemaVersion,
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
      || claims.protocolEpoch !== collaborationProtocolEpoch
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
    const rejectAdmission = (reason: string): false => {
      this.#log('room_admission_rejected', { reason })
      return false
    }
    return this.#serialize(async () => {
      return this.#enqueuePresence(async () => {
        if (this.#phase !== 'accepting') throw new RoomNotAcceptingError()
        const currentClaims = await this.#dependencies.tickets.consume(authorization, { nowUnixMs: Date.now(), buildId: open.buildId })
        if (!currentClaims
          || currentClaims.protocolEpoch !== collaborationProtocolEpoch
          || currentClaims.fileId !== this.#options.identity.fileId
          || currentClaims.generationId !== this.#options.identity.generationId
          || currentClaims.expiresAtUnixMs <= Date.now()) return rejectAdmission('capability')
        await this.#pruneUnauthorizedSessions()
        if (this.#sessions.has(peer.connectionId)
          || this.#connectionNonces.has(currentClaims.connectionNonce)
          || [...this.#sessions.values()].some(session => session.claims.clientId === currentClaims.clientId)) return rejectAdmission('duplicate')
        if (open.fileId !== currentClaims.fileId || open.clientId !== currentClaims.clientId) return rejectAdmission('scope')
        const currentParticipants = [...this.#sessions.values()].map(current => this.#participant(current))
        if (currentParticipants.length >= maxPresenceParticipants
          || (currentParticipants.length > 0 && !this.#presenceAdmissionFits(currentParticipants))) return rejectAdmission('capacity')
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
          replayScopeId: replayScopeId(currentClaims),
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
          if (error instanceof RoomCapacityError) return rejectAdmission('payload')
          throw error
        }
        await this.#send(peer, assigned)
        if ((await this.#verifyCurrentClaims(currentClaims)).status !== 'current') return rejectAdmission('access')
        await this.#streamProjection(peer, projectionStream)
        await this.#send(peer, plannedRoster)
        const interactions = this.#flow.roster()
        if (interactions.length) await this.#send(peer, {
          type: 'interaction.roster', envelope: this.#envelope(), interactions: interactions.map(lease => this.#flowRosterEntry(lease)),
        })
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
      void this.#serialize(async () => {
        const released = this.#flow.releaseConnection(connectionId)
        for (const lease of released) await this.#broadcastFlowReleased(lease, 'disconnecting')
        await this.#enqueuePresence(() => this.#broadcastPresence({
          type: 'presence.leave', envelope: this.#envelope(), presenceId: session.presenceId,
          subjectId: session.claims.subjectId, clientId: session.claims.clientId,
        }))
      }).catch(error => {
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
    if (message.type === 'interaction.acquire' || message.type === 'interaction.reserve'
      || message.type === 'interaction.sample' || message.type === 'interaction.release') {
      if (this.#phase !== 'accepting') return this.#roomError(session, 'draining', 'Room is draining.', 'reconnect', undefined, 250)
      return this.#enqueueMutation(() => this.#interaction(session, message))
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
    const claims = await this.#refreshClaims(session)
    if (claims.status !== 'current') {
      await this.#rejectClaims(session, claims.status, message.operation.mutationId)
      this.disconnect(session.peer.connectionId)
      return
    }
    const currentClaims = claims.claims
    if (currentClaims.role !== 'owner') { await this.#roomError(session, 'read_only', 'This file is read only.', 'none', message.operation.mutationId); return }
    const projection = this.#projection
    const lease = this.#lease
    if (!projection || !lease) throw new Error('Room authority is unavailable.')
    await this.#presenceTail
    const baseSequence = BigInt(message.operation.baseSequence)
    if (baseSequence !== projection.sequence && message.operation.flowBinding) {
      await this.#send(session.peer, { type: 'operation.rebase_required', envelope: this.#envelope(), mutationId: message.operation.mutationId, baseSequence: message.operation.baseSequence, authoritativeSequence: projection.sequence.toString(), retry: 'resync' })
      return
    }
    const flowOwner = this.#flowOwner(session)
    const flowPlan = this.#flow.operationPreflight(projection.document, flowOwner, message.operation.mutationId, message.operation.command, message.operation.flowBinding)
    if (flowPlan.status === 'denied') {
      await this.#roomError(session, 'invalid_operation', `Flow operation denied: ${flowPlan.code}.`, 'none', message.operation.mutationId)
      return
    }
    let projected: CollaborationPayload
    try { projected = baseSequence === projection.sequence ? this.#dependencies.projector.apply(projection.document, message.operation.command) : projection.document }
    catch (error) {
      this.#log('room_operation_rejected', { connectionId: session.peer.connectionId, mutationId: message.operation.mutationId, commandType: message.operation.command.type, error: errorMessage(error) })
      if (flowPlan.lease) await this.#settleFailedFlow(flowPlan.lease, message.operation.mutationId)
      await this.#roomError(session, 'invalid_operation', 'Operation is invalid.', 'none', message.operation.mutationId)
      return
    }
    if (flowPlan.lease && (!flowPlan.expectedPostLanes
      || !this.#flow.operationPostflight(projected, flowPlan.lease.leaseId, message.operation.mutationId, flowPlan.expectedPostLanes)
      || !this.#flow.reservationsCurrent(projected, flowPlan.lease.leaseId))) {
      await this.#settleFailedFlow(flowPlan.lease, message.operation.mutationId)
      await this.#roomError(session, 'invalid_operation', 'Flow operation topology does not match its reservation.', 'none', message.operation.mutationId)
      return
    }
    if (!flowPlan.lease && !this.#flow.reservationsCurrent(projected)) {
      await this.#roomError(session, 'invalid_operation', 'Operation would change a reserved flow topology.', 'none', message.operation.mutationId)
      return
    }
    const persisted = encodeSemanticCommandForPersistence(message.operation.command)
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
        projection: { documentSchemaVersion: fileSchemaVersion, document: projected },
      })
      if (result.status === 'committed') this.#projection = result.projection
    } catch (error) {
      if (flowPlan.lease) await this.#settleFailedFlow(flowPlan.lease, message.operation.mutationId)
      throw error
    }
    if (result.status === 'committed') {
      if (flowPlan.lease) await this.#settleCommittedFlow(flowPlan.lease, message.operation.mutationId)
      try { await this.#send(session.peer, { type: 'operation.ack', envelope: this.#envelope(), mutationId: message.operation.mutationId, sequence: result.operation.sequence.toString(), status: 'applied' }) }
      catch { session.peer.close(1011, 'Acknowledgement failed'); this.disconnect(session.peer.connectionId) }
      const applied: CollaborationServerMessage = { type: 'operation.applied', envelope: this.#envelope(), mutationId: message.operation.mutationId, sequence: result.operation.sequence.toString(), subjectId: session.claims.subjectId, command: message.operation.command }
      const recipients = [...this.#sessions.values()].filter(recipient => recipient.peer !== session.peer)
      await Promise.all(recipients.map(async recipient => {
        try {
          const recipientClaims = await this.#refreshClaims(recipient)
          if (recipientClaims.status !== 'current') {
            await this.#rejectClaims(recipient, recipientClaims.status).catch(error => {
              this.#log('room_error_delivery_failed', { connectionId: recipient.peer.connectionId, error: errorMessage(error) })
            })
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
      if (flowPlan.lease) await this.#settleCommittedFlow(flowPlan.lease, message.operation.mutationId)
      await this.#send(session.peer, { type: 'operation.ack', envelope: this.#envelope(), mutationId: message.operation.mutationId, sequence: result.operation.sequence.toString(), status: 'duplicate' })
      return
    }
    if (result.status === 'sequence-conflict') {
      if (flowPlan.lease) await this.#settleFailedFlow(flowPlan.lease, message.operation.mutationId)
      await this.#send(session.peer, { type: 'operation.rebase_required', envelope: this.#envelope(), mutationId: message.operation.mutationId, baseSequence: message.operation.baseSequence, authoritativeSequence: result.currentSequence.toString(), retry: 'resync' })
      return
    }
    if (result.status === 'access-revoked' || result.status === 'access-conflict') {
      if (flowPlan.lease) await this.#settleFailedFlow(flowPlan.lease, message.operation.mutationId)
      await this.#roomError(session, 'access_revoked', 'File access changed.', 'none', message.operation.mutationId)
      session.peer.close(4403, 'File access changed')
      this.disconnect(session.peer.connectionId)
      return
    }
    if (flowPlan.lease) await this.#settleFailedFlow(flowPlan.lease, message.operation.mutationId)
    await this.#roomError(
      session,
      result.status === 'mutation-conflict' ? 'mutation_id_reused' : 'internal_error',
      'Operation was rejected.',
      result.status === 'stale-fence' ? 'reconnect' : 'none',
      message.operation.mutationId,
    )
  }

  async #interaction(session: Session, message: InteractionAcquireMessage | InteractionReserveMessage | InteractionSampleMessage | InteractionReleaseMessage): Promise<void> {
    const projection = this.#projection
    if (!projection) throw new Error('Room projection is unavailable.')
    const owner = this.#flowOwner(session)
    if (message.type !== 'interaction.release') {
      const claims = await this.#refreshClaims(session)
      if (claims.status !== 'current') {
        await this.#rejectClaims(session, claims.status)
        this.disconnect(session.peer.connectionId)
        return
      }
      if (claims.claims.role !== 'owner') {
        await this.#interactionResult(session, 'acquire', 'denied', message.presentation, null, message.localClaimGeneration, 1, 'read_only')
        return
      }
      const candidateLease = 'leaseId' in message ? this.#flow.find(message.leaseId) : null
      const ownedCandidateLease = candidateLease?.owner.connectionId === session.peer.connectionId
        && candidateLease.owner.presenceId === session.presenceId
        && candidateLease.owner.subjectId === session.claims.subjectId
        && candidateLease.owner.clientId === session.claims.clientId
        && candidateLease.interactionId === message.presentation.identity.interactionId
        && candidateLease.localClaimGeneration <= message.localClaimGeneration
        ? candidateLease : null
      const presentationDenial = this.#presentationDenial(projection.document, message.presentation, ownedCandidateLease)
      if (presentationDenial) {
        await this.#interactionResult(session, message.type === 'interaction.acquire' ? 'acquire' : 'reserve', 'denied', message.presentation, 'leaseId' in message ? message.leaseId : null, message.localClaimGeneration, 'reservationGeneration' in message ? message.reservationGeneration : 1, presentationDenial)
        if (message.type !== 'interaction.acquire') {
          const invalidated = this.#flow.invalidate(owner, message.leaseId, message.presentation.identity.interactionId, message.localClaimGeneration)
          if (invalidated) await this.#broadcastFlowReleased(invalidated, 'failed')
        }
        return
      }
    }
    if (message.type === 'interaction.acquire') {
      const decision = this.#flow.acquire(projection.document, owner, message.localClaimGeneration, message.presentation, message.leaseId)
      await this.#interactionResult(session, 'acquire', decision.status, decision.lease?.presentation ?? message.presentation, decision.lease?.leaseId ?? null, decision.lease?.localClaimGeneration ?? message.localClaimGeneration, decision.lease?.reservationGeneration ?? 1, decision.denialCode)
      if (decision.lease && decision.status === 'granted') await this.#broadcastFlowSample(decision.lease)
      return
    }
    if (message.type === 'interaction.reserve') {
      const decision = this.#flow.reserve(projection.document, owner, message.leaseId, message.localClaimGeneration, message.reservationGeneration, message.targetLane, message.presentation)
      await this.#interactionResult(session, 'reserve', decision.status, decision.lease?.presentation ?? message.presentation, decision.lease?.leaseId ?? message.leaseId, decision.lease?.localClaimGeneration ?? message.localClaimGeneration, decision.lease?.reservationGeneration ?? message.reservationGeneration, decision.denialCode)
      if (decision.lease && decision.status !== 'denied') await this.#broadcastFlowSample(decision.lease)
      else if (decision.denialCode === 'invalid_topology' || decision.denialCode === 'component_slot_unverified') {
        const invalidated = this.#flow.invalidate(owner, message.leaseId, message.presentation.identity.interactionId, message.localClaimGeneration)
        if (invalidated) await this.#broadcastFlowReleased(invalidated, 'failed')
      }
      return
    }
    if (message.type === 'interaction.sample') {
      const decision = this.#flow.sample(projection.document, owner, message.leaseId, message.localClaimGeneration, message.reservationGeneration, message.presentation)
      if (decision.lease && decision.status !== 'denied') await this.#broadcastFlowSample(decision.lease)
      else await this.#interactionResult(session, 'reserve', 'denied', message.presentation, message.leaseId, message.localClaimGeneration, message.reservationGeneration, decision.denialCode)
      if (decision.status === 'denied' && decision.denialCode === 'invalid_topology') {
        const invalidated = this.#flow.invalidate(owner, message.leaseId, message.presentation.identity.interactionId, message.localClaimGeneration)
        if (invalidated) await this.#broadcastFlowReleased(invalidated, 'failed')
      }
      return
    }
    const decision = this.#flow.release(owner, message.pageId, message.leaseId, message.interactionId, message.localClaimGeneration, message.reservationGeneration, message.terminalSampleSequence, message.reason)
    await this.#send(session.peer, {
      type: 'interaction.result', envelope: this.#envelope(), pageId: decision.lease?.pageId ?? message.pageId, action: 'release', status: decision.status,
      interactionId: decision.lease?.interactionId ?? message.interactionId, leaseId: decision.lease?.leaseId ?? message.leaseId,
      localClaimGeneration: decision.lease?.localClaimGeneration ?? message.localClaimGeneration, reservationGeneration: decision.lease?.reservationGeneration ?? message.reservationGeneration,
      sampleSequence: decision.lease?.latestSequence ?? message.terminalSampleSequence, denialCode: decision.denialCode,
    })
    if (decision.status === 'released' && decision.lease) await this.#broadcastFlowReleased(decision.lease, message.reason)
  }

  #presentationDenial(document: CollaborationPayload, presentation: FlowDragPresentation, existingLease: FlowLease | null = null): FlowDragDenialCode | null {
    if (containsReservedPeerFlowInteractionId(presentation)) return 'invalid_topology'
    if (existingLease) {
      const initialFence = existingLease.presentation.fence
      const fence = presentation.fence
      if (fence.fileId !== initialFence.fileId || fence.fileRevision !== initialFence.fileRevision
        || fence.measurementRevision !== initialFence.measurementRevision || fence.documentRevision !== initialFence.documentRevision
        || fence.layoutGeneration !== initialFence.layoutGeneration || fence.pageId !== initialFence.pageId
        || fence.pageRootId !== initialFence.pageRootId) return 'invalid_topology'
    }
    const authority = createFlowTopologyAuthority(document, presentation.fence.pageId, existingLease?.presentation.fence.fileRevision)
    if (!authority) return 'missing_page'
    if (presentation.target) {
      const targetDenial = flowTargetDenial(document, {
        pageId: presentation.fence.pageId, pageRootId: presentation.fence.pageRootId,
        sourceNodeId: presentation.original.documentNodeId,
        sourceLane: { parentId: presentation.original.sourceRelationship.parentId, slot: presentation.original.sourceRelationship.slot },
        targetLane: { parentId: presentation.target.parentId, slot: presentation.target.slot },
        rawIndex: presentation.target.rawIndex, semanticIndex: presentation.target.semanticIndex, line: presentation.target.line,
      })
      if (targetDenial) return targetDenial
    }
    const storedMode = sourcePositionMode(document, presentation.original.documentNodeId)
    if (storedMode === null || (storedMode === 'flow' ? presentation.original.mode !== 'flow' : presentation.original.mode !== 'absolute')) return 'invalid_topology'
    return validateFlowDragPresentation(presentation, {
      interactionId: presentation.identity.interactionId,
      gestureGeneration: presentation.identity.gestureGeneration,
      sequence: presentation.identity.sampleSequence,
    }, presentation.fence, authority) ? null : 'invalid_topology'
  }

  #flowOwner(session: Session): FlowLeaseOwner {
    return Object.freeze({ connectionId: session.peer.connectionId, presenceId: session.presenceId, subjectId: session.claims.subjectId, clientId: session.claims.clientId })
  }

  #flowRosterEntry(lease: FlowLease): Extract<CollaborationServerMessage, { type: 'interaction.roster' }>['interactions'][number] {
    return Object.freeze({
      pageId: lease.pageId, presenceId: lease.owner.presenceId, subjectId: lease.owner.subjectId, clientId: lease.owner.clientId,
      leaseId: lease.leaseId, localClaimGeneration: lease.localClaimGeneration,
      reservationGeneration: lease.reservationGeneration, presentation: canonicalPeerFlowPresentation(lease.presentation, lease.leaseId),
    })
  }

  #interactionResult(
    session: Session,
    action: InteractionResultAction,
    status: 'granted' | 'retained' | 'released' | 'denied',
    presentation: FlowDragPresentation,
    leaseId: string | null,
    localClaimGeneration: number,
    reservationGeneration: number,
    denialCode: FlowDragDenialCode | null,
  ): Promise<void> {
    return this.#send(session.peer, {
      type: 'interaction.result', envelope: this.#envelope(), pageId: presentation.fence.pageId, action, status,
      interactionId: presentation.identity.interactionId, leaseId, localClaimGeneration, reservationGeneration,
      sampleSequence: presentation.identity.sampleSequence, denialCode,
    })
  }

  #broadcastFlowSample(lease: FlowLease): Promise<void> {
    return this.#broadcastPresence({
      type: 'interaction.sample', envelope: this.#envelope(), pageId: lease.pageId,
      presenceId: lease.owner.presenceId, subjectId: lease.owner.subjectId, clientId: lease.owner.clientId,
      leaseId: lease.leaseId, localClaimGeneration: lease.localClaimGeneration,
      reservationGeneration: lease.reservationGeneration, presentation: canonicalPeerFlowPresentation(lease.presentation, lease.leaseId),
    }, lease.owner.connectionId)
  }

  #broadcastFlowReleased(lease: FlowLease, reason: InteractionReleaseMessage['reason']): Promise<void> {
    return this.#broadcastPresence({
      type: 'interaction.released', envelope: this.#envelope(), pageId: lease.pageId,
      presenceId: lease.owner.presenceId, subjectId: lease.owner.subjectId, clientId: lease.owner.clientId,
      interactionId: peerFlowInteractionId(lease.leaseId), leaseId: lease.leaseId, localClaimGeneration: lease.localClaimGeneration,
      reservationGeneration: lease.reservationGeneration, terminalSampleSequence: lease.latestSequence, reason,
    }, lease.owner.connectionId)
  }

  async #settleCommittedFlow(lease: FlowLease, mutationId: string): Promise<void> {
    const settled = this.#flow.settleMutation(lease.leaseId, mutationId, true)
    if (settled) await this.#broadcastFlowReleased(lease, 'committed')
  }

  async #settleFailedFlow(lease: FlowLease, mutationId: string): Promise<void> {
    const settled = this.#flow.settleMutation(lease.leaseId, mutationId, true)
    if (settled) await this.#broadcastFlowReleased(lease, 'failed')
  }

  async #presence(session: Session, message: PresenceUpdateMessage): Promise<void> {
    const claims = this.#localClaimsCheck(session.claims)
    if (claims !== 'current') {
      await this.#rejectClaims(session, claims)
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
    await this.#broadcastPresence(changed, session.peer.connectionId)
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
        const claims = this.#localClaimsCheck(recipient.claims)
        if (claims !== 'current') {
          await this.#rejectClaims(recipient, claims).catch(error => {
            this.#log('room_error_delivery_failed', { connectionId: recipient.peer.connectionId, error: errorMessage(error) })
          })
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
      const claims = await this.#refreshClaims(session)
      if (claims.status === 'current') continue
      await this.#rejectClaims(session, claims.status).catch(error => {
        this.#log('room_error_delivery_failed', { connectionId: session.peer.connectionId, error: errorMessage(error) })
      })
      const stale = this.#removeSession(session.peer.connectionId)
      if (stale) {
        const released = this.#flow.releaseConnection(stale.peer.connectionId)
        for (const lease of released) await this.#broadcastFlowReleased(lease, 'disconnecting')
        removed.push(stale)
      }
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

  async #verifyCurrentClaims(expected: VerifiedRoomTicketClaims): Promise<ClaimsCheck> {
    const nowUnixMs = Date.now()
    const local = this.#localClaimsCheck(expected, nowUnixMs)
    if (local !== 'current') return Object.freeze({ status: local })
    const current = await this.#dependencies.tickets.isCurrent(expected, nowUnixMs).catch(() => false)
    return current ? Object.freeze({ status: 'current', claims: expected }) : Object.freeze({ status: 'revoked' })
  }

  #localClaimsCheck(expected: VerifiedRoomTicketClaims, nowUnixMs = Date.now()): ClaimsCheck['status'] {
    if (expected.protocolEpoch !== collaborationProtocolEpoch
      || expected.fileId !== this.#options.identity.fileId
      || expected.generationId !== this.#options.identity.generationId) return 'revoked'
    return expected.expiresAtUnixMs > nowUnixMs ? 'current' : 'refresh-required'
  }

  #refreshClaims(session: Session): Promise<ClaimsCheck> {
    return this.#verifyCurrentClaims(session.claims)
  }

  async #rejectClaims(session: Session, status: Exclude<ClaimsCheck['status'], 'current'>, mutationId?: string): Promise<void> {
    if (status === 'refresh-required') {
      await this.#roomError(session, 'draining', 'Session refresh required.', 'reconnect', mutationId, 250)
      session.peer.close(1012, 'Session refresh required')
      return
    }
    await this.#roomError(session, 'access_revoked', 'File access changed.', 'none', mutationId)
    session.peer.close(4403, 'File access changed')
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
    return { protocolEpoch: collaborationProtocolEpoch, schemaVersion: 1, room: { fileId: this.#options.identity.fileId, generationId: this.#options.identity.generationId }, fenceToken: this.#lease.fencingToken.toString() }
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
      type: 'snapshot.begin', envelope, requestId, snapshotId, documentSchemaVersion: fileSchemaVersion,
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
      type: 'snapshot.begin', envelope, requestId, snapshotId, documentSchemaVersion: fileSchemaVersion,
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
    this.#flow.invalidateAll()
    this.#sessions.clear()
    this.#connectionNonces.clear()
  }

  #log(event: string, details: Readonly<Record<string, string | number | boolean | null>> = {}): void {
    ;(this.#dependencies.logger ?? emptyLogger).event({ event, fileId: this.#options.identity.fileId, generationId: this.#options.identity.generationId, phase: this.#phase, ...details })
  }
}
