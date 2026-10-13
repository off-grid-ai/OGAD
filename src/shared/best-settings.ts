// "Use the fastest settings": one pure decision from the detected machine and the active
// chat model to every speed setting the app owns (each modality's processor, the chat
// engine's launch settings, which engines stay in memory, and the screenshot size).
// The main process detects the hardware and applies the plan; this file only decides.

import { backendChoices, type BackendModality, type BackendPreference } from './backend-preferences'
import { DEFAULT_CTX_SIZE } from './llm-defaults'
import type { Modality } from './runtime-residency-types'

export type NativeGpu = 'Metal' | 'CUDA' | 'Vulkan'
type KvCache = 'f16' | 'q8_0' | 'q4_0'

export interface MachineProfile {
  platform: string
  cpuModel: string
  /** Cores llama.cpp should use when the model runs on the CPU (performance cores on Apple). */
  performanceCores: number
  totalRamGb: number
  /** The GPU backend a bundled llama.cpp engine proved it can use, or null for CPU only. */
  gpu: NativeGpu | null
}

export interface ChatModelProfile {
  /** Model weights plus projector and companion files, in GB. */
  weightsGb: number
  supportsMtp: boolean
  modelMaxCtx: number | null
}

export interface BestChatSettings {
  gpuLayers: number
  flashAttn: boolean
  kvCacheType: KvCache
  ctxSize: number
  threads: number
  speculativeDecoding: 'mtp' | 'off'
  speculativeDraftMax: number
  draftModel: string
}

export interface BestSettingsPlan {
  chat: BestChatSettings
  backends: Record<BackendModality, BackendPreference>
  residency: Partial<Record<Modality, 'resident'>>
  screenshotSize: 'balanced'
  /** One plain line per area, shown to the person after the settings apply. */
  summary: string[]
}

const BACKEND_ORDER: BackendModality[] = [
  'llm',
  'image',
  'stt',
  'tts',
  'grounding',
  'decision',
  'embeddings'
]
// KV cache cost per 1K tokens for an ~8B model; larger estimates keep the choice safe.
const KV_GB_PER_1K: Record<KvCache, number> = { f16: 0.16, q8_0: 0.085, q4_0: 0.05 }
// Share of RAM the chat model may use, matching the Balanced budget the app loads with.
const CHAT_RAM_SHARE = 0.65
const RAM_RESERVE_GB = 1.5
const MTP_DRAFT_TOKENS = 2
const MANY_RAM_GB = 32
const ENOUGH_RAM_GB = 16

/** The fastest available processor for one modality, chosen from what the platform offers. */
export function bestBackend(
  modality: BackendModality,
  machine: Pick<MachineProfile, 'platform' | 'gpu'>
): BackendPreference {
  const offered = backendChoices(modality, machine.platform)
  const wanted: BackendPreference[] =
    machine.platform === 'darwin'
      ? ['metal']
      : machine.gpu === 'CUDA'
        ? ['cuda', 'directml', 'vulkan']
        : machine.gpu === 'Vulkan'
          ? ['vulkan', 'directml']
          : []
  return wanted.find((choice) => offered.includes(choice)) ?? 'auto'
}

/** f16 when RAM holds the context at full precision (the reference path), else the
 *  lightest quantization that still fits. */
export function bestKvCache(ctxSize: number, totalRamGb: number, weightsGb: number): KvCache {
  const budgetGb = totalRamGb * CHAT_RAM_SHARE - weightsGb - RAM_RESERVE_GB
  const fits = (kv: KvCache): boolean => (ctxSize / 1000) * KV_GB_PER_1K[kv] <= budgetGb
  return fits('f16') ? 'f16' : fits('q8_0') ? 'q8_0' : 'q4_0'
}

export function bestChatSettings(
  machine: MachineProfile,
  model: ChatModelProfile
): BestChatSettings {
  const ctxSize =
    model.modelMaxCtx && model.modelMaxCtx > 0
      ? Math.min(DEFAULT_CTX_SIZE, model.modelMaxCtx)
      : DEFAULT_CTX_SIZE
  return {
    gpuLayers: machine.gpu ? 99 : 0,
    flashAttn: true,
    kvCacheType: bestKvCache(ctxSize, machine.totalRamGb, model.weightsGb),
    ctxSize,
    // With every layer on the GPU, llama.cpp picks its own thread count.
    threads: machine.gpu ? 0 : Math.max(1, machine.performanceCores),
    // MTP uses the model's own prediction heads. DFlash and draft models stay opt-in:
    // DFlash rejects image requests while a vision projector is loaded.
    speculativeDecoding: model.supportsMtp ? 'mtp' : 'off',
    speculativeDraftMax: model.supportsMtp ? MTP_DRAFT_TOKENS : 0,
    draftModel: ''
  }
}

