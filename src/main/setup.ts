// Unified setup + system-health surface. Two jobs:
//   1. getSystemHealth() — one aggregated snapshot of every local component
//      (chat LLM / gateway / vision / embeddings / STT / TTS / image gen) so the
//      Settings → Health panel can show what's running at a glance.
//   2. autoConfigure() — the "Configure for me" action: pick a model that fits
//      this machine's RAM, download it, activate it, start llama-server, verify.
//
// Everything here is on-device; no network except the model download itself.
import os from 'os'
import * as http from 'http'
import { llm } from './llm'
import { decideChatStatus } from './chat-health'
import {
  getActiveModel,
  downloadModel,
  listInstalled,
  setActiveModel,
  setActiveModalChoice
} from './models-manager'
import { getGatewayPort } from './model-server'
import { deviceNoun } from '../shared/device'
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
  const {
    CATALOG,
    recommendForRam,
    chooseTextModel,
    recommendedTextModelParamCeiling,
    preferredTextModelIds,
    modelFileBytes
  } = await import('@offgrid/models')
  const gb = ramGb()
  const tier = recommendForRam(gb)
  const mode: RecMode = modeOverride ?? settingsMode()
  const frac = recommendBudgetFraction(mode)
  const budget = gb * frac * 1e9
  // 1) Curated default for the tier (16GB → Gemma 4 E2B), if it fits the budget.
  for (const id of preferredTextModelIds(gb, mode)) {
    const e = CATALOG.find((m) => m.id === id)
    if (e && modelFileBytes(e as never) <= budget) return { id: e.id, name: e.name }
  }
  // 2) Otherwise the size heuristic, capped by recommended params (8B only ≥24GB).
  const maxParams = Math.min(tier.maxParams, recommendedTextModelParamCeiling(gb, mode))
  const pick = chooseTextModel(CATALOG as never, gb, maxParams, frac) as {
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
    const { CATALOG, resolveHuggingFaceModel, fitLevel } = await import('@offgrid/models')
    const entry = CATALOG.find((m) => m.id === modelId) ?? (await resolveHuggingFaceModel(modelId))
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
  const { CATALOG } = await import('@offgrid/models')
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
  required: boolean // chat is required; the rest are best-effort extras
}
export interface SetupPlan {
  mode: RecMode
  ramGb: number
  items: SetupItem[]
  totalDownloadGb: number
}

/** The full set of models "Configure for me" will set up for a mode: the chat/vision
 *  model plus speech-to-text, text-to-speech, and (outside Conservative) image. Pure
 *  preview — no downloads — so the UI can list everything before the user commits.
 *  autoConfigure() consumes the same plan, so the preview and the action never drift. */
export async function getSetupPlan(mode?: RecMode): Promise<SetupPlan> {
  const effMode: RecMode = mode ?? settingsMode()
  const { CATALOG } = await import('@offgrid/models')
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
  // The non-chat baseline (STT, TTS, and image outside Conservative) - order + the
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

  return { mode: effMode, ramGb: ramGb(), items, totalDownloadGb: totalDownloadGb(items) }
}

/** "Configure for me": pick → download (if needed) → activate → start → verify. */
export async function autoConfigure(
  onProgress?: SetupProgressCb
): Promise<{ success: boolean; error?: string; modelId?: string; modelName?: string }> {
  const emit = (p: SetupProgress): void => {
    try {
      onProgress?.(p)
    } catch {
      /* ignore */
    }
  }

  emit({
    phase: 'select',
    message: `Picking a model that fits your ${deviceNoun(process.platform)}…`
  })
  const model = await recommendChatModel()
  if (!model) {
    emit({ phase: 'error', message: 'No suitable model found.' })
    return { success: false, error: 'no suitable model found' }
  }

  const installed = await listInstalled()
  if (!installed.includes(model.id)) {
    emit({
      phase: 'download',
      message: `Downloading ${model.name}…`,
      modelId: model.id,
      modelName: model.name,
      percent: 0
    })
    const res = await downloadModel(model.id, (p) =>
      emit({
        phase: 'download',
        message: `Downloading ${model.name}…`,
        modelId: model.id,
        modelName: model.name,
        percent: p.percent,
        downloadedMB: p.downloadedMB,
        totalMB: p.totalMB,
        downloadedBytes: p.downloadedBytes,
        totalBytes: p.totalBytes,
        bytesPerSecond: p.bytesPerSecond
      })
    )
    if (!res.success) {
      emit({ phase: 'error', message: res.error ?? 'Download failed.', modelId: model.id })
      return { success: false, error: res.error, modelId: model.id }
    }
  }

  emit({
    phase: 'activate',
    message: `Activating ${model.name}…`,
    modelId: model.id,
    modelName: model.name
  })
  const act = await setActiveModel(model.id)
  if (!act.success) {
    emit({ phase: 'error', message: act.error ?? 'Activation failed.', modelId: model.id })
    return { success: false, error: act.error, modelId: model.id }
  }

  emit({
    phase: 'start',
    message: 'Starting the local model server…',
    modelId: model.id,
    modelName: model.name
  })
  try {
    await llm.restart()
  } catch (e) {
    emit({ phase: 'error', message: (e as Error).message, modelId: model.id })
    return { success: false, error: (e as Error).message, modelId: model.id }
  }

  emit({ phase: 'verify', message: 'Verifying…', modelId: model.id, modelName: model.name })
  const ok = !!(await pingJson(llm.getPort(), '/health', 3000))

  // Chat is live — now set up the rest of the baseline (speech-to-text, text-to-
  // speech, and image outside Conservative). These are best-effort: a failure here
  // never fails setup, and the chat model being ready already lets the user in.
  try {
    const plan = await getSetupPlan()
    const extras = plan.items.filter((i) => !i.required)
    const installedNow = await listInstalled()
    for (const ex of extras) {
      if (installedNow.includes(ex.id)) {
        try {
          await setActiveModalChoice(ex.kind, ex.id)
        } catch {
          /* ignore */
        }
        continue
      }
      try {
        emit({
          phase: 'download',
          message: `Downloading ${ex.capability} (${ex.name})…`,
          modelId: ex.id,
          modelName: ex.name,
          percent: 0
        })
        const r = await downloadModel(ex.id, (p) =>
          emit({
            phase: 'download',
            message: `Downloading ${ex.capability} (${ex.name})…`,
            modelId: ex.id,
            modelName: ex.name,
            percent: p.percent,
            downloadedMB: p.downloadedMB,
            totalMB: p.totalMB,
            downloadedBytes: p.downloadedBytes,
            totalBytes: p.totalBytes,
            bytesPerSecond: p.bytesPerSecond
          })
        )
        if (r.success) await setActiveModalChoice(ex.kind, ex.id)
      } catch {
        /* best-effort extra */
      }
    }
  } catch {
    /* extras are optional */
  }

  emit({
    phase: 'done',
    message: ok
      ? `Ready - ${model.name} is active. Optional model downloads are complete.`
      : `${model.name} installed; the server is still warming up.`,
    modelId: model.id,
    modelName: model.name
  })
  return { success: ok, modelId: model.id, modelName: model.name }
}
