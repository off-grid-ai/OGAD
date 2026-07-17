import { createHash, randomUUID } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import JSZip from 'jszip'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { BundleError, validateArchiveKey } from '@offgrid/sync/portable'
import type { ArchiveEntry, ArchiveEntryType, ArchivePort } from '@offgrid/sync/portable'

const ZIP_HOST_UNIX = 3
const UNIX_FILE_TYPE = 0o170000
const UNIX_REGULAR_FILE = 0o100000
const UNIX_DIRECTORY = 0o040000
const UNIX_SYMLINK = 0o120000

function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, decodeStrings: true, autoClose: false, strictFileNames: true },
      (error, zip) => {
        if (error) reject(error)
        else resolve(zip)
      }
    )
  })
}

function unixMode(entry: Entry): number | null {
  const host = entry.versionMadeBy >>> 8
  return host === ZIP_HOST_UNIX ? (entry.externalFileAttributes >>> 16) & 0xffff : null
}

function entryType(entry: Entry): ArchiveEntryType {
  const mode = unixMode(entry)
  if (mode !== null) {
    const type = mode & UNIX_FILE_TYPE
    if (type === UNIX_SYMLINK) return 'symlink'
    if (type === UNIX_DIRECTORY) return 'directory'
    if (type !== 0 && type !== UNIX_REGULAR_FILE) return 'other'
  }
  if (entry.fileName.endsWith('/') || (entry.externalFileAttributes & 0x10) !== 0)
    return 'directory'
  return 'file'
}

function toArchiveEntry(entry: Entry): ArchiveEntry {
  return {
    key: entry.fileName,
    type: entryType(entry),
    size: entry.uncompressedSize,
    compressedSize: entry.compressedSize
  }
}

async function readCentralDirectory(
  archivePath: string
): Promise<{ raw: Entry; portable: ArchiveEntry }[]> {
  const zip = await openZip(archivePath)
  return new Promise((resolve, reject) => {
    const entries: { raw: Entry; portable: ArchiveEntry }[] = []
    zip.on('entry', (entry: Entry) => {
      entries.push({ raw: entry, portable: toArchiveEntry(entry) })
      zip.readEntry()
    })
    zip.once('end', () => {
      zip.close()
      resolve(entries)
    })
    zip.once('error', (error) => {
      zip.close()
      reject(error)
    })
    zip.readEntry()
  })
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error)
      else resolve(stream)
    })
  })
}

async function walkFiles(root: string, directory = root): Promise<{ key: string; path: string }[]> {
  const output: { key: string; path: string }[] = []
  for (const name of await readdir(directory)) {
    const absolute = path.join(directory, name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new BundleError(`Cannot pack symbolic link ${name}.`)
    if (info.isDirectory()) output.push(...(await walkFiles(root, absolute)))
    else if (info.isFile()) {
      const key = path.relative(root, absolute).split(path.sep).join('/')
      output.push({ key: validateArchiveKey(key), path: absolute })
    } else throw new BundleError(`Cannot pack unsupported file ${name}.`)
  }
  return output
}

function destinationFor(root: string, key: string): string {
  const safeKey = validateArchiveKey(key)
  const destination = path.resolve(root, ...safeKey.split('/'))
  const resolvedRoot = path.resolve(root)
  if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new BundleError(`Archive entry ${key} escapes its destination.`)
  }
  return destination
}

function assertOwnedPath(candidate: string, root: string, label: string): void {
  const resolvedCandidate = path.resolve(candidate)
  const resolvedRoot = path.resolve(root)
  if (
    resolvedCandidate === resolvedRoot ||
    !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new BundleError(`${label} must stay inside Off Grid AI's portable workspace storage.`)
  }
}

/** Real ZIP/filesystem boundary for the portable workspace engine. */
export class DesktopArchivePort implements ArchivePort {
  private readonly stageRoot: string
  private readonly archiveRoot: string
  private readonly restoreRoot: string

  constructor(userData: string) {
    const root = path.join(userData, 'sync-portable')
    this.stageRoot = path.join(root, 'stages')
    this.archiveRoot = path.join(root, 'archives')
    this.restoreRoot = path.join(userData, 'sync-files')
  }

  async stageDir(): Promise<string> {
    await mkdir(this.stageRoot, { recursive: true })
    return mkdtemp(path.join(this.stageRoot, 'stage-'))
  }

