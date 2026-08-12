import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import JSZip from 'jszip'
import { BundleError, type ArchivePort } from '@offgrid/sync/portable'
import { isSafeBackupKey } from './file-mapper'

async function regularFile(filePath: string): Promise<fs.Stats> {
  const stat = await fs.promises.lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new BundleError('A backup source is not a regular file.')
  }
  return stat
}

async function existingRegularFile(filePath: string): Promise<fs.Stats | null> {
  try {
    return await regularFile(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function fileChecksum(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await fs.promises.readdir(current, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const absolute = path.join(current, entry.name)
    if (entry.isSymbolicLink())
      throw new BundleError('Backup folders cannot contain symbolic links.')
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolute)))
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute))
    }
  }
  return files
}

export interface DesktopArchiveOptions {
  tempDir?: string
  userDataDir: string
}

export class DesktopBackupArchive implements ArchivePort {
  private readonly tempDir: string
  private readonly restoreRoot: string

  constructor(options: DesktopArchiveOptions) {
    this.tempDir = options.tempDir ?? os.tmpdir()
    this.restoreRoot = path.join(options.userDataDir, 'restored-backups')
  }

  stageDir(): Promise<string> {
    return fs.promises.mkdtemp(path.join(this.tempDir, 'offgrid-backup-stage-'))
  }

  async writeText(absPath: string, text: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true })
    await fs.promises.writeFile(absPath, text, 'utf8')
  }

  readText(absPath: string): Promise<string> {
    return fs.promises.readFile(absPath, 'utf8')
  }

  async copyInto(srcPath: string, destAbsPath: string): Promise<void> {
    const source = await regularFile(srcPath)
    const existing = await existingRegularFile(destAbsPath)
    if (existing) {
      if (
        existing.size === source.size &&
        (await fileChecksum(destAbsPath)) === (await fileChecksum(srcPath))
      ) {
        return
      }
      throw new BundleError('A different file already exists at a backup restore path.')
    }
    await fs.promises.mkdir(path.dirname(destAbsPath), { recursive: true })
    await fs.promises.copyFile(srcPath, destAbsPath, fs.constants.COPYFILE_EXCL)
  }

  async pack(stageDir: string, suggestedName: string): Promise<string> {
    try {
      const zip = new JSZip()
      const files = await walkFiles(stageDir)
      for (const relative of files) {
        zip.file(
          relative.split(path.sep).join('/'),
          await fs.promises.readFile(path.join(stageDir, relative))
        )
      }
      const outputDir = await fs.promises.mkdtemp(
        path.join(this.tempDir, 'offgrid-backup-archive-')
      )
      const output = path.join(outputDir, suggestedName)
      await fs.promises.writeFile(
        output,
        await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
      )
      return output
    } finally {
      await fs.promises.rm(stageDir, { recursive: true, force: true })
    }
  }

  async unpack(archivePath: string): Promise<string> {
    await regularFile(archivePath)
    const zip = await JSZip.loadAsync(await fs.promises.readFile(archivePath))
    const output = await fs.promises.mkdtemp(path.join(this.tempDir, 'offgrid-backup-unpack-'))
    try {
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue
        if (entry.name !== 'backup.json' && !isSafeBackupKey(entry.name)) {
          throw new BundleError('This backup contains an unsafe archive path.')
        }
        const destination = path.join(output, ...entry.name.split('/'))
        await fs.promises.mkdir(path.dirname(destination), { recursive: true })
        await fs.promises.writeFile(destination, await entry.async('nodebuffer'), {
          flag: 'wx'
        })
      }
      return output
    } catch (error) {
      await fs.promises.rm(output, { recursive: true, force: true })
      throw error
    }
  }

  restorePathFor(key: string): string {
    if (!isSafeBackupKey(key)) throw new BundleError('This backup contains an unsafe file path.')
    return path.join(this.restoreRoot, ...key.split('/'))
  }

  join(...parts: string[]): string {
    return path.join(...parts)
  }
}
