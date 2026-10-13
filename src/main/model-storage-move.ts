import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { speechCapabilities } from '@offgrid/executorch-speech'
import {
  addModelScanFolder,
  removeModelScanFolder,
  readModelScanFolders,
  readPendingModelCleanup,
  readModelStorageChoice,
  saveModelStorageChoice,
  type PendingModelCleanup
} from './model-storage-choice'
import { resolveModelReference } from './model-paths'
import { configureRuntime } from './runtime-env'
import {
  beginStorageMove,
  storageDownloadsActive,
  STORAGE_DOWNLOAD_ERROR
} from './model-storage-guard'
import { sha256File } from './models/download-verify'

export const MOVE_SAFETY_BYTES = 256 * 1024 * 1024
const metadata = [
  'active-model.json',
  'llm-settings.json',
  'active-modalities.json',
  'downloaded-models.json',
  'local-models.json',
  'downloads.json',
  'remote-vision-server.json',
  'managed-storage-files.json',
  '.cache/executorch-speech/index.json'
]
export interface OwnedModelFile {
  name: string
  sha256?: string
}
export interface MoveDependencies {
  ownedFiles: OwnedModelFile[]
  loadOwnedFiles?: () => Promise<OwnedModelFile[]>
  downloadsActive?: () => boolean
  freeBytes?: (directory: string) => Promise<number>
}

function safeName(name: string): boolean {
  return (
    !!name &&
    !name.includes('\0') &&
    !path.isAbsolute(name) &&
    !path.win32.isAbsolute(name) &&
    !name.split(/[\\/]/).some((part) => part === '..' || part === '')
  )
}

// Never traverse links in parent directories. Leaf links are copied only when requested.
function regularFile(root: string, name: string, allowLinks = false): fs.Stats | null {
  if (!safeName(name) || fs.lstatSync(root).isSymbolicLink()) return null
  let current = root
  for (const part of name.split(/[\\/]/)) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() && !(allowLinks && current === path.join(root, name))) return null
  }
  const stat = fs.lstatSync(current)
  return (stat.isFile() && (allowLinks || stat.nlink === 1)) ||
    (allowLinks && stat.isSymbolicLink())
    ? stat
    : null
}

export function ownedStorageFiles(source: string, catalog: OwnedModelFile[]): OwnedModelFile[] {
  const files = new Map(catalog.map((file) => [file.name, file]))
  for (const name of metadata) files.set(name, { name })
  addRegisteredFiles(source, files)
  // ExecuTorch writes URL-derived assets plus resumable .download files.
  for (const voice of speechCapabilities.voices) {
    for (const [asset, url] of Object.entries(voice.assets)) {
      if (typeof url !== 'string') continue
      const id = createHash('sha256').update(url).digest('hex').slice(0, 12)
      const name = `.cache/executorch-speech/${asset}-${id}-${path.basename(new URL(url).pathname)}`
      files.set(name, { name })
      files.set(`${name}.download`, { name: `${name}.download` })
    }
  }
  // Runtime caches use exact package paths, not the entire shared .cache folder.
  for (const repo of ['Xenova/all-MiniLM-L6-v2', 'onnx-community/Kokoro-82M-v1.0-ONNX']) {
    for (const prefix of [repo, `.cache/${repo}`]) {
      for (const name of [
        'config.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'special_tokens_map.json',
        'generation_config.json',
        'vocab.txt',
        'vocab.json',
        'merges.txt',
        'onnx/model.onnx',
        'onnx/model_quantized.onnx',
        'onnx/model_fp16.onnx',
        'onnx/model.onnx_data'
      ]) {
        files.set(`${prefix}/${name}`, { name: `${prefix}/${name}` })
      }
    }
  }
  const speechIndex = '.cache/executorch-speech/index.json'
  files.set(speechIndex, { name: speechIndex })
  try {
    const index = JSON.parse(fs.readFileSync(path.join(source, speechIndex), 'utf8'))
    for (const name of Object.keys(index)) {
      const relative = `.cache/executorch-speech/${name}`
      files.set(relative, { name: relative })
    }
  } catch {
    /* Only indexed speech assets belong to this app. */
  }
  try {
    const names = JSON.parse(
      fs.readFileSync(path.join(source, 'managed-storage-files.json'), 'utf8')
    )
    for (const name of names) if (typeof name === 'string') files.set(name, { name })
  } catch {
    /* Unregistered custom assets stay in place. */
  }
  for (const file of [...files.values()]) {
    if (!metadata.includes(file.name)) files.set(`${file.name}.part`, { name: `${file.name}.part` })
  }
  return [...files.values()].filter((file) => safeName(file.name))
}

