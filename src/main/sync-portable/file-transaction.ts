import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import { open } from 'fs/promises'
import path from 'path'
import { BundleError } from '@offgrid/sync/portable'
import type { CollisionPolicy, StagedRestoreFile } from '@offgrid/sync/portable'

export interface CommittedFile {
  key: string
  path: string
}

interface FileAction extends CommittedFile {
  stagedPath: string
  backupPath?: string
  kind: 'create' | 'replace' | 'reuse'
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await open(filePath, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let bytesRead = 0
    do {
      ;({ bytesRead } = await handle.read(buffer, 0, buffer.length, null))
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

function uniqueDestination(destination: string): string {
  const extension = path.extname(destination)
  const stem = extension.length > 0 ? destination.slice(0, -extension.length) : destination
  let candidate: string
  do candidate = `${stem}-${randomUUID()}${extension}`
  while (fs.existsSync(candidate))
  return candidate
}

async function planAction(file: StagedRestoreFile, policy: CollisionPolicy): Promise<FileAction> {
  if (!fs.existsSync(file.destinationPath)) {
    return {
      key: file.key,
      path: file.destinationPath,
      stagedPath: file.stagedPath,
      kind: 'create'
    }
  }
  if (policy === 'reject')
    throw new BundleError(`A file already exists at ${file.destinationPath}.`)
  if (policy === 'duplicate') {
    return {
      key: file.key,
      path: uniqueDestination(file.destinationPath),
      stagedPath: file.stagedPath,
      kind: 'create'
    }
  }
  if (policy === 'keep-existing') {
    if ((await sha256(file.destinationPath)) !== file.sha256) {
      throw new BundleError(`An existing file conflicts with ${file.key}.`)
    }
    return { key: file.key, path: file.destinationPath, stagedPath: file.stagedPath, kind: 'reuse' }
  }
  return {
    key: file.key,
    path: file.destinationPath,
    stagedPath: file.stagedPath,
    backupPath: `${file.destinationPath}.offgrid-rollback-${randomUUID()}`,
    kind: 'replace'
  }
}

/**
 * Compensating filesystem transaction used while the SQLite transaction is
 * open. All paths live under userData, so rename stays on one filesystem.
 */
export class FileTransaction {
  private readonly actions: FileAction[]
  private readonly completed: FileAction[] = []

  private constructor(actions: FileAction[]) {
    this.actions = actions
  }

  static async create(
    files: readonly StagedRestoreFile[],
    policy: CollisionPolicy
  ): Promise<FileTransaction> {
    return new FileTransaction(await Promise.all(files.map((file) => planAction(file, policy))))
  }

  paths(): ReadonlyMap<string, string> {
    return new Map(this.actions.map((action) => [action.key, action.path]))
  }

  apply(): void {
    for (const action of this.actions) {
      if (action.kind === 'reuse') continue
      fs.mkdirSync(path.dirname(action.path), { recursive: true })
      if (action.kind === 'replace') fs.renameSync(action.path, action.backupPath!)
      try {
        fs.renameSync(action.stagedPath, action.path)
        this.completed.push(action)
      } catch (error) {
        if (action.kind === 'replace' && action.backupPath && fs.existsSync(action.backupPath)) {
          fs.renameSync(action.backupPath, action.path)
        }
        throw error
      }
    }
  }

  rollback(primaryError: unknown): never {
    const rollbackErrors: unknown[] = []
    for (const action of [...this.completed].reverse()) {
      try {
        if (fs.existsSync(action.path)) fs.renameSync(action.path, action.stagedPath)
        if (action.backupPath && fs.existsSync(action.backupPath))
          fs.renameSync(action.backupPath, action.path)
      } catch (error) {
        rollbackErrors.push(error)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...rollbackErrors],
        'Import failed and filesystem rollback was incomplete.'
      )
    }
    throw primaryError
  }

  finish(): string[] {
    const warnings: string[] = []
    for (const action of this.completed) {
      if (!action.backupPath) continue
      try {
        fs.rmSync(action.backupPath, { force: true })
      } catch (error) {
        warnings.push(`Could not remove rollback file ${action.backupPath}: ${String(error)}`)
      }
    }
    return warnings
  }
}
