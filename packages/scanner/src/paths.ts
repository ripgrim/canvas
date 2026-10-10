import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

export async function confined(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) throw new Error('Invalid project path')
  const parts = relative.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Invalid project path')
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    try {
      const entry = await lstat(current)
      if (entry.isSymbolicLink()) throw new Error('Symbolic links are not supported for source scans')
      const actual = await realpath(current)
      const within = path.relative(root, actual)
      if (within.startsWith('..') || path.isAbsolute(within)) throw new Error('Path is outside the repository grant')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return current
}
