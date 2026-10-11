import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorFile, EditorProjectApi } from '../../capabilities'
import { homeStore } from './store'

afterEach(() => homeStore.dispose())

const capabilities = {
  runtime: 'browser' as const,
  openLabel: 'Open file',
  files: {
    list: { available: true, reason: '' },
    create: { available: true, reason: '' },
    open: { available: true, reason: '' },
  },
  sourceWrites: { available: false, reason: '' },
  localRepository: { available: false, reason: '' },
  hostedExecution: { available: false, reason: '' },
  git: { available: false, reason: '' },
  mcp: { available: false, reason: '' },
  hostedProjects: { available: false, reason: '' },
}

function api(overrides: Partial<EditorProjectApi>): EditorProjectApi {
  return { capabilities, ...overrides } as EditorProjectApi
}

const file = (id: string, name = id): EditorFile => ({ id, name, location: 'browser' })

describe('home store', () => {
  it('shows an empty files home when file listing is unavailable', () => {
    homeStore.configure(undefined)
    homeStore.start()
    expect(homeStore.getSnapshot()).toMatchObject({ files: [], status: { kind: 'ready' } })
    expect(homeStore.getSnapshot()).not.toHaveProperty('screen')
  })

  it('publishes listed files only after the current list command completes', async () => {
    const listFiles = vi.fn(async () => [file('one', 'Quiet footer')])
    homeStore.configure(api({ listFiles }))
    homeStore.start()
    expect(homeStore.getSnapshot().status.kind).toBe('starting')
    await vi.waitFor(() => expect(homeStore.getSnapshot()).toMatchObject({ files: [{ id: 'one' }], status: { kind: 'ready' } }))
    expect(listFiles).toHaveBeenCalledOnce()
  })

  it('puts a newly created file first and returns its persistent id', async () => {
    const createFile = vi.fn(async () => file('new-file', 'Untitled 1'))
    homeStore.configure(api({ createFile }))
    const id = await homeStore.create()
    expect(id).toBe('new-file')
    expect(homeStore.getSnapshot()).toMatchObject({ files: [{ id: 'new-file' }], status: { kind: 'ready' } })
  })

  it('coalesces repeated create commands while the first create is pending', async () => {
    let resolveCreate!: (created: EditorFile) => void
    const pending = new Promise<EditorFile>(resolve => { resolveCreate = resolve })
    const createFile = vi.fn(() => pending)
    homeStore.configure(api({ createFile }))

    const first = homeStore.create()
    const second = homeStore.create()
    expect(createFile).toHaveBeenCalledOnce()
    expect(homeStore.getSnapshot().status.kind).toBe('creating')

    resolveCreate(file('new-file', 'Untitled 1'))
    await expect(first).resolves.toBe('new-file')
    await expect(second).resolves.toBe('new-file')
    expect(homeStore.getSnapshot().files).toEqual([file('new-file', 'Untitled 1')])
  })

  it('keeps list and create failures separate and retryable', async () => {
    const listFiles = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce([file('retry')])
    homeStore.configure(api({ listFiles }))
    homeStore.start()
    await vi.waitFor(() => expect(homeStore.getSnapshot()).toMatchObject({ status: { kind: 'error', operation: 'list', message: 'Offline' } }))
    expect(homeStore.getSnapshot().status).toMatchObject({ reference: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    homeStore.retry()
    await vi.waitFor(() => expect(homeStore.getSnapshot()).toMatchObject({ files: [{ id: 'retry' }], status: { kind: 'ready' } }))

    homeStore.configure(api({ createFile: vi.fn(async () => { throw new Error('Read only') }) }))
    expect(await homeStore.create()).toBeNull()
    expect(homeStore.getSnapshot()).toMatchObject({ status: { kind: 'error', operation: 'create', message: 'Read only' } })
  })

  it('ERROR-VISIBILITY-001 preserves a server request id as the visible error reference', async () => {
    const failure = Object.assign(new Error('Request could not be completed.'), { requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', code: 'internal_error' })
    homeStore.configure(api({ createFile: vi.fn(async () => { throw failure }) }))
    expect(await homeStore.create()).toBeNull()
    expect(homeStore.getSnapshot().status).toEqual({ kind: 'error', operation: 'create', message: failure.message, reference: failure.requestId })
  })

  it('ignores a stale list result after the adapter changes', async () => {
    let resolveOld!: (files: readonly EditorFile[]) => void
    const oldFiles = new Promise<readonly EditorFile[]>(resolve => { resolveOld = resolve })
    homeStore.configure(api({ listFiles: () => oldFiles }))
    homeStore.start()
    homeStore.configure(api({ listFiles: async () => [file('current')] }))
    homeStore.start()
    await vi.waitFor(() => expect(homeStore.getSnapshot().files).toEqual([file('current')]))
    resolveOld([file('stale')])
    await Promise.resolve()
    expect(homeStore.getSnapshot().files).toEqual([file('current')])
  })
})
