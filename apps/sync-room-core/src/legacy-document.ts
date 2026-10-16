import { validateHostedFileDocument } from '@canvas/cloud-document'
import { canonicalCollaborationJson } from '@canvas/database/collaboration'
import { fileSchemaVersion } from '@canvas/repo-engine/file-document'
import type { CollaborationLegacyDocumentMigrationResult, CollaborationLegacyDocumentValidationResult, CollaborationPayload } from '@canvas/database/collaboration'

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The live-room cutover upgrades schemas 7 through 10 directly and schema 6 only after inline assets are absent. */
export function migrateLegacyCollaborationDocument(document: CollaborationPayload, targetSchemaVersion: number): CollaborationLegacyDocumentMigrationResult {
  if (![6, 7, 8, 9, 10, 11].includes(Number(document.schemaVersion)) || targetSchemaVersion !== fileSchemaVersion) return Object.freeze({ status: 'unsupported', reason: 'schema-version' })
  if (document.schemaVersion === 6 && Object.hasOwn(document, 'assets')) {
    if (!record(document.assets)) return Object.freeze({ status: 'unsupported', reason: 'document-invalid' })
    if (Object.keys(document.assets).length > 0) return Object.freeze({ status: 'unsupported', reason: 'asset-externalization' })
  }
  try {
    const migrated = validateHostedFileDocument(document)
    return Object.freeze({ status: 'migrated', document: migrated as unknown as CollaborationPayload })
  } catch {
    return Object.freeze({ status: 'unsupported', reason: 'document-invalid' })
  }
}

/** Validates every cold seed and independently derives the only permitted legacy transform. */
export function validateLegacyCollaborationDocument(input: Readonly<{
  sourceDocument: CollaborationPayload
  document: CollaborationPayload
  targetSchemaVersion: number
}>): CollaborationLegacyDocumentValidationResult {
  try {
    const expected = validateHostedFileDocument(input.sourceDocument)
    const validated = validateHostedFileDocument(input.document)
    if (expected.schemaVersion !== input.targetSchemaVersion || validated.schemaVersion !== input.targetSchemaVersion) {
      return Object.freeze({ status: 'invalid', reason: 'schema-version' })
    }
    if (expected.fileId !== input.sourceDocument.fileId || validated.fileId !== input.sourceDocument.fileId) {
      return Object.freeze({ status: 'invalid', reason: 'file-identity' })
    }
    const expectedJson = canonicalCollaborationJson(expected as unknown as CollaborationPayload)
    const validatedJson = canonicalCollaborationJson(validated as unknown as CollaborationPayload)
    const candidateJson = canonicalCollaborationJson(input.document)
    if (expectedJson !== validatedJson || candidateJson !== validatedJson) {
      return Object.freeze({ status: 'invalid', reason: 'document-invalid' })
    }
    return Object.freeze({ status: 'valid' })
  } catch {
    return Object.freeze({ status: 'invalid', reason: 'document-invalid' })
  }
}
