import fs from 'node:fs'
import path from 'node:path'

/** Record custom downloads so a shared folder never grants ownership by extension. */
export function recordManagedStorageFile(directory: string, name: string): void {
  const target = path.join(directory, 'managed-storage-files.json')
  let names: string[] = []
  try {
    names = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    /* First custom asset. */
  }
  const temp = `${target}.tmp`
  fs.writeFileSync(temp, JSON.stringify([...new Set([...names, name])]))
  fs.renameSync(temp, target)
}
