import {
  buildTranscriptionModelOptions,
  catalogTranscriptionEngine,
  residentAwareTranscriptionEngine,
  resolveSupportedTranscriptionLanguage,
  selectTranscriptionRoute,
  selectAvailableTranscriptionEngine,
  transcriptionEngineForActiveModel,
  transcriptionEntryMatches,
  transcriptionProvenance,
  type CatalogTranscriptionEngine,
  type TranscriptionCatalogEntry,
  type TranscriptionEngine,
  type PersistedResidencyPreference
} from '@offgrid/models'
import path from 'node:path'
import { transcriptionLanguages, type SpeechLanguage } from '@offgrid/speech'
import { getSetting } from '../database'
import { activeDesktopModelId, generateDesktopOperation } from '../desktop-generation'
import { desktopModelServices } from '../model-service-access'
import type { DesktopManagedRuntime } from '../model-runtime-port'
import { modelsByKind } from '@offgrid/models'
import { parakeetTranscription as parakeet } from './parakeet-cli'
import type { TranscriptionService, TranscribeOptions } from './types'
import { transcriptionService as whisper } from './whisper-cli'
import { whisperServer } from './whisper-server'
import { whisperServerTranscription as whisperResident } from './whisper-server-transcription'

export type { CatalogTranscriptionEngine, TranscriptionEngine }
export const residentAwareEngine = residentAwareTranscriptionEngine

interface Services {
  whisper: TranscriptionService
  parakeet: TranscriptionService
  whisperResident: TranscriptionService
}

const ALL: Services = { whisper, parakeet, whisperResident }

/** Select a Desktop execution adapter after shared engine fallback policy runs. */
export function pickTranscription(
  engine: TranscriptionEngine,
  services: Services
): { service: TranscriptionService; engine: TranscriptionEngine; fellBack: boolean } {
  const selected = selectAvailableTranscriptionEngine(engine, {
    whisper: services.whisper.isAvailable(),
    parakeet: services.parakeet.isAvailable(),
    'whisper-resident': services.whisperResident.isAvailable()
  })
  const service =
    selected.engine === 'parakeet'
      ? services.parakeet
      : selected.engine === 'whisper-resident'
        ? services.whisperResident
        : services.whisper
  return { service, ...selected }
}

export function resolveTranscription(
  engine: TranscriptionEngine,
  mode?: PersistedResidencyPreference
): { service: TranscriptionService; engine: TranscriptionEngine; fellBack: boolean } {
  const requested =
    mode == null || engine === 'whisper-resident'
      ? engine
      : residentAwareTranscriptionEngine(engine, mode)
  return pickTranscription(requested, ALL)
}

function getTranscription(engine: TranscriptionEngine = 'whisper'): TranscriptionService {
  return resolveTranscription(engine).service
}

export function transcriptionEngineForRoute(model: {
  id: string
  providerId?: string
}): CatalogTranscriptionEngine {
  const catalogEntry = modelsByKind('transcription').find((entry) => entry.id === model.id)
  return catalogEntry
    ? catalogTranscriptionEngine(catalogEntry)
    : model.providerId === 'parakeet'
      ? 'parakeet'
      : 'whisper'
}

async function routeForTranscription(
  engine: TranscriptionEngine,
  nativeModelId?: string,
  preferSmallModel: boolean = false
): Promise<string | undefined> {
  await desktopModelServices.refresh()
  const requestedModel = nativeModelId ? path.basename(nativeModelId) : undefined
  const explicitRoute = requestedModel
    ? desktopModelServices.routeIdFor('transcription', requestedModel)
    : undefined
  if (explicitRoute) return explicitRoute

  const requestedEngine: CatalogTranscriptionEngine = engine === 'parakeet' ? 'parakeet' : 'whisper'
  const active = desktopModelServices.llm.active('transcription').model
  const candidates = desktopModelServices.llm
    .list('transcription')
    .filter((model): model is typeof model & { routeId: string } => Boolean(model.routeId))
    .map((model) => ({
      routeId: model.routeId,
      engine: transcriptionEngineForRoute(model),
      ready: model.ready,
      residentSizeMB: model.residentSizeMB
    }))
  return selectTranscriptionRoute({
    engine: requestedEngine,
    candidates,
    explicitRouteId: explicitRoute,
    activeRouteId: active?.routeId,
    preferSmallModel
  })
}

/**
 * Run a caller-selected Desktop transcription engine through the shared generation owner.
 * The native engine remains a platform port; shared routing, admission, cancellation,
 * recovery, and result validation stay on the GenerationService path.
 */
