import fs from 'node:fs'
import path from 'node:path'

function simpleEntryName(name: string): string | null {
  const safeName = path.basename(name)
  const valid =
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('\0') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !path.isAbsolute(name) &&
    !path.win32.isAbsolute(name) &&
    name === safeName
  return valid ? safeName : null
}

function canonicalRoot(root: string): string | null {
  try {
    return fs.realpathSync.native(root)
  } catch {
    return null
  }
}

/** Resolve one existing direct child of an app-owned directory.
 *
 * Both the entry name and its canonical destination are checked. The canonical
 * check rejects a symlink in the owned directory that points outside it.
 */
export function resolveExistingOwnedEntry(root: string, name: string): string | null {
  const safeName = simpleEntryName(name)
  if (!safeName) return null
  const realRoot = canonicalRoot(root)
  if (!realRoot) return null
  try {
    const realEntry = fs.realpathSync.native(path.join(realRoot, safeName))
    return path.dirname(realEntry) === realRoot ? realEntry : null
  } catch {
    return null
  }
}

/** Build a destination for one direct child of an existing app-owned directory. */
export function resolveOwnedDestination(root: string, name: string): string | null {
  const safeName = simpleEntryName(name)
  if (!safeName) return null
  const realRoot = canonicalRoot(root)
  if (!realRoot) return null
  const destination = path.join(realRoot, safeName)
  try {
    // A later write or rename must never follow an entry that already redirects
    // outside the owned root. Reject every symlink, including one that currently
    // points inside the root, because its target can be replaced before the write.
    const entry = fs.lstatSync(destination)
    return entry.isSymbolicLink() || !entry.isFile() ? null : destination
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? destination : null
  }
}

/** Validate a caller-supplied absolute path as one existing direct child of `root`. */
export function resolveExistingOwnedPath(root: string, candidate: string): string | null {
  if (!path.isAbsolute(candidate)) return null
  const realRoot = canonicalRoot(root)
  if (!realRoot) return null
  try {
    const realCandidate = fs.realpathSync.native(candidate)
    return path.dirname(realCandidate) === realRoot ? realCandidate : null
  } catch {
    return null
  }
}
