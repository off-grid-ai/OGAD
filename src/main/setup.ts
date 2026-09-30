import { runtimeBackendSnapshot } from './runtime-backends'
// Unified setup + system-health surface. Two jobs:
//   1. getSystemHealth() — one aggregated snapshot of every local component
//      (chat LLM / gateway / vision / embeddings / STT / TTS / image gen) so the
//      Settings → Health panel can show what's running at a glance.
//   2. autoConfigure() — the "Configure for me" action: pick a model that fits
//      this machine's RAM, download it, activate it, start llama-server, verify.
//
// Everything here is on-device; no network except the model download itself.
import os from 'os'
import { videoPackError } from '@offgrid/models'
import { totalBytes } from './model-sizing'
import { findSdBinary } from './imagegen/sd-runtime'
import { ffmpegBin } from './transcription/whisper-cli'
import { getEmbeddingSetupModel, downloadEmbeddingModel } from './embedding-setup-download'
import { modalityForKind } from './active-models-logic'
import * as http from 'http'
import { llm } from './llm'
import { decideChatStatus } from './chat-health'
import {
  getActiveModel,
  getActiveModalities,
  downloadModel,
  cancelDownload,
  listInstalled,
  setActiveModel,
  setActiveModalChoice,
  BONSAI_2,
  desktopCatalog
} from './models-manager'
import { getGatewayPort } from './model-server'
import type {
  SystemHealthComponentContract,
  SystemHealthComponentStatusContract,
  SystemHealthContract
} from '../shared/ipc-contracts'
import type { RecMode } from './models/setup-types'
import { getNativeHelperHealth } from './native-helper-health'
import {
  normalizeMode,
  recommendBudgetFraction,
  baselineExtras,
  totalDownloadGb,
  fitMessage,
  type SetupItemKind
} from './models/setup-logic'

export type ComponentStatus = SystemHealthComponentStatusContract
export type HealthComponent = SystemHealthComponentContract
export type SystemHealth = SystemHealthContract

export interface SetupProgress {
  phase: 'select' | 'download' | 'activate' | 'start' | 'verify' | 'done' | 'error'
  message: string
  modelId?: string
  modelName?: string
  percent?: number
  downloadedMB?: string
  totalMB?: string
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
}
export type SetupProgressCb = (p: SetupProgress) => void

