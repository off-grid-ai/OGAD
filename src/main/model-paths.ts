import fs from 'node:fs'
import path from 'node:path'
import { dataDir, modelsDir } from './runtime-env'
import { readModelScanFolders } from './model-storage-choice'

/** Read from the download folder first, then folders the user added. Writes use modelsDir(). */
export function modelReadDirectories(): string[] {
  return [
    ...new Set([modelsDir(), ...readModelScanFolders(dataDir())].map((dir) => path.resolve(dir)))
  ]
}

/** Resolve a relative model asset without allowing traversal or links outside a selected root. */
export function resolveModelAsset(name: string, roots = modelReadDirectories()): string | null {
  if (!name || name.includes('\0') || path.isAbsolute(name) || path.win32.isAbsolute(name))
    return null
  if (name.split(/[\\/]/).some((part) => part === '..')) return null
  for (const root of roots) {
    try {
      const realRoot = fs.realpathSync(root)
      const file = fs.realpathSync(path.join(realRoot, name))
      const relative = path.relative(realRoot, file)
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
      return file
    } catch {
      // A disconnected drive must not prevent reading another folder.
    }
  }
  return null
}

/** Direct entries accepted by the existing modality classifiers, in folder priority order. */
export function modelEntryNames(): string[] {
  return [
    ...new Set(
      modelReadDirectories().flatMap((root) => {
        try {
          return fs.readdirSync(root)
        } catch {
          return []
        }
      })
    )
  ]
}

/** A package must be complete within one folder; do not combine different installations. */
export function resolveModelPackage(
  names: string[],
  roots = modelReadDirectories()
): string | null {
  if (!names.length) return null
  for (const root of roots) {
    if (
      names.every((name) => {
        const asset = resolveModelAsset(name, [root])
        return asset && fs.statSync(asset).isFile() && fs.statSync(asset).size > 0
      })
    )
      return fs.realpathSync(root)
  }
  return null
}

/** Persisted imports can use absolute paths; managed names use the shared folder lookup. */
export function resolveModelReference(name: string, roots = modelReadDirectories()): string {
  if (path.isAbsolute(name)) {
    try {
      return fs.realpathSync(name)
    } catch {
      return name
    }
  }
  return resolveModelAsset(name, roots) ?? path.join(roots[0]!, name)
}

/** Metadata writes stay in the chosen folder; reads also support folders left in place. */
export function modelMetadataFile(name: string, roots = modelReadDirectories()): string {
  return resolveModelAsset(name, roots) ?? path.join(roots[0]!, name)
}

/** Transformers packages must be complete in a single root, including their tokenizer. */
export function resolveTransformersPackage(
  id: string,
  weight: string,
  roots = modelReadDirectories()
): string | null {
  return resolveModelPackage(
    ['config.json', 'tokenizer.json', 'tokenizer_config.json', `onnx/${weight}`],
    roots.flatMap((root) => [path.join(root, id), path.join(root, '.cache', id)])
  )
}

/** URL-indexed speech caches are usable only when every required asset is intact. */
export function resolveIndexedModelPackage(
  assets: Array<{ name: string; url: string }>,
  roots: string[]
): string | null {
  for (const root of roots) {
    try {
      const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'))
      if (
        assets.every(({ name, url }) => {
          const file = resolveModelAsset(name, [root])
          const record = index[name]
          return (
            file &&
            record?.url === url &&
            record.bytes > 0 &&
            fs.statSync(file).size === record.bytes
          )
        })
      )
        return fs.realpathSync(root)
    } catch {
      // Missing or incomplete caches cannot satisfy a read.
    }
  }
  return null
}