function addRegisteredFiles(source: string, files: Map<string, OwnedModelFile>): void {
  for (const registry of ['downloaded-models.json', 'local-models.json']) {
    try {
      const entries = JSON.parse(fs.readFileSync(path.join(source, registry), 'utf8'))
      for (const entry of entries) {
        for (const file of entry.files ?? [entry.primary, entry.mmproj].filter(Boolean)) {
          const name = typeof file === 'string' ? file : file.name
          if (typeof name === 'string')
            files.set(name, { name, sha256: files.get(name)?.sha256 ?? file.sha256 })
        }
      }
    } catch {
      /* Missing or invalid registry grants no ownership. */
    }
  }
  // Selection metadata is also a registry of managed primary and draft files.
  for (const [registry, keys] of [
    ['active-model.json', ['primary', 'mmproj']],
    ['llm-settings.json', ['draftModel']]
  ] as const) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(source, registry), 'utf8'))
      for (const key of keys) {
        const name = entry[key]
        if (typeof name === 'string' && safeName(name)) files.set(name, files.get(name) ?? { name })
      }
    } catch {
      /* Invalid selections do not grant ownership. */
    }
  }
}

function unknownCount(root: string, owned: Set<string>, prefix = ''): number {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).reduce((count, entry) => {
    const name = path.join(prefix, entry.name)
    if (owned.has(name)) return count
    if (entry.isDirectory() && [...owned].some((file) => file.startsWith(`${name}${path.sep}`)))
      return count + unknownCount(root, owned, name)
    return count + 1
  }, 0)
}

/** Copy and verify, then save the choice and cleanup journal in one atomic rename.
 * Source files stay available to loaded processes until the next start. */