/** Engines kept in memory skip their cold start. More RAM keeps more of them ready. */
export function bestResidency(totalRamGb: number): Partial<Record<Modality, 'resident'>> {
  if (totalRamGb >= MANY_RAM_GB) {
    return { image: 'resident', stt: 'resident', tts: 'resident', embeddings: 'resident' }
  }
  if (totalRamGb >= ENOUGH_RAM_GB)
    return { stt: 'resident', tts: 'resident', embeddings: 'resident' }
  return {}
}

function processorName(machine: MachineProfile): string {
  if (machine.gpu === 'Metal') return `${machine.cpuModel} GPU (Metal)`
  if (machine.gpu) return `GPU (${machine.gpu})`
  return `${machine.cpuModel} CPU`
}

const KEPT_LABEL: Partial<Record<Modality, string>> = {
  image: 'image generation',
  stt: 'transcription',
  tts: 'voice',
  embeddings: 'search'
}
const KV_LABEL: Record<KvCache, string> = {
  f16: 'a full-precision (f16) cache',
  q8_0: 'a q8_0 cache',
  q4_0: 'a q4_0 cache'
}

function summarize(machine: MachineProfile, plan: Omit<BestSettingsPlan, 'summary'>): string[] {
  const { chat } = plan
  const speculation =
    chat.speculativeDecoding === 'mtp'
      ? `MTP with ${chat.speculativeDraftMax} draft tokens`
      : 'no speculative decoding (this model has no MTP heads)'
  const kept = (Object.keys(plan.residency) as Modality[]).map((m) => KEPT_LABEL[m] ?? m)
  return [
    `Chat and vision run on the ${processorName(machine)} with ${chat.gpuLayers ? 'every layer offloaded' : `${chat.threads} CPU threads`}, ${speculation}, ${KV_LABEL[chat.kvCacheType]} and a ${chat.ctxSize / 1024}K context.`,
    `Images, voice, transcription and search use ${machine.platform === 'darwin' ? 'Metal and Core ML' : machine.gpu ? `the ${machine.gpu} GPU` : 'the best available processor'}.`,
    kept.length
      ? `Kept ready in memory: ${kept.join(', ')}.`
      : 'Models load when needed, leaving memory free on this machine.',
    'Computer Use sends 1440px screenshots, about half the reading time of 1920px.'
  ]
}

export function planBestSettings(
  machine: MachineProfile,
  model: ChatModelProfile
): BestSettingsPlan {
  const backends = Object.fromEntries(
    BACKEND_ORDER.map((modality) => [modality, bestBackend(modality, machine)])
  ) as Record<BackendModality, BackendPreference>
  const plan = {
    chat: bestChatSettings(machine, model),
    backends,
    residency: bestResidency(machine.totalRamGb),
    screenshotSize: 'balanced' as const
  }
  return { ...plan, summary: summarize(machine, plan) }
}

export interface CurrentSpeedSettings {
  chat: Partial<Record<keyof BestChatSettings, unknown>>
  backends: Partial<Record<BackendModality, BackendPreference>>
  residency: Partial<Record<Modality, string>>
  screenshotSize: string
}

/** True when every setting the plan chooses is already in place. */
export function matchesBestSettings(
  plan: BestSettingsPlan,
  current: CurrentSpeedSettings
): boolean {
  const chatMatches = (Object.keys(plan.chat) as (keyof BestChatSettings)[]).every((key) =>
    // An unset draft model and an empty one mean the same thing.
    key === 'draftModel'
      ? (current.chat.draftModel ?? '') === plan.chat.draftModel
      : current.chat[key] === plan.chat[key]
  )
  return (
    chatMatches &&
    BACKEND_ORDER.every((modality) => current.backends[modality] === plan.backends[modality]) &&
    Object.entries(plan.residency).every(
      ([modality, mode]) => current.residency[modality as Modality] === mode
    ) &&
    current.screenshotSize === plan.screenshotSize
  )
}

/** Hardware and model identity: a change in either deserves a fresh plan. */
export function bestSettingsFingerprint(machine: MachineProfile, modelFile: string): string {
  return [machine.platform, machine.gpu ?? 'cpu', Math.round(machine.totalRamGb), modelFile].join(
    '|'
  )
}

const SPEED_FIELDS: (keyof BestChatSettings)[] = [
  'gpuLayers',
  'flashAttn',
  'kvCacheType',
  'ctxSize',
  'threads',
  'speculativeDecoding',
  'speculativeDraftMax',
  'draftModel'
]

/** True when a settings change touches a speed setting, not just sampling or answers. */
export function isSpeedSettingsPatch(patch: object): boolean {
  return 'performanceMode' in patch || SPEED_FIELDS.some((field) => field in patch)
}
