import type { CollaborationJson, CollaborationPayload } from '@canvas/database/collaboration'
import { applyHostedFileCommand, validateFileCommand } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { SemanticFileCommand } from '@canvas/sync-protocol'
import type { CollaborationProjector } from './contracts.js'
import { hostedComponentCatalog } from '@canvas/repo-engine/hosted-catalog'

const trustedComponents = hostedComponentCatalog()

/** The room delegates both command validation and mutation semantics to repo-engine. */
export function createSemanticProjector(): CollaborationProjector {
  return Object.freeze({
    apply(document: CollaborationPayload, command: SemanticFileCommand) {
      const validated = validateFileCommand(command)
      const next = applyHostedFileCommand(document as unknown as FileDocument, validated, trustedComponents)
      return next as unknown as Readonly<Record<string, CollaborationJson>>
    },
  })
}
