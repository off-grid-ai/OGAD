import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import { open } from 'fs/promises'
import path from 'path'
import { BundleError } from '@offgrid/sync/portable'
import type { CollisionPolicy, StagedRestoreFile } from '@offgrid/sync/portable'
import { ImportJournalStore, type ImportJournal, type JournalAction } from './import-journal'

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

function fsyncFileAndDirectory(filePath: string): void {
  const descriptor = fs.openSync(filePath, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  const directory = fs.openSync(path.dirname(filePath), 'r')
  try {
    fs.fsyncSync(directory)
  } finally {
    fs.closeSync(directory)
  }
}

function fsyncDirectory(directoryPath: string): void {
  const descriptor = fs.openSync(directoryPath, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
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

function rollbackAction(action: FileAction): void {
  const hasFinal = fs.existsSync(action.path)
  const hasStaged = fs.existsSync(action.stagedPath)
  const hasBackup = action.backupPath ? fs.existsSync(action.backupPath) : false
  const linkedCreate =
    action.kind === 'create' &&
    hasFinal &&
    hasStaged &&
    fs.statSync(action.path).ino === fs.statSync(action.stagedPath).ino
  const shouldUninstall =
    action.kind === 'create' ? hasFinal && (!hasStaged || linkedCreate) : hasFinal && hasBackup
  if (shouldUninstall) {
    if (hasStaged) fs.rmSync(action.path, { force: true })
    else fs.renameSync(action.path, action.stagedPath)
    if (fs.existsSync(action.stagedPath)) fsyncFileAndDirectory(action.stagedPath)
    fsyncDirectory(path.dirname(action.path))
  }
  if (action.backupPath && hasBackup) {
    fs.renameSync(action.backupPath, action.path)
    fsyncFileAndDirectory(action.path)
  }
}

/**
 * Compensating filesystem transaction used while the SQLite transaction is
 * open. All paths live under userData, so rename stays on one filesystem.
 */
export class FileTransaction {
  private readonly actions: FileAction[]

  private constructor(
    actions: FileAction[],
    private readonly journals: ImportJournalStore,
    private readonly journal: ImportJournal | null
  ) {
    this.actions = actions
  }

  static async create(
    files: readonly StagedRestoreFile[],
    policy: CollisionPolicy,
    journals: ImportJournalStore
  ): Promise<FileTransaction> {
    const actions = await Promise.all(files.map((file) => planAction(file, policy)))
    for (const action of actions) {
      if (action.kind !== 'reuse') fsyncFileAndDirectory(action.stagedPath)
    }
    const journalActions: JournalAction[] = actions.map((action) => ({
      ...action,
      status: 'planned'
    }))
    return new FileTransaction(actions, journals, journals.create(randomUUID(), journalActions))
  }

  paths(): ReadonlyMap<string, string> {
    return new Map(this.actions.map((action) => [action.key, action.path]))
  }

  apply(): void {
    for (const [index, action] of this.actions.entries()) {
      if (action.kind === 'reuse') continue
      fs.mkdirSync(path.dirname(action.path), { recursive: true })
      if (action.kind === 'replace') {
        fs.renameSync(action.path, action.backupPath!)
        fsyncFileAndDirectory(action.backupPath!)
        this.journal?.update(index, 'backed-up')
      }
      try {
        if (action.kind === 'create') {
          fs.linkSync(action.stagedPath, action.path)
          fsyncFileAndDirectory(action.path)
          fs.unlinkSync(action.stagedPath)
          fsyncDirectory(path.dirname(action.stagedPath))
        } else {
          fs.renameSync(action.stagedPath, action.path)
        }
        fsyncFileAndDirectory(action.path)
        this.journal?.update(index, 'installed')
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
    for (const action of [...this.actions].reverse()) {
      try {
        rollbackAction(action)
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
    this.journals.discardStages(this.actions.map(({ stagedPath }) => stagedPath))
    this.journal?.remove()
    throw primaryError
  }

  markCommitted(): void {
    if (this.journal) this.journals.markCommitted(this.journal.id)
  }

  finish(): string[] {
    const warnings: string[] = []
    for (const action of this.actions) {
      if (!action.backupPath) continue
      try {
        fs.rmSync(action.backupPath, { force: true })
        fsyncDirectory(path.dirname(action.backupPath))
      } catch (error) {
        warnings.push(`Could not remove rollback file ${action.backupPath}: ${String(error)}`)
      }
    }
    if (warnings.length === 0) {
      this.journals.discardStages(this.actions.map(({ stagedPath }) => stagedPath))
      if (this.journal) {
        this.journal.remove()
        this.journals.clearCommit(this.journal.id)
      }
    }
    return warnings
  }
}
