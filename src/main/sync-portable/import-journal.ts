import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3-multiple-ciphers'
import { BundleError } from '@offgrid/sync/portable'
import type { StagedRestoreFile } from '@offgrid/sync/portable'

type Db = Database.Database
export type JournalActionKind = 'create' | 'replace' | 'reuse'
export type JournalActionStatus = 'planned' | 'backed-up' | 'installed'

export interface JournalAction {
  key: string
  path: string
  stagedPath: string
  backupPath?: string
  kind: JournalActionKind
  status: JournalActionStatus
}

interface JournalRecord {
  version: 1
  id: string
  actions: JournalAction[]
}

const ID = /^[0-9a-f-]{36}$/i
const BACKUP_MARKER = '.offgrid-rollback-'

function isOwned(candidate: string, root: string): boolean {
  const resolved = path.resolve(candidate)
  const ownedRoot = path.resolve(root)
  return resolved !== ownedRoot && resolved.startsWith(`${ownedRoot}${path.sep}`)
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function durableWrite(filePath: string, value: string): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  const descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, value, 'utf8')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporaryPath, filePath)
  fsyncDirectory(path.dirname(filePath))
}

function validateBackup(action: Record<string, unknown>, restoreRoot: string): void {
  const inconsistent =
    (action.kind === 'replace' && typeof action.backupPath !== 'string') ||
    (action.kind !== 'replace' && action.backupPath !== undefined)
  if (inconsistent) {
    throw new BundleError('Portable import journal action has inconsistent backup metadata.')
  }
  if (typeof action.backupPath !== 'string') return
  if (
    typeof action.path !== 'string' ||
    !isOwned(action.backupPath, restoreRoot) ||
    !action.backupPath.startsWith(`${action.path}${BACKUP_MARKER}`)
  ) {
    throw new BundleError('Portable import journal backup path is invalid.')
  }
}

function parseAction(value: unknown, stageRoot: string, restoreRoot: string): JournalAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BundleError('Portable import journal contains an invalid action.')
  }
  const action = value as Record<string, unknown>
  const invalidFields = [
    typeof action.key !== 'string',
    typeof action.key === 'string' && action.key.length === 0,
    typeof action.key === 'string' && action.key.length > 1024,
    typeof action.path !== 'string',
    typeof action.stagedPath !== 'string',
    !['create', 'replace', 'reuse'].includes(String(action.kind)),
    !['planned', 'backed-up', 'installed'].includes(String(action.status)),
    typeof action.path === 'string' && !isOwned(action.path, restoreRoot),
    typeof action.stagedPath === 'string' && !isOwned(action.stagedPath, stageRoot)
  ]
  if (invalidFields.some(Boolean)) {
    throw new BundleError('Portable import journal action is invalid or escapes owned storage.')
  }
  validateBackup(action, restoreRoot)
  return action as unknown as JournalAction
}

export class ImportJournal {
  constructor(
    private readonly filePath: string,
    private readonly record: JournalRecord
  ) {}

  get id(): string {
    return this.record.id
  }

  persist(): void {
    durableWrite(this.filePath, JSON.stringify(this.record))
  }

  update(index: number, status: JournalActionStatus): void {
    const action = this.record.actions[index]
    if (!action) throw new BundleError('Portable import journal action is missing.')
    action.status = status
    this.persist()
  }

  remove(): void {
    fs.rmSync(this.filePath, { force: true })
    fsyncDirectory(path.dirname(this.filePath))
  }
}

export class ImportJournalStore {
  readonly stageRoot: string
  readonly restoreRoot: string
  private readonly journalRoot: string

  constructor(
    userData: string,
    private readonly db: Db
  ) {
    this.stageRoot = path.join(userData, 'sync-portable', 'stages')
    this.restoreRoot = path.join(userData, 'sync-files')
    this.journalRoot = path.join(userData, 'sync-portable', 'journals')
  }

  ensureSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS portable_import_commits (
      id TEXT PRIMARY KEY,
      committed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
  }

  stageText(documentId: string, text: string): StagedRestoreFile {
    fs.mkdirSync(this.stageRoot, { recursive: true, mode: 0o700 })
    const stage = fs.mkdtempSync(path.join(this.stageRoot, 'stage-text-'))
    const stagedPath = path.join(stage, 'document.txt')
    const bytes = Buffer.from(text, 'utf8')
    const descriptor = fs.openSync(stagedPath, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, bytes)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    const idDigest = createHash('sha256').update(documentId).digest('hex')
    return {
      key: `text-document-${randomUUID()}`,
      size: bytes.length,
      sha256: digest,
      stagedPath,
      destinationPath: path.join(this.restoreRoot, 'documents', `${idDigest}.txt`)
    }
  }

