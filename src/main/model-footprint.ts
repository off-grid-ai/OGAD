import fs from 'node:fs'

/** Combined size of model files in MB, skipping missing or empty paths. A resident model's
 *  weights are its files (mmap), so this is the base of every engine's memory footprint. */
export function filesMB(paths: readonly (string | null | undefined)[]): number {
  let bytes = 0
  for (const file of paths) {
    if (!file) continue
    try {
      bytes += fs.statSync(file).size
    } catch {
      /* not on disk */
    }
  }
  return bytes / 1024 ** 2
}