export async function moveModelStorage(
  profile: string,
  source: string,
  destination: string,
  deps: MoveDependencies
): Promise<{ moved: number; unknownEntriesLeft: number }> {
  const release = beginStorageMove()
  const active = (): boolean => storageDownloadsActive() || !!deps.downloadsActive?.()
  const assertIdle = (): void => {
    if (active()) throw new Error(STORAGE_DOWNLOAD_ERROR)
  }
  try {
    assertIdle() // Confirmation boundary, before planning or any writes.
    const from = fs.realpathSync(source)
    const to = fs.realpathSync(destination)
    if (from === to) return { moved: 0, unknownEntriesLeft: 0 }
    if (to.startsWith(`${from}${path.sep}`) || from.startsWith(`${to}${path.sep}`))
      throw new Error('Choose a folder outside the current model folder.')
    if (fs.lstatSync(source).isSymbolicLink())
      throw new Error('The current model folder is a link. Leave its files in place.')
    const ownedFiles = deps.loadOwnedFiles ? await deps.loadOwnedFiles() : deps.ownedFiles
    const registeredFiles = new Map<string, OwnedModelFile>()
    addRegisteredFiles(from, registeredFiles)
    const files = ownedStorageFiles(from, ownedFiles).flatMap((file) => {
      try {
        const stat = regularFile(from, file.name, true)
        // A catalog name alone does not claim an unrelated link in a shared folder.
        if (stat?.isSymbolicLink() && !registeredFiles.has(file.name)) return []
        const linkTarget = stat?.isSymbolicLink()
          ? fs.realpathSync(path.join(from, file.name))
          : undefined
        if (linkTarget && !fs.statSync(linkTarget).isFile()) return []
        return stat ? [{ ...file, size: stat.size, sourceStat: stat, linkTarget }] : []
      } catch {
        return []
      }
    })
    const names = new Set(files.map((file) => file.name))
    const unknownEntriesLeft = unknownCount(from, names)
    for (const file of files) {
      const target = path.join(to, file.name)
      if (fs.existsSync(target))
        throw new Error(`The new folder already contains ${file.name}. Choose another folder.`)
      // Existing destination parents must not redirect writes through links.
      let parent = path.dirname(target)
      while (parent !== to) {
        if (
          fs.existsSync(parent) &&
          (fs.lstatSync(parent).isSymbolicLink() || !fs.statSync(parent).isDirectory())
        )
          throw new Error('The new folder contains an unsafe model path.')
        parent = path.dirname(parent)
      }
    }
    const total = files.reduce((sum, file) => sum + file.size, 0)
    const margin = Math.max(MOVE_SAFETY_BYTES, Math.ceil(total * 0.05))
    const free = await (
      deps.freeBytes ??
      (async (dir) => {
        const stat = await fs.promises.statfs(dir)
        return stat.bavail * stat.bsize
      })
    )(to)
    if (free < total + margin)
      throw new Error(
        `Not enough free space in the new folder. Need ${total + margin} bytes, including the safety margin.`
      )
    assertIdle() // Re-check after the asynchronous volume probe, immediately before copying.
    const promoted: string[] = []
    const pending: PendingModelCleanup[] = []
    try {
      for (const file of files.filter((entry) => !metadata.includes(entry.name))) {
        const target = path.join(to, file.name)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (file.linkTarget) {
          fs.symlinkSync(file.linkTarget, target)
        } else {
          await fs.promises.copyFile(path.join(from, file.name), target, fs.constants.COPYFILE_EXCL)
        }
        promoted.push(target)
        const hash = await verifyCopy(from, target, {
          ...file,
          size: file.linkTarget ? fs.statSync(file.linkTarget).size : file.size
        })
        assertUnchanged(from, file.name, file.sourceStat, true)
        if (
          (file.sourceStat.nlink > 1 && !file.linkTarget) ||
          files.some((entry) => entry.linkTarget === path.join(from, file.name))
        )
          continue
        pending.push({
          source: from,
          destination: to,
          name: file.name,
          size: file.size,
          sourceMtimeMs: file.sourceStat.mtimeMs,
          sha256: hash
        })
      }
      copyMetadata(from, to, promoted, pending)
      saveModelStorageChoice(profile, to, [...readPendingModelCleanup(profile), ...pending])
      configureRuntime({ modelsDir: to })
    } catch (error) {
      for (const target of promoted) {
        try {
          fs.rmSync(target, { force: true })
        } catch (cleanupError) {
          console.warn('[model-storage] Could not remove failed copy:', target, cleanupError)
        }
      }
      throw error
    }
    return { moved: promoted.length, unknownEntriesLeft }
  } finally {
    release()
  }
}

async function verifyCopy(
  from: string,
  target: string,
  file: OwnedModelFile & { size: number }
): Promise<string> {
  const hash = await sha256File(target)
  if (
    fs.statSync(target).size !== file.size ||
    (await sha256File(path.join(from, file.name))) !== hash ||
    (file.sha256 && hash !== file.sha256.toLowerCase())
  )
    throw new Error(`Cannot verify the copied file: ${file.name}. The old folder is unchanged.`)
  return hash
}

