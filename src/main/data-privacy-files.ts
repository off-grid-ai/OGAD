import fs from 'node:fs'
import path from 'node:path'

export const isMissingPath = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

export function dirSize(directory: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  try {
    for (const name of fs.readdirSync(directory)) {
      const item = path.join(directory, name)
      try {
        const stat = fs.statSync(item)
        if (stat.isDirectory()) {
          const child = dirSize(item)
          bytes += child.bytes
          files += child.files
        } else {
          bytes += stat.size
          files += 1
        }
      } catch (error) {
        if (!isMissingPath(error)) throw error
      }
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error
  }
  return { bytes, files }
}

export function clearDirs(...directories: string[]): void {
  for (const directory of directories) {
    try {
      for (const name of fs.readdirSync(directory)) {
        fs.rmSync(path.join(directory, name), { recursive: true, force: true })
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error
    }
  }
}

export function clearDirsOlderThan(days: number, ...directories: string[]): void {
  const cutoff = Date.now() - days * 86_400_000
  for (const directory of directories) {
    try {
      for (const name of fs.readdirSync(directory)) {
        const item = path.join(directory, name)
        if (fs.statSync(item).mtimeMs < cutoff) fs.rmSync(item, { recursive: true, force: true })
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error
    }
  }
}

export function clearFiles(...files: string[]): void {
  for (const file of files) fs.rmSync(file, { force: true })
}
