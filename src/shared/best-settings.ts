// "Use the fastest settings": one pure decision from the detected machine and the active
// chat model to every speed setting the app owns (each modality's processor, the chat
// engine's launch settings, which engines stay in memory, and the screenshot size).
// The main process detects the hardware and applies the plan; this file only decides.

import {
  fastestKvCache,
  planFastestSettings,
  METAL_WORKING_SET_SHARE,
  type GpuPlacement,
  type SpeedDeviceClass,
  type SpeedSpeculativeMode
} from '@offgrid/models'
import { type BackendModality, type BackendPreference } from './backend-preferences'
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
  /** VRAM of the GPU in GB, or null when the engine did not report it. A Mac uses the Metal
   *  working set of its unified memory instead. */
  gpuMemoryGb?: number | null
}

export interface ChatModelProfile {
  /** Model weights plus projector and companion files, in GB. */
  weightsGb: number
  supportsMtp: boolean
  modelMaxCtx: number | null
  /** A mixture-of-experts model. */
  isMoe?: boolean
  hasMmproj?: boolean
  /** The person's own draft-model or DFlash choice, kept by the plan. */
  ownSpeculation?: { mode: 'draft' | 'dflash'; draftModel: string; draftMax: number }
}

export interface BestChatSettings {
  gpuPlacement: GpuPlacement
  gpuLayers: number
  flashAttn: boolean
  kvCacheType: KvCache
  ctxSize: number
  threads: number
  speculativeDecoding: SpeedSpeculativeMode
  speculativeDraftMax: number
  draftModel: string
}

export interface BestSettingsPlan {
  chat: BestChatSettings
  backends: Record<BackendModality, BackendPreference>
  residency: Partial<Record<Modality, 'resident'>>
  screenshotSize: 'balanced'
  /** Video skips CPU offload and VAE tiling when the GPU has enough free memory. Video is never
   *  kept in memory: it loads for each clip and frees the GPU after. */
  videoMemory: 'fit'
  /** One plain line per area, shown to the person after the settings apply. */
  summary: string[]
}

const BACKEND_ORDER: BackendModality[] = [
  'llm',
  'image',
  'video',
  'stt',
  'tts',
  'grounding',
  'decision',
  'embeddings'
]
const MANY_RAM_GB = 32
const ENOUGH_RAM_GB = 16

/** The fastest available processor for one modality, chosen from what the platform offers. */
function bestBackend(): BackendPreference {
  return 'auto'
}

/** f16 when RAM holds the context at full precision (the reference path), else the
 *  lightest quantization that still fits. */
export function bestKvCache(ctxSize: number, totalRamGb: number, weightsGb: number): KvCache {
  return fastestKvCache(ctxSize, totalRamGb, weightsGb)
}

/** The row of the shared fastest-settings table this machine belongs to. */
export function speedDeviceClass(machine: Pick<MachineProfile, 'platform' | 'gpu'>): SpeedDeviceClass {
  if (machine.platform === 'darwin') return 'mac'
  if (machine.gpu === 'CUDA') return 'cuda'
  if (machine.gpu === 'Vulkan') return 'vulkan'
  return 'cpu'
}

/** The memory the GPU can hold the model in: the Metal working set on a Mac, VRAM elsewhere. */
function gpuMemoryGb(machine: MachineProfile): number | null {
  if (machine.platform === 'darwin') return machine.totalRamGb * METAL_WORKING_SET_SHARE
  return machine.gpu ? (machine.gpuMemoryGb ?? null) : null
}

