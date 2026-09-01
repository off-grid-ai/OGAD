import {
  buildTranscriptionModelOptions,
  residentAwareTranscriptionEngine,
  resolveSupportedTranscriptionLanguage,
  selectAvailableTranscriptionEngine,
  transcriptionEngineForActiveModel,
  transcriptionEntryMatches,
  transcriptionProvenance,
  type CatalogTranscriptionEngine,
  type TranscriptionCatalogEntry,
  type TranscriptionEngine,
  type TranscriptionResidencyMode
} from '@offgrid/models'
import { transcriptionLanguages, type SpeechLanguage } from '@offgrid/speech'
import { getActiveModal } from '../active-models'
import { getSetting } from '../database'
import { generateDesktopOperation } from '../desktop-generation'
import type { ManagedRuntimePort as ManagedRuntime } from '@offgrid/models'
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
  mode?: TranscriptionResidencyMode
): { service: TranscriptionService; engine: TranscriptionEngine; fellBack: boolean } {
  const requested =
    mode == null || engine === 'whisper-resident'
      ? engine
      : residentAwareTranscriptionEngine(engine, mode)
  return pickTranscription(requested, ALL)
}

export function getTranscription(engine: TranscriptionEngine = 'whisper'): TranscriptionService {
  return resolveTranscription(engine).service
}

export type TranscriptionSettingReader = (key: string, fallback: string) => string

export function getActiveNativeTranscription(
  readSetting: TranscriptionSettingReader = getSetting
): TranscriptionService {
  const active = getActiveModal('transcription')
  const engine = transcriptionEngineForActiveModel(active, modelsByKind('transcription'))
  const language = resolveSupportedTranscriptionLanguage(
    readSetting('sttLanguage', 'auto'),
    transcriptionLanguages(engine, active)
  )
  return withConfiguredTranscriptionLanguage(getTranscription(engine), language)
}

export function getActiveTranscription(
  readSetting: TranscriptionSettingReader = getSetting
): TranscriptionService {
  const native = getActiveNativeTranscription(readSetting)
  return {
    isAvailable: () => native.isAvailable(),
    async transcribe(input, options = {}) {
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
        { signal: options.signal, allowFallback: true, timeoutMs: 30 * 60 * 1000 }
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
  const active = getActiveModal('transcription')
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

export const sttRuntime: ManagedRuntime = {
  modality: 'stt',
  evict: () => whisperServer.stop(),
  warm: () => {},
  release: () => whisperServer.stop()
}
