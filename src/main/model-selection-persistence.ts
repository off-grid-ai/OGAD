import fs from 'node:fs'
import path from 'node:path'
import {
  decodeModelRouteId,
  encodeModelRouteId,
  type ModelModality,
  type ModelSelectionStore
} from '@offgrid/models'
import { modelsDir } from './runtime-env'

type LegacyModality = 'computer_use' | 'image' | 'speech' | 'transcription'

interface LegacyTextSelection {
  id?: unknown
  primary?: unknown
  mmproj?: unknown
}

interface LegacyRemoteServer {
  id?: unknown
  provider?: unknown
  model?: unknown
}

interface LegacyRemoteSettings {
  activeServerId?: unknown
  servers?: unknown
}

export type ModelSelectionPersistenceFailureCode =
  | 'MODEL_SELECTION_READ_FAILED'
  | 'MODEL_SELECTION_CORRUPT'

export class ModelSelectionPersistenceError extends Error {
  constructor(
    readonly code: ModelSelectionPersistenceFailureCode,
    readonly filePath: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ModelSelectionPersistenceError'
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

const legacyModality = (modality: ModelModality): LegacyModality | null => {
  if (modality === 'computer_use' || modality === 'image' || modality === 'transcription') {
    return modality
  }
  return modality === 'voice' ? 'speech' : null
}

/**
 * The only Desktop persistence adapter for active model selection.
 *
 * `model-selections.json` is authoritative and stores canonical route identities.
 * The older files are migration inputs and native-runtime projections only. They
 * must never be consulted before the canonical selection file.
 */
export class DesktopModelSelectionPersistence implements ModelSelectionStore {
  constructor(private readonly directory: () => string = modelsDir) {}

  private selectionFile(): string {
    return path.join(this.directory(), 'model-selections.json')
  }

  private legacyModalitiesFile(): string {
    return path.join(this.directory(), 'active-modalities.json')
  }

  private legacyTextFile(): string {
    return path.join(this.directory(), 'active-model.json')
  }

  private remoteSettingsFile(): string {
    return path.join(this.directory(), 'remote-vision-server.json')
  }

  private readOptionalObject(file: string): Record<string, unknown> | null {
    let source: string
    try {
      source = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return null
      throw new ModelSelectionPersistenceError(
        'MODEL_SELECTION_READ_FAILED',
        file,
        'The active model selection could not be read.',
        { cause: error }
      )
    }
    try {
      const value: unknown = JSON.parse(source)
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('The selection state must be an object.')
      }
      return value as Record<string, unknown>
    } catch (error) {
      throw new ModelSelectionPersistenceError(
        'MODEL_SELECTION_CORRUPT',
        file,
        'The active model selection is damaged. Repair it before changing models.',
        { cause: error }
      )
    }
  }

  private readObject(file: string): Record<string, unknown> {
    return this.readOptionalObject(file) ?? {}
  }

  private writeObject(file: string, value: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2))
  }

  read(modality: ModelModality): string | null {
    const canonical = this.readCanonical(modality)
    if (canonical) return canonical
    const legacy = this.readLegacy(modality)
    if (legacy && decodeModelRouteId(legacy)) this.write(modality, legacy)
    return legacy
  }

  readCanonical(modality: ModelModality): string | null {
    const canonical = this.readObject(this.selectionFile())[modality]
    return typeof canonical === 'string' && canonical ? canonical : null
  }

  write(modality: ModelModality, routeId: string | null): void {
    const value = this.readObject(this.selectionFile())
    value[modality] = routeId
    this.writeObject(this.selectionFile(), value)
  }

  /** Native model id projected from the canonical route for legacy engine readers. */
  projectedModelId(modality: ModelModality): string | null {
    const selected = this.read(modality)
    if (!selected) return null
    return decodeModelRouteId(selected)?.modelId ?? selected
  }

  /** Keep the old per-modality file as a one-way native compatibility projection. */
  projectLegacyModality(modality: ModelModality, modelId: string | null): void {
    const key = legacyModality(modality)
    if (!key) return
    const value = this.readObject(this.legacyModalitiesFile())
    value[key] = modelId
    this.writeObject(this.legacyModalitiesFile(), value)
  }

  readLegacyTextConfig(): LegacyTextSelection {
    return this.readObject(this.legacyTextFile())
  }

  readLegacyTextConfigIfPresent(): LegacyTextSelection | null {
    return this.readOptionalObject(this.legacyTextFile())
  }

  projectLegacyTextConfig(value: { id: string; primary: string; mmproj: string | null }): void {
    this.writeObject(this.legacyTextFile(), value)
  }

  clearLegacyTextConfig(): void {
    fs.rmSync(this.legacyTextFile(), { force: true })
  }

  private readLegacy(modality: ModelModality): string | null {
    if (modality === 'text') {
      const remote = this.readLegacyRemoteRoute()
      if (remote) return remote
      const id = this.readLegacyTextConfig().id
      return typeof id === 'string' && id ? id : null
    }
    const key = legacyModality(modality)
    if (!key) return null
    const selected = this.readObject(this.legacyModalitiesFile())[key]
    return typeof selected === 'string' && selected ? selected : null
  }

  private readLegacyRemoteRoute(): string | null {
    const settings = this.readObject(this.remoteSettingsFile()) as LegacyRemoteSettings
    if (typeof settings.activeServerId !== 'string' || !Array.isArray(settings.servers)) return null
    const server = (settings.servers as LegacyRemoteServer[]).find(
      (candidate) => candidate.id === settings.activeServerId
    )
    if (
      !server ||
      typeof server.id !== 'string' ||
      typeof server.provider !== 'string' ||
      typeof server.model !== 'string'
    ) {
      return null
    }
    return encodeModelRouteId({
      adapterId: 'desktop.remote-chat',
      providerId: server.provider,
      serverId: server.id,
      modelId: server.model
    })
  }
}

export const desktopModelSelectionPersistence = new DesktopModelSelectionPersistence()
