import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledAssetResponse } from '../src/main/assets'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('bundled app protocol', () => {
  it('serves only known bundled assets, with restrictive response headers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'design-editor-assets-'))
    directories.push(directory)
    const root = join(directory, 'renderer')
    await mkdir(root)
    await writeFile(join(root, 'index.html'), '<title>Local editor</title>')
    await writeFile(join(directory, 'private.txt'), 'must not be served')
    const response = await bundledAssetResponse(new Request('design-editor://app/'), root, "default-src 'none'")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<title>Local editor</title>')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
    for (const url of ['design-editor://other/', 'design-editor://app/%2e%2e%2fprivate.txt', 'design-editor://app/%2e%2e%5cprivate.txt', 'design-editor://app/?file=private.txt', 'https://app/']) {
      const blocked = await bundledAssetResponse(new Request(url), root, "default-src 'none'")
      expect(blocked.status).toBe(403)
      expect(await blocked.text()).not.toContain('must not be served')
    }
    expect((await bundledAssetResponse(new Request('design-editor://app/', { method: 'POST' }), root, "default-src 'none'")).status).toBe(403)
  })

  it('denies a directory junction that points outside bundled assets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'design-editor-assets-'))
    directories.push(directory)
    const root = join(directory, 'renderer')
    const outside = join(directory, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.html'), 'private fixture bytes')
    await symlink(outside, join(root, 'escape'), 'junction')
    const response = await bundledAssetResponse(new Request('design-editor://app/escape/secret.html'), root, "default-src 'none'")
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('private fixture bytes')
  })
})
