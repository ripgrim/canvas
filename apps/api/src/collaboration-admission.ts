import { randomUUID } from 'node:crypto'
import type { CollaborationPersistence, FileAccessAuthorization } from '@canvas/database'
import { collaborationProtocolEpoch, normalizeCollaborationDisplayName, validateCollaborationIdentity } from '@canvas/sync-protocol'

export const collaborationAdmissionProtocolEpoch = collaborationProtocolEpoch

export type CollaborationAdmissionRole = 'owner' | 'viewer'
export type CollaborationAdmissionGenerationStatus = 'active' | 'candidate'

export type CollaborationAdmissionClaims = Readonly<{
  subjectId: string
  displayName: string
  avatarUrl: string | null
  fileId: string
  role: CollaborationAdmissionRole
  generationId: string
  protocolEpoch: typeof collaborationAdmissionProtocolEpoch
  accessEpoch: string
}>

export type CollaborationAdmissionGeneration = Readonly<{
  generationId: string
  status: CollaborationAdmissionGenerationStatus
}>

export interface CollaborationAdmissionAuthority {
  resolveGeneration(input: CollaborationGenerationRequest): Promise<CollaborationAdmissionGeneration>
}

export type CollaborationGenerationRequest = Readonly<{
  fileId: string
  protocolEpoch: typeof collaborationAdmissionProtocolEpoch
}>

export type CollaborationAdmissionResponse = Readonly<{
  claims: CollaborationAdmissionClaims
  generation: Readonly<{ status: CollaborationAdmissionGenerationStatus }>
  compatibility: Readonly<{
    status: 'compatible'
    protocolEpoch: typeof collaborationAdmissionProtocolEpoch
    buildId: string
  }>
}>

const canonicalSequencePattern = /^(?:0|[1-9][0-9]{0,18})$/
const maxPostgresSignedInt64 = 9_223_372_036_854_775_807n
const subjectPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function collaborationAdmissionResponse(
  access: FileAccessAuthorization,
  generation: CollaborationAdmissionGeneration,
  supportedBuildId: string,
  identityInput: Readonly<{ name: string; image: string | null }>,
): CollaborationAdmissionResponse {
  if (!subjectPattern.test(access.subjectUserId)) throw new Error('File access subject is invalid.')
  if (!uuidPattern.test(access.fileId)) throw new Error('File access identity is invalid.')
  if (access.role !== 'owner' && access.role !== 'viewer') throw new Error('File access role is invalid.')
  if (!uuidPattern.test(generation.generationId)) throw new Error('Collaboration generation identity is invalid.')
  if (generation.status !== 'active' && generation.status !== 'candidate') throw new Error('Collaboration generation status is invalid.')
  const accessEpoch = access.accessEpoch.toString()
  if (!canonicalSequencePattern.test(accessEpoch) || BigInt(accessEpoch) > maxPostgresSignedInt64) {
    throw new Error('File access epoch is outside the collaboration protocol range.')
  }
  const identity = validateCollaborationIdentity({
    displayName: normalizeCollaborationDisplayName(identityInput.name),
    avatarUrl: identityInput.image,
  })
  return Object.freeze({
    claims: Object.freeze({
      subjectId: access.subjectUserId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      fileId: access.fileId,
      role: access.role,
      generationId: generation.generationId,
      protocolEpoch: collaborationAdmissionProtocolEpoch,
      accessEpoch,
    }),
    generation: Object.freeze({ status: generation.status }),
    compatibility: Object.freeze({
      status: 'compatible',
      protocolEpoch: collaborationAdmissionProtocolEpoch,
      buildId: supportedBuildId,
    }),
  })
}

export function createPostgresCollaborationAdmissionAuthority(
  persistence: Pick<CollaborationPersistence, 'resolveAdmissionGeneration'>,
  createGenerationId: () => string = randomUUID,
  candidateTtlMs = 30_000,
): CollaborationAdmissionAuthority {
  return Object.freeze({
    async resolveGeneration(input: CollaborationGenerationRequest) {
      const generationId = createGenerationId()
      if (!uuidPattern.test(generationId)) throw new Error('Generated collaboration identity is invalid.')
      const resolved = await persistence.resolveAdmissionGeneration({
        fileId: input.fileId,
        generationId,
        protocolEpoch: input.protocolEpoch,
        candidateTtlMs,
      })
      if (!uuidPattern.test(resolved.generationId) || (resolved.status !== 'active' && resolved.status !== 'candidate')) throw new Error('Resolved collaboration generation is invalid.')
      return Object.freeze({ generationId: resolved.generationId, status: resolved.status })
    },
  })
}