  async writeText(absolutePath: string, text: string): Promise<void> {
    assertOwnedPath(absolutePath, this.stageRoot, 'Staged file')
    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, text, 'utf8')
  }

  async copyInto(sourcePath: string, destinationPath: string): Promise<void> {
    assertOwnedPath(destinationPath, this.stageRoot, 'Staged file')
    await mkdir(path.dirname(destinationPath), { recursive: true })
    await copyFile(sourcePath, destinationPath)
  }

  async inspectFile(absolutePath: string): Promise<{ size: number; sha256: string }> {
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(absolutePath)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      hash.update(bytes)
    }
    return { size, sha256: hash.digest('hex') }
  }

  async pack(stageDir: string, suggestedName: string): Promise<string> {
    assertOwnedPath(stageDir, this.stageRoot, 'Stage directory')
    await mkdir(this.archiveRoot, { recursive: true })
    const output = path.join(this.archiveRoot, `${randomUUID()}-${path.basename(suggestedName)}`)
    try {
      const zip = new JSZip()
      for (const file of await walkFiles(stageDir)) zip.file(file.key, createReadStream(file.path))
      await pipeline(
        zip.generateNodeStream({
          streamFiles: true,
          compression: 'DEFLATE',
          compressionOptions: { level: 6 }
        }),
        createWriteStream(output, { flags: 'wx', mode: 0o600 })
      )
      return output
    } catch (error) {
      await rm(output, { force: true })
      throw error
    }
  }

  async listEntries(archivePath: string): Promise<ArchiveEntry[]> {
    return (await readCentralDirectory(archivePath)).map(({ portable }) => portable)
  }

  async readEntryText(archivePath: string, key: string, maxBytes: number): Promise<string> {
    validateArchiveKey(key)
    const match = (await readCentralDirectory(archivePath)).find(({ raw }) => raw.fileName === key)
    if (match === undefined || match.portable.type !== 'file')
      throw new BundleError(`Archive is missing ${key}.`)
    if (match.portable.size > maxBytes) throw new BundleError(`${key} is too large.`)
    const zip = await openZip(archivePath)
    try {
      const entry = await new Promise<Entry>((resolve, reject) => {
        zip.on('entry', (candidate: Entry) => {
          if (candidate.fileName === key) resolve(candidate)
          else zip.readEntry()
        })
        zip.once('end', () => reject(new BundleError(`Archive is missing ${key}.`)))
        zip.once('error', reject)
        zip.readEntry()
      })
      const chunks: Buffer[] = []
      let bytesRead = 0
      for await (const chunk of await openEntryStream(zip, entry)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytesRead += bytes.length
        if (bytesRead > maxBytes) throw new BundleError(`${key} is too large.`)
        chunks.push(bytes)
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally {
      zip.close()
    }
  }

  async extractEntries(
    archivePath: string,
    destinationDir: string,
    keys: readonly string[]
  ): Promise<void> {
    assertOwnedPath(destinationDir, this.stageRoot, 'Extraction directory')
    const allowed = new Set(keys.map(validateArchiveKey))
    const entries = await readCentralDirectory(archivePath)
    const byKey = new Map(entries.map((entry) => [entry.raw.fileName, entry]))
    for (const key of allowed) {
      const entry = byKey.get(key)
      if (entry === undefined || entry.portable.type !== 'file')
        throw new BundleError(`Archive is missing ${key}.`)
    }

    const zip = await openZip(archivePath)
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (entry: Entry) => {
        if (!allowed.has(entry.fileName)) {
          zip.readEntry()
          return
        }
        const destination = destinationFor(destinationDir, entry.fileName)
        void mkdir(path.dirname(destination), { recursive: true })
          .then(() => openEntryStream(zip, entry))
          .then((stream) =>
            pipeline(stream, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
          )
          .then(() => zip.readEntry(), reject)
      })
      zip.once('end', resolve)
      zip.once('error', reject)
      zip.readEntry()
    }).finally(() => zip.close())
  }

  restorePathFor(key: string): string {
    return destinationFor(this.restoreRoot, key)
  }

  async removeDir(absolutePath: string): Promise<void> {
    assertOwnedPath(absolutePath, this.stageRoot, 'Stage directory')
    await rm(absolutePath, { recursive: true, force: true })
  }

  async removeFile(absolutePath: string): Promise<void> {
    assertOwnedPath(absolutePath, this.archiveRoot, 'Temporary archive')
    await rm(absolutePath, { force: true })
  }

  join(...parts: string[]): string {
    return path.join(...parts)
  }
}