  discardStages(stagedPaths: readonly string[]): void {
    const directories = new Set(stagedPaths.map((stagedPath) => this.stageDirectory(stagedPath)))
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
    if (fs.existsSync(this.stageRoot)) fsyncDirectory(this.stageRoot)
  }

  create(id: string, actions: JournalAction[]): ImportJournal | null {
    if (actions.every(({ kind }) => kind === 'reuse')) return null
    if (!ID.test(id)) throw new BundleError('Portable import journal ID is invalid.')
    fs.mkdirSync(this.journalRoot, { recursive: true, mode: 0o700 })
    const record: JournalRecord = { version: 1, id, actions }
    for (const action of actions) parseAction(action, this.stageRoot, this.restoreRoot)
    const journal = new ImportJournal(path.join(this.journalRoot, `${id}.json`), record)
    journal.persist()
    return journal
  }

  markCommitted(id: string): void {
    this.db.prepare('INSERT INTO portable_import_commits (id) VALUES (?)').run(id)
  }

  clearCommit(id: string): void {
    this.db.prepare('DELETE FROM portable_import_commits WHERE id = ?').run(id)
  }

  recover(): void {
    this.ensureSchema()
    if (!fs.existsSync(this.journalRoot)) {
      this.db.exec('DELETE FROM portable_import_commits')
      return
    }
    const journals = fs
      .readdirSync(this.journalRoot)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => this.read(path.join(this.journalRoot, name)))
    for (const { filePath, record } of journals) this.recoverOne(filePath, record)
    this.db.exec('DELETE FROM portable_import_commits')
  }

  private read(filePath: string): { filePath: string; record: JournalRecord } {
    let parsed: unknown
    try {
      if (fs.statSync(filePath).size > 4 * 1024 * 1024) {
        throw new BundleError('Portable import journal is too large.')
      }
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (error) {
      throw new BundleError(`Portable import journal is corrupt: ${String(error)}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BundleError('Portable import journal must be an object.')
    }
    const raw = parsed as Record<string, unknown>
    if (
      raw.version !== 1 ||
      typeof raw.id !== 'string' ||
      !ID.test(raw.id) ||
      !Array.isArray(raw.actions) ||
      raw.actions.length > 10_000
    ) {
      throw new BundleError('Portable import journal has an unsupported or invalid format.')
    }
    if (path.basename(filePath) !== `${raw.id}.json`) {
      throw new BundleError('Portable import journal filename does not match its ID.')
    }
    return {
      filePath,
      record: {
        version: 1,
        id: raw.id,
        actions: raw.actions.map((action) => parseAction(action, this.stageRoot, this.restoreRoot))
      }
    }
  }

  private recoverOne(filePath: string, record: JournalRecord): void {
    const committed = this.db
      .prepare('SELECT 1 FROM portable_import_commits WHERE id = ?')
      .get(record.id)
    if (committed) this.finishCommitted(record)
    else this.rollbackUncommitted(record)
    fs.rmSync(filePath, { force: true })
    fsyncDirectory(this.journalRoot)
    if (committed) this.clearCommit(record.id)
  }

  private finishCommitted(record: JournalRecord): void {
    for (const action of record.actions) {
      if (!fs.existsSync(action.path)) {
        throw new BundleError(`Committed portable import file is missing: ${action.path}`)
      }
      if (action.backupPath) fs.rmSync(action.backupPath, { force: true })
      if (action.backupPath) fsyncDirectory(path.dirname(action.backupPath))
    }
    this.removeStages(record)
  }

  private rollbackUncommitted(record: JournalRecord): void {
    for (const action of [...record.actions].reverse()) {
      if (action.kind === 'create' && fs.existsSync(action.path)) {
        const stagedExists = fs.existsSync(action.stagedPath)
        const isInstalledFile =
          !stagedExists || fs.statSync(action.path).ino === fs.statSync(action.stagedPath).ino
        if (isInstalledFile) fs.rmSync(action.path, { force: true })
      }
      if (action.kind === 'replace' && action.backupPath && fs.existsSync(action.backupPath)) {
        fs.rmSync(action.path, { force: true })
        fs.renameSync(action.backupPath, action.path)
      }
      fsyncDirectory(path.dirname(action.path))
    }
    this.removeStages(record)
  }

  private removeStages(record: JournalRecord): void {
    this.discardStages(record.actions.map(({ stagedPath }) => stagedPath))
  }

  private stageDirectory(stagedPath: string): string {
    if (!isOwned(stagedPath, this.stageRoot)) {
      throw new BundleError('Portable import stage path escapes owned storage.')
    }
    const first = path.relative(this.stageRoot, stagedPath).split(path.sep)[0]
    if (!first) throw new BundleError('Portable import stage directory is invalid.')
    return path.join(this.stageRoot, first)
  }
}
