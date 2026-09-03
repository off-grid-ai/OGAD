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
import { desktopModels } from './composition/application-access'
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
import type { GuidedSetupMode as RecMode } from '@offgrid/models'
import { getNativeHelperHealth } from './native-helper-health'
import {
  CATALOG,
  createGuidedSetupService,
  estimateGuidedSetupFit,
  normalizeGuidedSetupMode,
  type GuidedSetupItemKind,
  type GuidedSetupPlan,
  type GuidedSetupProgress,
  type GuidedSetupRecommendation,
  type GuidedSetupService
} from '@offgrid/models'
import { platformFetch } from '@offgrid/models/fetch'

export type ComponentStatus = SystemHealthComponentStatusContract
export type HealthComponent = SystemHealthComponentContract
export type SystemHealth = SystemHealthContract

export type SetupProgress = GuidedSetupProgress
export type SetupProgressCb = (p: SetupProgress) => void

/** GET a localhost endpoint, parse JSON, with a short timeout. null on any failure. */
/** An engine health probe answers in well under a second on a healthy machine; a slow answer is a failure. */
const HEALTH_PROBE_TIMEOUT_MS = 1500

function pingJson(
  port: number,
  path = '/health',
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS
): Promise<unknown | null> {
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
  const activeRoute = desktopModels.snapshot().active.text?.model
  const { status, detail } = decideChatStatus({
    remote: activeRoute?.source === 'remote' ? { name: activeRoute.name } : null,
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
export type { GuidedSetupMode as RecMode } from '@offgrid/models'

/** Read performanceMode from settings, normalized to a RecMode (defaults balanced). */
function settingsMode(): RecMode {
  try {
    return normalizeGuidedSetupMode(
      (llm.getSettings() as { performanceMode?: string }).performanceMode
    )
  } catch {
    return 'balanced'
  }
}

export async function recommendChatModel(
  modeOverride?: RecMode
): Promise<{ id: string; name: string } | null> {
  const recommendation = await guidedSetupService().recommendation(modeOverride)
  return recommendation ? { id: recommendation.id, name: recommendation.name } : null
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
    const entry =
      CATALOG.find((m) => m.id === modelId) ??
      (await resolveHuggingFaceModel(modelId, { fetchImpl: platformFetch }))
    if (!entry) return { level: 'ok', ramGb: gb, weightsGb: 0, message: '' }
    const fit = estimateGuidedSetupFit(entry, gb)
    return { level: fit.level, ramGb: fit.ramGb, weightsGb: fit.weightsGb, message: fit.message }
  } catch {
    return { level: 'ok', ramGb: gb, weightsGb: 0, message: '' }
  }
}

export type Recommendation = Omit<GuidedSetupRecommendation, 'sizeBytes'>

/** Preview what "Configure for me" would pick for a given mode (no side effects),
 *  so the setup UI can show the exact model + size before the user commits. */
export async function getRecommendation(mode?: RecMode): Promise<Recommendation | null> {
  const recommendation = await guidedSetupService().recommendation(mode)
  if (!recommendation) return null
  return {
    id: recommendation.id,
    name: recommendation.name,
    sizeGb: recommendation.sizeGb,
    ramGb: recommendation.ramGb,
    installed: recommendation.installed,
    mode: recommendation.mode
  }
}

export type SetupItemKind = GuidedSetupItemKind
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
  return compatiblePlan(await guidedSetupService().plan(mode))
}

/** "Configure for me": pick → download (if needed) → activate → start → verify. */
export async function autoConfigure(
  onProgress?: SetupProgressCb
): Promise<{ success: boolean; error?: string; modelId?: string; modelName?: string }> {
  return guidedSetupService().run(onProgress)
}

function guidedSetupService(): GuidedSetupService {
  return createGuidedSetupService({
    catalog: CATALOG,
    totalRamGb: ramGb,
    loadMode: settingsMode,
    listInstalled,
    downloadModel,
    activateChat: setActiveModel,
    activateModality: async (kind, modelId) => {
      const selected = await setActiveModalChoice(kind, modelId)
      if (!selected.success) throw new Error(selected.error ?? `Could not activate ${kind}`)
    },
    startChat: () => llm.restart(),
    verifyChat: async () => !!(await pingJson(llm.getPort(), '/health', 3000)),
    deviceLabel: () => deviceNoun(process.platform)
  })
}

function compatiblePlan(plan: GuidedSetupPlan): SetupPlan {
  return {
    mode: plan.mode,
    ramGb: plan.ramGb,
    items: plan.items.map((item) => ({
      kind: item.kind,
      capability: item.capability,
      id: item.id,
      name: item.name,
      sizeGb: item.sizeGb,
      installed: item.installed,
      required: item.required
    })),
    totalDownloadGb: plan.totalDownloadGb
  }
}
