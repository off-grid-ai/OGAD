import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  DownloadFinalizationTransaction,
  DownloadFinalizePort,
  PersistedModelDownload
} from '@offgrid/models'

export interface FinalizationFileSystem {
  mkdir(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  rename(source: string, destination: string): Promise<void>
  remove(path: string): Promise<void>
}

interface Promotion {
  staged: string
  destination: string
  backup: string
  artifactId: string
  localName: string
  hadDestination: boolean
}

interface RecoveryState {
  version: 1
  token: string
  hadDestinations: boolean[]
}

function decodeRecoveryState(value: string, artifactCount: number): RecoveryState {
  const parsed: unknown = JSON.parse(value)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('token' in parsed) ||
    typeof parsed.token !== 'string' ||
    !/^[a-zA-Z0-9-]+$/.test(parsed.token) ||
    !('hadDestinations' in parsed) ||
    !Array.isArray(parsed.hadDestinations) ||
    parsed.hadDestinations.length !== artifactCount ||
    !parsed.hadDestinations.every((item) => typeof item === 'boolean')
  ) {
    throw new Error('The model installation recovery state is invalid.')
  }
  return parsed as RecoveryState
}

function childPath(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(root, relative)
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe model installation path: ${relative}`)
  }
  return resolved
}

const nodeFileSystem: FinalizationFileSystem = {
  mkdir: async (directory) => {
    await fs.promises.mkdir(directory, { recursive: true })
  },
  exists: async (filePath) => {
    try {
      await fs.promises.stat(filePath)
      return true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw cause
    }
  },
  rename: (source, destination) => fs.promises.rename(source, destination),
  remove: async (filePath) => {
    await fs.promises.rm(filePath, { recursive: true, force: true })
  }
}

class DesktopModelFinalizationTransaction implements DownloadFinalizationTransaction {
  private readonly promotions: Promotion[]
  private prepared = false
  private committed = false
  private rolledBack = false

  private readonly backupRoot: string
  private readonly files: FinalizationFileSystem
  readonly recoveryState: string

  constructor(input: {
    download: Readonly<PersistedModelDownload>
    backupRoot: string
    modelsDir: string
    token: string
    hadDestinations: boolean[]
    pathFor(localName: string): string
    files: FinalizationFileSystem
    recovering?: boolean
  }) {
    this.backupRoot = input.backupRoot
    this.files = input.files
    this.prepared = input.recovering ?? false
    this.recoveryState = JSON.stringify({
      version: 1,
      token: input.token,
      hadDestinations: input.hadDestinations
    } satisfies RecoveryState)
    this.promotions = input.download.manifest.artifacts.map((artifact, index) => ({
      staged: input.pathFor(artifact.localName),
      destination: childPath(input.modelsDir, artifact.name),
      backup: path.join(input.backupRoot, String(index)),
      artifactId: artifact.id,
      localName: artifact.name,
      hadDestination: input.hadDestinations[index] ?? false
    }))
  }

  async prepare(signal: AbortSignal): Promise<{
    artifacts: readonly { artifactId: string; localName: string }[]
  }> {
    if (this.prepared) {
      return { artifacts: this.installedArtifacts() }
    }
    if (this.committed || this.rolledBack) {
      throw new Error('The model installation transaction is already closed.')
    }
    await this.files.mkdir(this.backupRoot)
    // Protect every existing destination before the first new artifact becomes visible.
    for (const promotion of this.promotions) {
      signal.throwIfAborted()
      await this.files.mkdir(path.dirname(promotion.destination))
      if (promotion.staged === promotion.destination) {
        throw new Error('A staged model artifact cannot also be its final destination.')
      }
      if (promotion.hadDestination) {
        await this.files.rename(promotion.destination, promotion.backup)
      }
    }
    for (const promotion of this.promotions) {
      signal.throwIfAborted()
      await this.files.rename(promotion.staged, promotion.destination)
    }
    this.prepared = true
    return { artifacts: this.installedArtifacts() }
  }

  async commit(): Promise<void> {
    if (this.committed) return
    if (this.rolledBack) throw new Error('A rolled-back model installation cannot be committed.')
    if (!this.prepared) throw new Error('A model installation must be prepared before commit.')

    for (const promotion of this.promotions) {
      if (!(await this.files.exists(promotion.destination))) {
        throw new Error(`Committed model artifact is missing: ${promotion.localName}`)
      }
    }
    // Shared catches and reports cleanup failure after its durable ownership point. This method
    // must not convert a failed cleanup into success, and Shared must not roll files back then.
    await this.files.remove(this.backupRoot)
    this.committed = true
  }

  async rollback(): Promise<void> {
    if (this.rolledBack) return
    if (this.committed) throw new Error('A committed model installation cannot be rolled back.')
    const failures: unknown[] = []
    for (const promotion of [...this.promotions].reverse()) {
      try {
        const stagedExists = await this.files.exists(promotion.staged)
        const destinationExists = await this.files.exists(promotion.destination)
        const backupExists = await this.files.exists(promotion.backup)
        if (!stagedExists && destinationExists) {
          await this.files.mkdir(path.dirname(promotion.staged))
          await this.files.rename(promotion.destination, promotion.staged)
        } else if (stagedExists && destinationExists && backupExists) {
          throw new Error(`Model installation has two promoted copies: ${promotion.localName}`)
        }
        if (backupExists) {
          await this.files.remove(promotion.destination)
          await this.files.rename(promotion.backup, promotion.destination)
        } else if (promotion.hadDestination && !(await this.files.exists(promotion.destination))) {
          throw new Error(`Previous model artifact backup is missing: ${promotion.localName}`)
        }
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'The previous model installation could not be restored.')
    }
    await this.files.remove(this.backupRoot)
    this.rolledBack = true
  }

  private installedArtifacts(): Array<{ artifactId: string; localName: string }> {
    return this.promotions.map(({ artifactId, localName }) => ({ artifactId, localName }))
  }
}

export function createDesktopModelDownloadFinalizer(input: {
  modelsDir: string
  pathFor(localName: string): string
  files?: FinalizationFileSystem
  newId?: () => string
}): DownloadFinalizePort {
  const files = input.files ?? nodeFileSystem
  const newId = input.newId ?? randomUUID
  return {
    begin: async (download) => {
      const token = newId()
      const hadDestinations = await Promise.all(
        download.manifest.artifacts.map((artifact) =>
          files.exists(childPath(input.modelsDir, artifact.name))
        )
      )
      return new DesktopModelFinalizationTransaction({
        download,
        backupRoot: path.join(input.modelsDir, '.install-backups', token),
        modelsDir: input.modelsDir,
        token,
        hadDestinations,
        pathFor: input.pathFor,
        files
      })
    },
    recover: async ({ download, state, disposition }) => {
      const decoded = decodeRecoveryState(state, download.manifest.artifacts.length)
      const transaction = new DesktopModelFinalizationTransaction({
        download,
        backupRoot: path.join(input.modelsDir, '.install-backups', decoded.token),
        modelsDir: input.modelsDir,
        token: decoded.token,
        hadDestinations: decoded.hadDestinations,
        pathFor: input.pathFor,
        files,
        recovering: true
      })
      if (disposition === 'commit') await transaction.commit()
      else await transaction.rollback()
    }
  }
}