/** Complete this snapshot and the config switch without yielding to renderer writes. */
function copyMetadata(
  from: string,
  to: string,
  promoted: string[],
  pending: PendingModelCleanup[],
  transform: (name: string, bytes: Buffer) => Buffer = (_name, bytes) => bytes
): void {
  // Settings may change during the asynchronous model copy. Refresh small metadata
  // synchronously so no renderer write can occur between this snapshot and the switch.
  for (const name of metadata) {
    const source = regularFileOrMissing(from, name)
    if (!source) {
      const target = path.join(to, name)
      if (promoted.includes(target)) fs.rmSync(target, { force: true })
      const index = pending.findIndex((entry) => entry.name === name)
      if (index >= 0) pending.splice(index, 1)
      continue
    }
    const bytes = transform(name, fs.readFileSync(path.join(from, name)))
    const target = path.join(to, name)
    let parent = path.dirname(target)
    while (parent !== to) {
      if (
        fs.existsSync(parent) &&
        (fs.lstatSync(parent).isSymbolicLink() || !fs.statSync(parent).isDirectory())
      )
        throw new Error('The new folder contains an unsafe model path.')
      parent = path.dirname(parent)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (!promoted.includes(target)) {
      if (fs.existsSync(target))
        throw new Error(`The new folder already contains ${name}. Choose another folder.`)
      const fd = fs.openSync(target, 'wx')
      fs.closeSync(fd)
      promoted.push(target)
    }
    fs.writeFileSync(target, bytes)
    if (fs.statSync(target).size !== bytes.length || !fs.readFileSync(target).equals(bytes))
      throw new Error(`Cannot verify the copied file: ${name}. The old folder is unchanged.`)
    assertUnchanged(from, name, source)
    const record = {
      source: from,
      destination: to,
      name,
      size: bytes.length,
      sourceMtimeMs: source.mtimeMs,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
    const index = pending.findIndex((entry) => entry.name === name)
    if (index < 0) pending.push(record)
    else pending[index] = record
  }
}

function regularFileOrMissing(root: string, name: string): fs.Stats | null {
  try {
    return regularFile(root, name)
  } catch {
    return null
  }
}

function assertUnchanged(root: string, name: string, expected: fs.Stats, allowLinks = false): void {
  const latest = regularFile(root, name, allowLinks)
  if (
    !latest ||
    latest.ino !== expected.ino ||
    latest.nlink !== expected.nlink ||
    latest.size !== expected.size ||
    latest.mtimeMs !== expected.mtimeMs ||
    latest.ctimeMs !== expected.ctimeMs
  )
    throw new Error('The file changed during verification.')
}

/** Background cleanup of inactive source copies. Never recursively deletes directories. */
export async function cleanupMovedModelStorage(
  profile: string,
  activeDirectory: string
): Promise<void> {
  const records = readPendingModelCleanup(profile)
  if (!records.length) return
  const handled = new Set<PendingModelCleanup>()
  for (const record of records) {
    // Also yield for missing files and failed checks, not only streamed hashes.
    await yieldToEventLoop()
    try {
      if (
        !safeName(record.name) ||
        readModelStorageChoice(profile) !== record.destination ||
        fs.realpathSync(activeDirectory) !== record.destination ||
        record.source === record.destination
      )
        throw new Error('The cleanup destination is not active.')
      // Keep settings and registries for builds that still read the old folder.
      if (record.name.endsWith('.json')) {
        handled.add(record)
        continue
      }
      const destination = regularFile(record.destination, record.name, true)
      const linked = destination?.isSymbolicLink() === true
      if (
        !destination ||
        (!linked && (destination.size !== record.size || destination.nlink !== 1))
      )
        throw new Error('The destination file is missing or has changed size.')
      // Only an absent file is handled. Permission errors retain the record.
      let source: fs.Stats | null
      fs.lstatSync(record.source) // A missing/disconnected root is a failure, not a handled file.
      try {
        source = regularFile(record.source, record.name, linked)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          handled.add(record)
          continue
        }
        throw error
      }
      if (
        !source ||
        (linked &&
          (!source.isSymbolicLink() ||
            fs.realpathSync(path.join(record.source, record.name)) !==
              fs.realpathSync(path.join(record.destination, record.name))))
      )
        throw new Error('The source is no longer the copied file or link.')
      if (
        source.size !== record.size ||
        (record.sourceMtimeMs === undefined
          ? (await sha256File(path.join(record.source, record.name))) !== record.sha256
          : source.mtimeMs !== record.sourceMtimeMs) ||
        (await sha256File(path.join(record.destination, record.name))) !== record.sha256
      )
        throw new Error('The source or destination file has changed.')
      assertUnchanged(record.source, record.name, source, linked)
      assertUnchanged(record.destination, record.name, destination, linked)
      if (readModelStorageChoice(profile) !== record.destination)
        throw new Error('The cleanup destination is no longer active.')
      fs.unlinkSync(path.join(record.source, record.name))
      handled.add(record)
    } catch (error) {
      console.warn('[model-storage] Keeping old copy:', record.name, error)
    }
  }
  try {
    // A folder selection or another move may have updated the journal while hashing.
    const saved = readModelStorageChoice(profile)
    const handledKeys = new Set([...handled].map((record) => JSON.stringify(record)))
    const remaining = readPendingModelCleanup(profile).filter(
      (record) => !handledKeys.has(JSON.stringify(record))
    )
    if (saved) saveModelStorageChoice(profile, saved, remaining)
  } catch (error) {
    console.warn('[model-storage] Could not update cleanup record:', error)
  }
}

function isRegistryObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRegistryFile(
  value: unknown
): value is string | (Record<string, unknown> & { name: string }) {
  return typeof value === 'string' || (isRegistryObject(value) && typeof value.name === 'string')
}

/** Rewrite supported references without mutating the entry or dropping file metadata. */
export function rewriteRegistryEntryReferences(
  entry: unknown,
  reference: (name: string) => string
): unknown {
  if (!isRegistryObject(entry)) {
    return entry
  }
  const rewritten = { ...entry }
  if (Array.isArray(entry.files)) {
    rewritten.files = entry.files.map((file: unknown) => {
      if (typeof file === 'string') {
        return reference(file)
      }
      if (isRegistryFile(file) && typeof file !== 'string') {
        return { ...file, name: reference(file.name) }
      }
      return file
    })
  }
  for (const key of ['primary', 'mmproj']) {
    if (typeof entry[key] === 'string') {
      rewritten[key] = reference(entry[key])
    }
  }
  return rewritten
}

function validRegistryEntry(entry: unknown): boolean {
  return (
    isRegistryObject(entry) &&
    (entry.files === undefined ||
      (Array.isArray(entry.files) && entry.files.every(isRegistryFile))) &&
    ['primary', 'mmproj'].every(
      (key) => entry[key] === undefined || entry[key] === null || typeof entry[key] === 'string'
    )
  )
}

/** Keep weights in place, but carry settings and registries into the new write folder. */
export function leaveModelStorage(profile: string, source: string, destination: string): void {
  const release = beginStorageMove()
  const promoted: string[] = []
  let addedScanFolder: string | null = null
  try {
    if (storageDownloadsActive()) throw new Error(STORAGE_DOWNLOAD_ERROR)
    const from = fs.realpathSync(source)
    const to = fs.realpathSync(destination)
    if (from === to) return
    copyMetadata(from, to, promoted, [], (name, bytes) => {
      const registry = name === 'downloaded-models.json' || name === 'local-models.json'
      const keys =
        name === 'active-model.json'
          ? ['primary', 'mmproj']
          : name === 'llm-settings.json'
            ? ['draftModel']
            : []
      if (!registry && !keys.length) return bytes
      try {
        const value: unknown = JSON.parse(bytes.toString('utf8'))
        const roots = [from, ...readModelScanFolders(profile)]
        const reference = (file: string): string => resolveModelReference(file, roots)
        if (registry) {
          if (!Array.isArray(value) || !value.every(validRegistryEntry)) {
            throw new Error('Invalid registry structure')
          }
          return Buffer.from(
            JSON.stringify(
              value.map((entry) => rewriteRegistryEntryReferences(entry, reference)),
              null,
              2
            )
          )
        }
        if (!isRegistryObject(value)) {
          throw new Error('Invalid settings structure')
        }
        for (const key of keys) {
          if (typeof value[key] === 'string' && value[key]) value[key] = reference(value[key])
        }
        return Buffer.from(JSON.stringify(value, null, 2))
      } catch {
        // Do not log parser errors: their messages can include private metadata.
        console.warn('[model-storage] Could not rewrite metadata; copying unchanged:', name)
        return bytes
      }
    })
    const alreadyScanned = readModelScanFolders(profile).includes(from)
    addModelScanFolder(profile, from)
    if (!alreadyScanned) addedScanFolder = from
    saveModelStorageChoice(profile, to)
  } catch (error) {
    for (const target of promoted) fs.rmSync(target, { force: true })
    if (addedScanFolder) removeModelScanFolder(profile, addedScanFolder)
    throw error
  } finally {
    release()
  }
}