/** GET a localhost endpoint, parse JSON, with a short timeout. null on any failure. */
function pingJson(port: number, path = '/health', timeoutMs = 1500): Promise<unknown | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume()
        resolve(null)
        return
      }
      let body = ''
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(body ? {} : null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

function ramGb(): number {
  return Math.round(os.totalmem() / 1e9)
}

/** The authoritative live health record for the chat engine. Sidebar status and
 * the full System Health snapshot both use this owner, so they cannot disagree.
 * This deliberately probes only llama-server; callers that need the complete
 * machine record must use getSystemHealth(). */
export async function getChatHealth(): Promise<HealthComponent> {
  const activeModel = getActiveModel()
  const modelsExist = llm.modelsExist()
  const llamaHealth = await pingJson(llm.getPort())
  const { status, detail } = decideChatStatus({
    // A healthy socket is not sufficient: another app/profile can own this port.
    healthy: !!llamaHealth && llm.isReady(),
    loading: llm.isStarting(),
    modelsExist,
    activeModel,
    lastError: llm.lastError()
  })

  return {
    id: 'chat',
    label: 'Chat model (llama-server)',
    status,
    detail,
    port: llm.getPort(),
    canRestart: modelsExist
  }
}

/** One aggregated snapshot of every local component. */
export async function getSystemHealth(): Promise<SystemHealth> {
  const activeModel = getActiveModel()

  // Live probes (run in parallel): the authoritative chat record and the gateway.
  const [chatHealth, gatewayHealth] = await Promise.all([
    getChatHealth(),
    pingJson(getGatewayPort())
  ])

  // Image generation is checked in-process (no HTTP) so it works even if the
  // gateway is down.
  let image: { available: boolean; reason?: string } = { available: false }
  try {
    const { imageGenStatus } = await import('./imagegen')
    const s = imageGenStatus()
    image = { available: s.available, reason: s.reason }
  } catch {
    /* imagegen unavailable */
  }

  const { videoGenStatus } = await import('./videogen')
  const video = videoGenStatus({ localOnly: true })

  const gw = (gatewayHealth ?? {}) as { modalities?: Record<string, string> }
  const modality = (k: string): ComponentStatus => {
    if (!gatewayHealth) return 'down'
    const v = gw.modalities?.[k]
    return v === 'ready' ? 'ready' : v === 'not_installed' ? 'not_installed' : 'down'
  }

  const components: HealthComponent[] = [
    chatHealth,
    {
      id: 'gateway',
      label: 'Local gateway',
      status: gatewayHealth ? 'ready' : 'down',
      detail: gatewayHealth ? 'OpenAI-compatible API' : 'Not responding',
      port: getGatewayPort(),
      canRestart: true
    },
    {
      id: 'vision',
      label: 'Vision (image understanding)',
      status: modality('vision_understanding')
    },
    { id: 'embeddings', label: 'Embeddings (search/RAG)', status: modality('embeddings') },
    { id: 'transcription', label: 'Speech-to-text (whisper)', status: modality('transcription') },
    { id: 'speech', label: 'Text-to-speech', status: modality('speech') },
    {
      id: 'image',
      label: 'Image generation',
      status: image.available ? 'ready' : 'not_installed',
      detail: image.available ? undefined : (image.reason ?? 'No image model installed')
    },
    {
      id: 'video',
      label: 'Video generation',
      status: video.available ? 'ready' : 'not_installed',
      detail: video.available ? undefined : video.reason
    },
    ...(['grounding', 'decision'] as const).map((id): HealthComponent => {
      const runtime = runtimeBackendSnapshot().find((entry) => entry.id === id)
      return {
        id,
        label: id === 'grounding' ? 'Computer Use grounding' : 'Computer / Web Use decision',
        status:
          runtime?.state === 'loaded'
            ? 'ready'
            : runtime?.state === 'loading'
              ? 'starting'
              : runtime?.state === 'error'
                ? 'down'
                : 'idle',
        detail: runtime?.state === 'error' ? runtime.detail : undefined
      }
    }),
    ...getNativeHelperHealth()
  ]

  return { ramGb: ramGb(), activeModel, components }
}

/** Choose the best chat/vision model that fits this machine's RAM. Prefers a
 *  vision model (so chat supports images) at the largest size the RAM tier
 *  allows; falls back to text, then to a safe small default. */
export type { RecMode } from './models/setup-types'

/** Read performanceMode from settings, normalized to a RecMode (defaults balanced). */
function settingsMode(): RecMode {
  try {
    return normalizeMode((llm.getSettings() as { performanceMode?: string }).performanceMode)
  } catch {
    return 'balanced'
  }
}

export async function recommendChatModel(
  modeOverride?: RecMode
): Promise<{ id: string; name: string } | null> {
  const { recommendForRam } = await import('@offgrid/models')
  const CATALOG = await desktopCatalog()
  const { chooseChatModel, recommendedParamCeiling, preferredModelIds, modeBudget } =
    await import('./model-sizing')
  const gb = ramGb()
  const tier = recommendForRam(gb)
  const mode: RecMode = modeOverride ?? settingsMode()
  const frac = recommendBudgetFraction(mode)
  const budget = gb * frac * 1e9
  // Bonsai's packed PQ2 weights fit the Balanced loader's memory envelope at
  // 16 GB, even though they exceed the general 38% recommendation budget. Leave
  // room for context and the loader's normal reserve before recommending it.
  const { frac: balancedFrac, reserveGb } = modeBudget('balanced')
  if (
    mode === 'balanced' &&
    gb >= (BONSAI_2.minRamGb ?? 0) &&
    totalBytes(BONSAI_2) / 1e9 + reserveGb + 0.5 <= gb * balancedFrac
  ) {
    return { id: BONSAI_2.id, name: BONSAI_2.name }
  }
  // 1) Curated default for the tier, if it fits the normal recommendation budget.
  for (const id of preferredModelIds(gb, mode)) {
    const e = CATALOG.find((m) => m.id === id)
    if (e && totalBytes(e as never) <= budget) return { id: e.id, name: e.name }
  }
  // 2) Otherwise the size heuristic, capped by recommended params (8B only ≥24GB).
  const maxParams = Math.min(tier.maxParams, recommendedParamCeiling(gb, mode))
  const pick = chooseChatModel(CATALOG as never, gb, maxParams, frac) as {
    id: string
    name: string
  } | null
  return pick ? { id: pick.id, name: pick.name } : null
}

export interface FitEstimate {
  level: 'ok' | 'tight' | 'risky'
  ramGb: number
  weightsGb: number
  message: string
}

/** Estimate whether a model fits this machine's RAM comfortably, for a pre-activate
 *  warning. 'ok' = plenty of headroom; 'tight' = works but context will be reduced;
 *  'risky' = weights alone are a large fraction of RAM (slow / may fail to load). */
export async function estimateModelFit(modelId: string): Promise<FitEstimate> {
  const gb = ramGb()
  try {
    const { resolveHuggingFaceModel } = await import('@offgrid/models')
    const CATALOG = await desktopCatalog()
    const entry = CATALOG.find((m) => m.id === modelId) ?? (await resolveHuggingFaceModel(modelId))
    const { fitLevel } = await import('./model-sizing')
    const weightsGb =
      (entry?.files.reduce((s: number, f: { sizeBytes?: number }) => s + (f.sizeBytes ?? 0), 0) ??
        0) / 1e9
    if (!weightsGb) return { level: 'ok', ramGb: gb, weightsGb: 0, message: '' }
    const level: FitEstimate['level'] = fitLevel(weightsGb, gb)
    return { level, ramGb: gb, weightsGb, message: fitMessage(level, weightsGb, gb) }
  } catch {
    return { level: 'ok', ramGb: gb, weightsGb: 0, message: '' }
  }
}

export interface Recommendation {
  id: string
  name: string
  sizeGb: number
  ramGb: number
  installed: boolean
  mode: RecMode
}

/** Preview what "Configure for me" would pick for a given mode (no side effects),
 *  so the setup UI can show the exact model + size before the user commits. */
export async function getRecommendation(mode?: RecMode): Promise<Recommendation | null> {
  const pick = await recommendChatModel(mode)
  if (!pick) return null
  const CATALOG = await desktopCatalog()
  const entry = CATALOG.find((m) => m.id === pick.id)
  const sizeGb =
    (entry?.files.reduce((s: number, f: { sizeBytes?: number }) => s + (f.sizeBytes ?? 0), 0) ??
      0) / 1e9
  let installed = false
  try {
    installed = (await listInstalled()).includes(pick.id)
  } catch {
    /* ignore */
  }
  const effMode: RecMode = mode ?? settingsMode()
  return { id: pick.id, name: pick.name, sizeGb, ramGb: ramGb(), installed, mode: effMode }
}

export type { SetupItemKind } from './models/setup-logic'
export interface SetupItem {
  kind: SetupItemKind
  capability: string // user-facing: "Chat & vision", "Speech-to-text", …
  id: string
  name: string
  sizeGb: number
  installed: boolean
  downloadSizeGb?: number
  files?: { name: string; sizeBytes?: number }[]
  required: boolean // legacy default-plan priority; explicit selections can omit chat
}
export interface SetupPlan {
  mode: RecMode
  ramGb: number
  items: SetupItem[]
  totalDownloadGb: number
  videoNote?: string
  videoRuntimeIssue?: string
  embeddingNote?: string
}

/** The full set of models "Configure for me" will set up for a mode: the chat/vision
 *  model plus speech-to-text, text-to-speech, and optional image/video packs. Pure
 *  preview — no downloads — so the UI can list everything before the user commits.
 *  autoConfigure() consumes the same plan, so the preview and the action never drift. */
export async function getSetupPlan(mode?: RecMode): Promise<SetupPlan> {
  const effMode: RecMode = mode ?? settingsMode()
  const CATALOG = await desktopCatalog()
  let installed: string[] = []
  try {
    installed = await listInstalled()
  } catch {
    /* ignore */
  }
  const sizeOf = (id: string): number => {
    const e = CATALOG.find((m) => m.id === id)
    return (
      (e?.files.reduce((s: number, f: { sizeBytes?: number }) => s + (f.sizeBytes ?? 0), 0) ?? 0) /
      1e9
    )
  }
  const nameOf = (id: string, fallback: string): string =>
    CATALOG.find((m) => m.id === id)?.name ?? fallback

  const items: SetupItem[] = []
  const chat = await recommendChatModel(effMode)
  if (chat)
    items.push({
      kind: 'chat',
      capability: 'Chat & vision',
      id: chat.id,
      name: chat.name,
      sizeGb: sizeOf(chat.id),
      installed: installed.includes(chat.id),
      required: true
    })
  // The non-chat baseline (STT, TTS, and optional image models) - order + the
  // per-mode STT tier come from the single source of truth in setup-logic.
  for (const ex of baselineExtras(effMode)) {
    items.push({
      kind: ex.kind,
      capability: ex.capability,
      id: ex.id,
      name: nameOf(ex.id, ex.fallbackName),
      sizeGb: sizeOf(ex.id),
      installed: installed.includes(ex.id),
      required: false
    })
  }

  const embedding = getEmbeddingSetupModel()
  if (embedding) {
    items.push({
      kind: 'embedding',
      capability: 'Search embeddings',
      id: embedding.id,
      name: embedding.name,
      sizeGb: embedding.totalBytes / 1e9,
      downloadSizeGb: embedding.remainingBytes / 1e9,
      files: embedding.files,
      installed: embedding.installed,
      required: false
    })
  }
  const embeddingNote = embedding
    ? 'Embedding setup downloads files only. It does not change the active model or rebuild search indexes.'
    : 'Your custom embedding choice is kept. Its download size is not in the setup catalog; manage it in Models.'

  // Pack bytes describe the download, not resident video memory. Catalog RAM
  // guidance is advisory; Auto Setup does not verify runtime fit or output quality.
  let videoNote: string | undefined
  const video = CATALOG.filter(
    (entry) =>
      entry.kind === 'video' &&
      entry.availability !== 'coming_soon' &&
      !videoPackError(entry.files) &&
      entry.files.every((file) => (file.sizeBytes ?? 0) > 0)
  ).sort((a, b) => totalBytes(a) - totalBytes(b))[0]
  if (video) {
    items.push({
      kind: 'video',
      capability: 'Video generation',
      id: video.id,
      name: video.name,
      sizeGb: totalBytes(video) / 1e9,
      files: video.files.map(({ name, sizeBytes }) => ({ name, sizeBytes })),
      installed: installed.includes(video.id),
      required: false
    })
    const guidance = video.minRamGb ? `Catalog RAM guidance: ${video.minRamGb} GB. ` : ''
    videoNote = `${guidance}Video runtime memory and output quality are not checked by Auto Setup.`
  } else {
    videoNote = 'The catalog has no complete supported video model pack.'
  }

  const missingRuntime = [
    !findSdBinary('sd-cli') ? 'video engine' : null,
    !ffmpegBin() ? 'video encoder' : null
  ].filter(Boolean)
  const videoRuntimeIssue = missingRuntime.length
    ? `This app installation is missing its ${missingRuntime.join(' and ')}. These files should be included. Reinstall or update the app package, then check again. Model downloads do not repair app files.`
    : undefined

  return {
    mode: effMode,
    ramGb: ramGb(),
    items,
    totalDownloadGb: totalDownloadGb(items),
    videoNote,
    videoRuntimeIssue,
    embeddingNote
  }
}

let embeddingDownload: { id: string; controller: AbortController } | null = null

/** Cancel the current setup download through its owning downloader. */
export function cancelSetupDownload(modelId: string): boolean {
  if (embeddingDownload?.id === modelId) {
    embeddingDownload.controller.abort()
    return true
  }
  return cancelDownload(modelId)
}

async function downloadSetupEmbedding(item: SetupItem, emit: SetupProgressCb): Promise<void> {
  if (embeddingDownload) throw new Error('An embedding download is already in progress.')
  const controller = new AbortController()
  embeddingDownload = { id: item.id, controller }
  try {
    emit({
      phase: 'download',
      message: `Downloading ${item.name}...`,
      modelId: item.id,
      percent: 0
    })
    await downloadEmbeddingModel(
      item.id,
      (p) =>
        emit({
          phase: 'download',
          message: `Downloading ${item.name}...`,
          modelId: item.id,
          downloadedBytes: p.downloadedBytes,
          totalBytes: p.totalBytes
        }),
      controller.signal
    )
    if (controller.signal.aborted) throw new Error('Download canceled.')
  } finally {
    embeddingDownload = null
  }
}

/** "Configure for me": pick → download (if needed) → activate → start → verify. */
export async function autoConfigure(
  onProgress?: SetupProgressCb,
  selectedModelIds?: string[],
  mode?: RecMode
): Promise<{ success: boolean; error?: string; modelId?: string; modelName?: string }> {
  const emit = (p: SetupProgress): void => {
    try {
      onProgress?.(p)
    } catch {
      /* ignore */
    }
  }
  const fail = (
    message: string,
    modelId?: string
  ): { success: false; error: string; modelId?: string } => {
    emit({ phase: 'error', message, modelId })
    return { success: false, error: message, modelId }
  }

  emit({ phase: 'select', message: 'Checking selected local models...' })
  const plan = await getSetupPlan(mode)
  // Accept only IDs from the current hardware-checked plan. A stale preview must
  // be refreshed instead of silently downloading a different model.
  if (
    selectedModelIds !== undefined &&
    (!Array.isArray(selectedModelIds) ||
      selectedModelIds.some(
        (id) => typeof id !== 'string' || !plan.items.some((item) => item.id === id)
      ))
  ) {
    return fail('The setup plan changed. Select a resource mode to refresh it, then try again.')
  }
  const selected = selectedModelIds === undefined ? null : new Set(selectedModelIds)
  const items = plan.items.filter((item) => !selected || selected.has(item.id))
  if (!items.length) return fail('Select at least one model to set up.')

  let activatedChat: SetupItem | undefined
  for (const item of items) {
    try {
      if (item.kind === 'embedding') {
        await downloadSetupEmbedding(item, emit)
        // Download-only: activation belongs to the explicit Models confirmation flow.
        continue
      }
      if (!(await listInstalled()).includes(item.id)) {
        const report = (p: Partial<SetupProgress>): void =>
          emit({
            ...p,
            phase: 'download',
            message: `Downloading ${item.name}...`,
            modelId: item.id,
            modelName: item.name
          })
        report({ percent: 0 })
        const result = await downloadModel(item.id, (p) =>
          report({
            percent: p.percent,
            downloadedMB: p.downloadedMB,
            totalMB: p.totalMB,
            downloadedBytes: p.downloadedBytes,
            totalBytes: p.totalBytes,
            bytesPerSecond: p.bytesPerSecond
          })
        )
        // Stop on cancellation or failure. Never continue into another large pack.
        if (!result.success) return fail(result.error ?? 'Download failed.', item.id)
      }

      if (item.kind === 'chat') {
        // Preserve local and remote choices, including choices made during download.
        if (getActiveModalities().text) continue
        emit({ phase: 'activate', message: `Activating ${item.name}...`, modelId: item.id })
        const result = await setActiveModel(item.id)
        if (!result.success) return fail(result.error ?? 'Activation failed.', item.id)
        emit({ phase: 'start', message: 'Starting the local model server...', modelId: item.id })
        await llm.restart()
        emit({ phase: 'verify', message: 'Verifying...', modelId: item.id })
        if (!(await pingJson(llm.getPort(), '/health', 3000))) {
          return fail(`${item.name} is installed, but the local server is not ready.`, item.id)
        }
        activatedChat = item
      } else {
        const modality = modalityForKind(item.kind)
        if (modality && !getActiveModalities()[modality]) {
          const result = await setActiveModalChoice(item.kind, item.id)
          if (!result.success) return fail(result.error ?? 'Activation failed.', item.id)
        }
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Setup failed.', item.id)
    }
  }

  const activeIdentity = activatedChat && {
    modelId: activatedChat.id,
    modelName: activatedChat.name
  }
  emit({
    phase: 'done',
    message: 'Selected model files are installed. Saved active model choices are unchanged.',
    ...activeIdentity
  })
  return { success: true, ...activeIdentity }
}