function bestChatSettings(machine: MachineProfile, model: ChatModelProfile): BestChatSettings {
  const ctxSize =
    model.modelMaxCtx && model.modelMaxCtx > 0
      ? Math.min(DEFAULT_CTX_SIZE, model.modelMaxCtx)
      : DEFAULT_CTX_SIZE
  // The rules live in the shared table (@offgrid/models planFastestSettings): Auto GPU placement,
  // MTP only when the whole model fits in GPU memory, n-gram when the model has no MTP head. The
  // person's own draft-model or DFlash choice is kept.
  const own = model.ownSpeculation
  const plan = planFastestSettings({
    machine: {
      device: speedDeviceClass(machine),
      totalRamGb: machine.totalRamGb,
      gpuMemoryGb: gpuMemoryGb(machine),
      performanceCores: machine.performanceCores
    },
    model: {
      weightsGb: model.weightsGb,
      isMoe: model.isMoe === true,
      hasMtpHead: model.supportsMtp,
      hasMmproj: model.hasMmproj === true
    },
    ctxSize,
    overrides: own ? { speculativeDecoding: own.mode, speculativeDraftMax: own.draftMax } : {}
  })
  return {
    gpuPlacement: plan.gpuPlacement,
    gpuLayers: plan.gpuLayers,
    flashAttn: plan.flashAttn,
    kvCacheType: plan.kvCacheType,
    ctxSize,
    threads: plan.threads,
    speculativeDecoding: plan.speculativeDecoding,
    speculativeDraftMax: plan.speculativeDraftMax,
    draftModel: own ? own.draftModel : ''
  }
}

/** Engines kept in memory skip their cold start. More RAM keeps more of them ready. */
function bestResidency(totalRamGb: number): Partial<Record<Modality, 'resident'>> {
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

const SPECULATION_LABEL: Record<SpeedSpeculativeMode, (draftMax: number) => string> = {
  mtp: (draftMax) => `MTP with ${draftMax} draft tokens`,
  ngram: () => 'n-gram speculation',
  draft: () => 'your draft model',
  dflash: () => 'your DFlash model',
  off: () => 'no speculative decoding'
}

function summarize(machine: MachineProfile, plan: Omit<BestSettingsPlan, 'summary'>): string[] {
  const { chat } = plan
  const speculation = SPECULATION_LABEL[chat.speculativeDecoding](chat.speculativeDraftMax)
  const kept = (Object.keys(plan.residency) as Modality[]).map((m) => KEPT_LABEL[m] ?? m)
  return [
    `Chat and vision run on the ${processorName(machine)} with ${machine.gpu ? 'automatic GPU placement' : `${chat.threads} CPU threads`}, ${speculation}, ${KV_LABEL[chat.kvCacheType]} and a ${chat.ctxSize / 1024}K context.`,
    'Auto picks the fastest processor that works on this computer.',
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
    BACKEND_ORDER.map((modality) => [modality, bestBackend()])
  ) as Record<BackendModality, BackendPreference>
  const plan = {
    chat: bestChatSettings(machine, model),
    backends,
    residency: bestResidency(machine.totalRamGb),
    screenshotSize: 'balanced' as const,
    videoMemory: 'fit' as const
  }
  return { ...plan, summary: summarize(machine, plan) }
}

export interface CurrentSpeedSettings {
  chat: Partial<Record<keyof BestChatSettings, unknown>>
  backends: Partial<Record<BackendModality, BackendPreference>>
  residency: Partial<Record<Modality, string>>
  screenshotSize: string
  videoMemory?: string
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
      : key === 'gpuLayers'
        ? (current.chat.gpuLayers === 99 ? null : current.chat.gpuLayers) ===
          (plan.chat.gpuLayers === 99 ? null : plan.chat.gpuLayers)
        : current.chat[key] === plan.chat[key]
  )
  return (
    chatMatches &&
    BACKEND_ORDER.every((modality) => current.backends[modality] === plan.backends[modality]) &&
    Object.entries(plan.residency).every(
      ([modality, mode]) => current.residency[modality as Modality] === mode
    ) &&
    current.screenshotSize === plan.screenshotSize &&
    current.videoMemory === plan.videoMemory
  )
}

/** Hardware and model identity: a change in either deserves a fresh plan. */
export function bestSettingsFingerprint(machine: MachineProfile, modelFile: string): string {
  return [machine.platform, machine.gpu ?? 'cpu', Math.round(machine.totalRamGb), modelFile].join(
    '|'
  )
}

const SPEED_FIELDS: (keyof BestChatSettings)[] = [
  'gpuPlacement',
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