export function getGenerationTranscription(
  engine: TranscriptionEngine = 'whisper',
  preferences: { preferSmallModel?: boolean } = {}
): TranscriptionService {
  return {
    isAvailable: () => resolveTranscription(engine).service.isAvailable(),
    async transcribe(input, options = {}) {
      const selected = resolveTranscription(engine).engine
      const routeId = await routeForTranscription(
        selected,
        options.model,
        preferences.preferSmallModel === true
      )
      const result = await generateDesktopOperation(
        {
          type: 'transcription',
          audio: { type: 'audio', uri: input.path },
          modelId: options.model,
          language: options.language,
          suppressNonSpeech: options.suppressNonSpeech,
          alreadyWav16k: options.alreadyWav16k,
          prompt: options.prompt,
          timestamps: options.timestamps
        },
        {
          profile: 'transcription',
          routeId,
          signal: options.signal
        }
      )
      if (result.output.type !== 'transcription') {
        throw new Error('The transcription engine returned no transcript.')
      }
      return {
        text: result.output.text,
        language: result.output.language,
        segments: result.output.segments
      }
    }
  }
}

export type TranscriptionSettingReader = (key: string, fallback: string) => string

export function getActiveTranscription(
  readSetting: TranscriptionSettingReader = getSetting
): TranscriptionService {
  const active = activeDesktopModelId('transcription')
  const engine = transcriptionEngineForActiveModel(active, modelsByKind('transcription'))
  const language = resolveSupportedTranscriptionLanguage(
    readSetting('sttLanguage', 'auto'),
    transcriptionLanguages(engine, active)
  )
  return withConfiguredTranscriptionLanguage(getGenerationTranscription(engine), language)
}

export function getNativeTranscriptionForRoute(
  model: { id: string; providerId?: string; residencyLifecycle?: string },
  readSetting: TranscriptionSettingReader = getSetting
): TranscriptionService {
  const engine = transcriptionEngineForRoute(model)
  const selected = resolveTranscription(
    engine,
    model.residencyLifecycle === 'persistent' ? 'resident' : 'on-demand'
  ).engine
  const language = resolveSupportedTranscriptionLanguage(
    readSetting('sttLanguage', 'auto'),
    transcriptionLanguages(engine, model.id)
  )
  return withConfiguredTranscriptionLanguage(getTranscription(selected), language)
}

export function withConfiguredTranscriptionLanguage(
  service: TranscriptionService,
  language: string
): TranscriptionService {
  return {
    isAvailable: () => service.isAvailable(),
    transcribe: (input: { path: string }, options?: TranscribeOptions) =>
      service.transcribe(input, { language, ...options })
  }
}

export interface ActiveTranscriptionInfo {
  engine: TranscriptionEngine
  modelId: string | null
  label: string
}

export interface InstalledTranscriptionEntry extends TranscriptionCatalogEntry {}

export function transcriptionActiveInfo(
  info: ActiveTranscriptionInfo,
  installed: readonly InstalledTranscriptionEntry[],
  configuredLanguage: string
): ActiveTranscriptionInfo & {
  language: string
  languages: readonly SpeechLanguage[]
  options: ReturnType<typeof buildTranscriptionModelOptions>
} {
  const activeEntry = installed.find((entry) => transcriptionEntryMatches(entry, info.modelId))
  const languages = transcriptionLanguages(info.engine, activeEntry?.familyId ?? info.modelId)
  return {
    ...info,
    language: resolveSupportedTranscriptionLanguage(configuredLanguage, languages),
    languages,
    options: buildTranscriptionModelOptions(info.modelId, installed)
  }
}

export function effectiveEngine(engine: TranscriptionEngine): TranscriptionEngine {
  return resolveTranscription(engine).engine
}

export function getActiveTranscriptionInfo(): ActiveTranscriptionInfo {
  const active = activeDesktopModelId('transcription')
  const entries = modelsByKind('transcription')
  const engine = effectiveEngine(transcriptionEngineForActiveModel(active, entries))
  return transcriptionProvenance(engine, active, entries)
}

export function parakeetAvailable(): boolean {
  return parakeet.isAvailable()
}

export function residentWhisperAvailable(): boolean {
  return whisperResident.isAvailable()
}

export const sttRuntime: DesktopManagedRuntime = {
  modality: 'stt',
  evict: () => whisperServer.stop(),
  warm: () => {},
  release: () => whisperServer.stop()
}
