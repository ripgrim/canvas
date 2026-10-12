import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeSemanticCommandForPersistence } from '@canvas/sync-protocol'
import type { CollaborationStoreScope } from '@canvas/sync-client'
import { createDesktopCollaborationStore, desktopCollaborationClientId } from '../src/main/collaboration-store'

const roots: string[] = []
const scope = (accountId: string): CollaborationStoreScope => ({
  accountId,
  clientId: 'desktop-test',
  fileId: '11111111-2222-4333-8444-555555555555',
  documentSchemaVersion: 6,
  protocolEpoch: 3,
})
const mutation = (mutationId: string) => ({
  mutationId,
  baseSequence: null,
  command: encodeSemanticCommandForPersistence({ type: 'node.rename', nodeId: 'frame', name: mutationId }),
  status: 'pending' as const,
  replayScopeId: 'a'.repeat(64),
  flowBinding: null,
})

afterEach(async () => {
  while (roots.length) {
    const target = resolve(roots.pop()!)
    expect(relative(resolve(tmpdir()), target).startsWith('canvas-desktop-collaboration-')).toBe(true)
    await rm(target, { recursive: true, force: true })
  }
})

describe('desktop collaboration persistence', () => {
  it('[CLOUD-SYNC-CACHE-001] persists queued work by account and purges only the signed-out account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-desktop-collaboration-'))
    roots.push(root)
    const first = scope('account-a')
    const second = scope('account-b')
    const store = createDesktopCollaborationStore(join(root, 'cache'))

    await store.enqueue(first, mutation('first-change'))
    await store.enqueue(second, mutation('second-change'))
    const reopened = createDesktopCollaborationStore(join(root, 'cache'))
    expect(await reopened.load(first)).toMatchObject({ scope: first, pending: [{ mutationId: 'first-change' }] })
    expect(await reopened.load(second)).toMatchObject({ scope: second, pending: [{ mutationId: 'second-change' }] })

    await reopened.purgeAccount('account-a')
    expect(await reopened.load(first)).toBeNull()
    expect(await reopened.load(second)).toMatchObject({ pending: [{ mutationId: 'second-change' }] })
    expect((await readdir(join(root, 'cache'))).every(name => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true)
  })

  it('[CLOUD-SYNC-CACHE-001] reuses only a valid stable desktop identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-desktop-collaboration-'))
    roots.push(root)
    const target = join(root, 'client-id')
    const first = await desktopCollaborationClientId(target)
    expect(first).toMatch(/^desktop-[0-9a-f-]{36}$/)
    expect(await desktopCollaborationClientId(target)).toBe(first)

    await writeFile(target, 'invalid-client-id', 'utf8')
    const repaired = await desktopCollaborationClientId(target)
    expect(repaired).not.toBe(first)
    expect((await readFile(target, 'utf8')).trim()).toBe(repaired)
  })
})
