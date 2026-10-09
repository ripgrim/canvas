import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'

export async function resolveFixtureGrant(options: { defaultRoot: string; argv: readonly string[]; smokeEnabled: boolean; packaged: boolean }): Promise<string> {
  const overrides = options.argv.filter((argument) => argument.startsWith('--smoke-fixture-root='))
  if (overrides.length === 0) return realpath(options.defaultRoot)
  if (overrides.length !== 1 || !options.smokeEnabled || options.packaged) throw new Error('The smoke fixture override is not enabled.')
  const requested = overrides[0]!.slice('--smoke-fixture-root='.length)
  if (!isAbsolute(requested)) throw new Error('The smoke fixture must use an absolute path.')
  const root = await realpath(requested)
  const temporaryRoot = await realpath(tmpdir())
  const contained = relative(temporaryRoot, root)
  if (!contained || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained) || !(await stat(root)).isDirectory()) throw new Error('The smoke fixture must be a dedicated temporary directory.')
  return root
}
