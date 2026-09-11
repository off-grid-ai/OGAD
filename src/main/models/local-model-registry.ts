import fs from 'node:fs'
import path from 'node:path'
import {
  MODEL_KINDS,
  runtimeModalityForModelKind,
  type ModelKind,
  type RegisteredLocalModel
} from '@offgrid/models'

export type LocalModelRegistryEntry = RegisteredLocalModel & { params?: number }

export type LocalModelRegistryFailureCode =
  | 'LOCAL_MODEL_REGISTRY_READ_FAILED'
  | 'LOCAL_MODEL_REGISTRY_CORRUPT'
  | 'LOCAL_MODEL_REGISTRY_WRITE_FAILED'

export class LocalModelRegistryError extends Error {
  constructor(
    readonly code: LocalModelRegistryFailureCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'LocalModelRegistryError'
  }
}

export interface LocalModelRegistryFilePort {
  readFileSync(file: string, encoding: BufferEncoding): string
  mkdirSync(dir: string, options: { recursive: true }): unknown
  writeFileSync(file: string, data: string, options: { encoding: 'utf8'; mode: number }): void
  renameSync(from: string, to: string): void
  rmSync(file: string, options: { force: true }): void
}

const nodeFiles: LocalModelRegistryFilePort = fs

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function isEntry(value: unknown): value is LocalModelRegistryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<LocalModelRegistryEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.primary === 'string' &&
    (entry.mmproj === undefined || typeof entry.mmproj === 'string') &&
    typeof entry.kind === 'string' &&
    MODEL_KINDS.includes(entry.kind as ModelKind) &&
    runtimeModalityForModelKind(entry.kind) === 'text' &&
    (entry.params === undefined || typeof entry.params === 'number') &&
    typeof entry.sizeBytes === 'number' &&
    Number.isFinite(entry.sizeBytes) &&
    entry.sizeBytes >= 0
  )
}

/** Desktop filesystem adapter for Shared's local-model registry transaction. */
export class LocalModelRegistry {
  private writeSequence = 0

  constructor(
    private readonly dir: string,
    private readonly files: LocalModelRegistryFilePort = nodeFiles
  ) {}

  file(): string {
    return path.join(this.dir, 'local-models.json')
  }

  read(): LocalModelRegistryEntry[] {
    let source: string
    try {
      source = this.files.readFileSync(this.file(), 'utf8')
    } catch (error) {
      if (isMissing(error)) return []
      throw new LocalModelRegistryError(
        'LOCAL_MODEL_REGISTRY_READ_FAILED',
        'The local model library could not be read.',
        { cause: error }
      )
    }

    try {
      const parsed: unknown = JSON.parse(source)
      if (!Array.isArray(parsed) || !parsed.every(isEntry))
        throw new Error('invalid registry shape')
      return parsed
    } catch (error) {
      throw new LocalModelRegistryError(
        'LOCAL_MODEL_REGISTRY_CORRUPT',
        'The local model library is damaged. Repair it before changing local models.',
        { cause: error }
      )
    }
  }

  write(entries: readonly LocalModelRegistryEntry[]): void {
    const target = this.file()
    const temporary = `${target}.tmp-${process.pid}-${++this.writeSequence}`
    try {
      this.files.mkdirSync(this.dir, { recursive: true })
      this.files.writeFileSync(temporary, JSON.stringify(entries, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      })
      this.files.renameSync(temporary, target)
    } catch (error) {
      try {
        this.files.rmSync(temporary, { force: true })
      } catch {
        // Preserve the original failure. The temporary file is not authoritative.
      }
      throw new LocalModelRegistryError(
        'LOCAL_MODEL_REGISTRY_WRITE_FAILED',
        'The local model library could not be saved.',
        { cause: error }
      )
    }
  }
}
