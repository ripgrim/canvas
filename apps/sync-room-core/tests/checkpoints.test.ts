import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileCheckpointStore } from '../src/checkpoints.js'
import { projection } from './support.js'

describe('file checkpoint store', () => {
  let directory: string | undefined
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined })

  it('publishes immutable canonical bytes under a generation-scoped key', async () => {
    directory = await mkdtemp(join(tmpdir(), 'canvas-room-checkpoint-'))
    const current = projection()
    const artifact = await new FileCheckpointStore(directory).write(current)
    expect(artifact).toMatchObject({ documentDigest: current.documentDigest, objectDigest: current.documentDigest })
    const stored = await readFile(join(directory, ...artifact.objectKey.split('/')), 'utf8')
    expect(JSON.parse(stored)).toEqual(current.document)
  })
})
