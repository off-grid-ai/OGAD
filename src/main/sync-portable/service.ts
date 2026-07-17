import { copyFile } from 'fs/promises'
import path from 'path'
import { Mutex } from 'async-mutex'
import { BackupEngine } from '@offgrid/sync/portable'
import type { BackupSink, CollisionPolicy } from '@offgrid/sync/portable'
import type { SyncPortableExportResult } from '../../shared/sync-portable-contract'
import type { SyncPortableSummary } from '../../shared/sync-portable-contract'
import { DesktopArchivePort } from './archive'
import { DesktopWorkspaceDataPort, type DesktopImportSummary } from './data'
import { preparePortableDocument } from './prepare-document'
import { ImportJournalStore } from './import-journal'
import { ensureRagSchema } from '../rag/store'

export interface PortableDialogPort {
  saveWorkspace(suggestedName: string): Promise<string | null>
  pickWorkspace(): Promise<string | null>
}

class DesktopBackupSink implements BackupSink<SyncPortableExportResult> {
  constructor(private readonly dialogs: PortableDialogPort) {}

  async deliverFile(
    temporaryPath: string,
    suggestedName: string
  ): Promise<SyncPortableExportResult> {
    const destination = await this.dialogs.saveWorkspace(suggestedName)
    if (destination === null) return { canceled: true }
    await copyFile(temporaryPath, destination)
    return { canceled: false, savedPath: destination }
  }

  pickFile(): Promise<string | null> {
    return this.dialogs.pickWorkspace()
  }
}

export interface DesktopPortableServiceOptions {
  userData: string
  database: ConstructorParameters<typeof DesktopWorkspaceDataPort>[0]
  dialogs: PortableDialogPort
}

export class DesktopPortableService {
  private readonly mutex = new Mutex()
  private readonly data: DesktopWorkspaceDataPort
  private readonly archive: DesktopArchivePort
  private readonly sink: DesktopBackupSink
  private readonly journals: ImportJournalStore

  constructor(options: DesktopPortableServiceOptions) {
    this.journals = new ImportJournalStore(options.userData, options.database)
    this.data = new DesktopWorkspaceDataPort(
      options.database,
      preparePortableDocument,
      this.journals
    )
    this.archive = new DesktopArchivePort(options.userData)
    this.sink = new DesktopBackupSink(options.dialogs)
  }

  initialize(): void {
    ensureRagSchema()
    this.journals.recover()
  }

  summary(): SyncPortableSummary {
    return this.data.summary()
  }

  private engine(
    collisionPolicy: CollisionPolicy = 'keep-existing'
  ): BackupEngine<DesktopImportSummary, SyncPortableExportResult> {
    return new BackupEngine(this.data, this.archive, this.sink, () => new Date().toISOString(), {
      collisionPolicy,
      cleanupReporter: {
        reportCleanupFailure: ({ resource, path: failedPath, cause }) => {
          console.warn(`[sync:portable] could not remove ${resource} ${failedPath}`, cause)
        }
      }
    })
  }

  exportAll(): Promise<SyncPortableExportResult | null> {
    return this.mutex.runExclusive(() => this.engine().exportAll())
  }

  exportProject(projectId: string): Promise<SyncPortableExportResult | null> {
    return this.mutex.runExclusive(() => this.engine().exportProject(projectId))
  }

  exportConversation(conversationId: string): Promise<SyncPortableExportResult | null> {
    return this.mutex.runExclusive(() => this.engine().exportConversation(conversationId))
  }

  importPicker(collisionPolicy?: CollisionPolicy): Promise<DesktopImportSummary | null> {
    return this.mutex.runExclusive(() => this.engine(collisionPolicy).import())
  }

  /** Main-process only; callers must own and validate transferred temporary files. */
  importPath(
    archivePath: string,
    collisionPolicy?: CollisionPolicy
  ): Promise<DesktopImportSummary> {
    if (!path.isAbsolute(archivePath) || path.extname(archivePath).toLowerCase() !== '.zip') {
      return Promise.reject(new Error('Import path must be an absolute .zip file.'))
    }
    return this.mutex.runExclusive(() => this.engine(collisionPolicy).importPath(archivePath))
  }
}
