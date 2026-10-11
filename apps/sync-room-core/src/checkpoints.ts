import { createHash } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalCollaborationJson } from '@canvas/database/collaboration'
import type { CollaborationProjection } from '@canvas/database/collaboration'
import type { CheckpointArtifact, CheckpointStore } from './contracts.js'

export class FileCheckpointStore implements CheckpointStore {
  readonly #directory: string

  constructor(directory: string) {
    if (!directory) throw new Error('Checkpoint directory is required.')
    this.#directory = directory
  }

  async write(projection: CollaborationProjection): Promise<CheckpointArtifact> {
    const content = Buffer.from(canonicalCollaborationJson(projection.document), 'utf8')
    const objectDigest = createHash('sha256').update(content).digest('hex')
    if (objectDigest !== projection.documentDigest) throw new Error('Projection digest changed before checkpoint.')
    const objectKey = `${projection.fileId}/${projection.generationId}/${projection.sequence}.json`
    const target = join(this.#directory, ...objectKey.split('/'))
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    await mkdir(join(this.#directory, projection.fileId, projection.generationId), { recursive: true })
    try {
      await writeFile(temporary, content, { flag: 'wx' })
      try {
        await link(temporary, target)
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
        const existing = await readFile(target)
        if (!existing.equals(content)) throw new Error('Checkpoint object key already contains different bytes.')
      }
    } catch (error) {
      try {
        await unlink(temporary)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Checkpoint write and temporary cleanup both failed.')
      }
      throw error
    }
    await unlink(temporary)
    return Object.freeze({
      objectKey,
      objectDigest,
      documentDigest: projection.documentDigest,
      compressedBytes: BigInt(content.byteLength),
    })
  }
}
