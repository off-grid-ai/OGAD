import os from 'node:os'
import { app, BrowserWindow, ipcMain, type IpcMain } from 'electron'
import {
  ANALYTICS_CHANNELS,
  FEATURES,
  type AnalyticsFeature,
  type AnalyticsConsent,
  type AnalyticsPromptKind
} from '../../shared/analytics'
import { deleteSetting, getSetting, saveSetting } from '../database'
import { isProEntitled } from '../licensing/license-service'
import {
  setAIRequestObserver,
  type AIRequestObserver,
  type AIRequestOutcome
} from '../ai-request-log'
import {
  runtimeBackendSnapshot,
  setRuntimeLoadObserver,
  type RuntimeLoadObserver
} from '../runtime-backends'
import type { RuntimeId } from '../../shared/runtime-backends'
import { createPostHogClient } from './client'
import { POSTHOG_API_KEY, POSTHOG_HOST } from './config'
import { modelRef } from './model-ref'
import {
  backendOf,
  channelOf,
  contextBucket,
  documentFileType,
  documentSizeBucket,
  downloadErrorCode,
  gb,
  generationErrorCode,
  languageOf,
  osVersionOf,
  platformOf,
  roundMs,
  roundRate,
  sizeBucket,
  type AnalyticsProperties,
  type Engine
} from './properties'
import { AnalyticsService, type AnalyticsServiceDeps } from './service'
import { UncleanExitMarker, UNCLEAN_EXIT_MARKER_FILE } from './unclean-exit'
import { registerAnalyticsIpc } from './ipc'
import { getMainWindow } from '../main-window'

export { UNCLEAN_EXIT_MARKER_FILE }

function appVersion(): string {
  return !app.isPackaged && typeof __OFFGRID_APP_VERSION__ === 'string'
    ? __OFFGRID_APP_VERSION__
    : app.getVersion()
}

let freeMemoryMB: () => number | undefined = () => os.freemem() / 1024 ** 2

function freeRamGb(): number {
  return Math.round(((freeMemoryMB() ?? os.freemem() / 1024 ** 2) * 1024 ** 2) / 1e9)
}

function superProperties(): AnalyticsProperties {
  const platform = platformOf(process.platform)
  const version = appVersion()
  const systemVersion =
    typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release()
  let pro = false
  try {
    pro = isProEntitled()
  } catch {
    /* licensing not ready yet */
  }
  return {
    platform,
    app_version: version,
    channel: channelOf(version),
    pro,
    device_class: 'desktop',
    // Same rounding as the setup screen's RAM figure (setup.ts).
    ram_gb: gb(os.totalmem()),
    os_version: osVersionOf(platform, systemVersion),
    locale: languageOf(app.getLocale() || 'en')
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

let service: AnalyticsService | null = null

/**
 * Build the owner over the app's real collaborators: the settings database, the PostHog SDK and
 * the in-flight marker in userData. `overrides` exist for integration tests, which point the
 * client at a fake endpoint; production never passes any.
 */
export function createAnalyticsService(
  overrides: Partial<Pick<AnalyticsServiceDeps, 'apiKey' | 'host' | 'buildAllowed' | 'now'>> = {}
): AnalyticsService {
  return new AnalyticsService({
    settings: { get: getSetting, set: saveSetting, delete: deleteSetting },
    createClient: createPostHogClient,
    apiKey: POSTHOG_API_KEY,
    host: POSTHOG_HOST,
    // A debug (unpackaged) build never starts the client.
    buildAllowed: app.isPackaged,
    superProperties,
    marker: new UncleanExitMarker({
      dir: app.getPath('userData'),
      version: appVersion(),
      bootAt: () => Date.now() - os.uptime() * 1000,
      now: Date.now
    }),
    onConsentChanged: (consent: AnalyticsConsent) =>
      broadcast(ANALYTICS_CHANNELS.consentChanged, consent),
    onPrompt: (kind: AnalyticsPromptKind) => broadcast(ANALYTICS_CHANNELS.prompt, kind),
    ...overrides
  })
}

/** The process-wide analytics owner. Created on first use; sends nothing until the user opts in. */
export function analytics(): AnalyticsService {
  service ??= createAnalyticsService()
  return service
}

/** The owner, or null where the app is not running (a unit test without Electron). */
function maybeAnalytics(): AnalyticsService | null {
  try {
    return analytics()
  } catch {
    return null
  }
}

/** Delete-all-data: opt out and forget every analytics setting. Never throws. */
export function forgetAnalytics(): void {
  maybeAnalytics()?.forget()
}

/** For integration tests: replace the process-wide owner (a relaunch, or a fake endpoint). */
export function resetAnalyticsForTests(next: AnalyticsService | null = null): void {
  service = next
}

// --- models -------------------------------------------------------------------------------------

interface DownloadState {
  startedAt: number
  props: AnalyticsProperties
  totalBytes?: number
}
const downloads = new Map<string, DownloadState>()

/** Voice, image and video models have their own setup funnels: the pick is the download starting. */
function setupFlowFor(
  kind: string | undefined
): 'image_setup' | 'video_setup' | 'voice_setup' | null {
  if (kind === 'image') return 'image_setup'
  if (kind === 'video') return 'video_setup'
  if (kind === 'voice' || kind === 'transcription') return 'voice_setup'
  return null
}

/**
 * One download's status changed (models-manager's `send`). Reports started, finished and failed
 * once each. `freeStorageBytes` is read by the caller, which owns the models folder.
 */
export function reportDownloadStatus(
  modelId: string,
  progress: { status?: string; totalBytes?: number; error?: string },
  freeStorageBytes?: () => number | undefined,
  kind?: string
): void {
  const setupFlow = setupFlowFor(kind)
  try {
    const owner = maybeAnalytics()
    if (!owner) return
    const status = progress.status
    if (status === 'downloading' && !downloads.has(modelId)) {
      const ref = modelRef(modelId, true)
      const free = freeStorageBytes?.()
      const props: AnalyticsProperties = {
        model: ref.model,
        // A video pack is several files, so it has no single quantization.
        quant: kind === 'video' ? null : ref.quant,
        size_bucket: progress.totalBytes ? sizeBucket(progress.totalBytes) : null,
        // Electron has no network type for a desktop; the spec's fallback is `unknown`.
        network: 'unknown',
        free_storage_gb: typeof free === 'number' ? gb(free) : null
      }
      downloads.set(modelId, { startedAt: Date.now(), props, totalBytes: progress.totalBytes })
      owner.capture('model_download_started', props)
      if (setupFlow) owner.flow({ flow: setupFlow, action: 'step', step: 'model_picked' })
      return
    }
    const state = downloads.get(modelId)
    if (state && progress.totalBytes) {
      state.totalBytes = progress.totalBytes
      state.props.size_bucket = sizeBucket(progress.totalBytes)
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      downloads.delete(modelId)
      if (!state) return
      if (status === 'cancelled') {
        if (setupFlow) owner.flow({ flow: setupFlow, action: 'finish', outcome: 'cancelled' })
        return
      }
      const duration = Date.now() - state.startedAt
      if (status === 'completed') {
        owner.capture('model_download_finished', {
          ...state.props,
          duration_ms: roundMs(duration),
          mb_per_sec:
            state.totalBytes && duration > 0
              ? roundRate(state.totalBytes / 1024 ** 2 / (duration / 1000))
              : null
        })
        if (setupFlow) {
          owner.flow({ flow: setupFlow, action: 'step', step: 'downloaded' })
          owner.flow({ flow: setupFlow, action: 'finish', outcome: 'done' })
        }
      } else {
        if (setupFlow) {
          owner.flow({
            flow: setupFlow,
            action: 'finish',
            outcome: 'failed',
            errorCode: downloadErrorCode(progress.error)
          })
        }
        const errorCode = downloadErrorCode(progress.error)
        owner.capture('model_download_failed', {
          ...state.props,
          duration_ms: roundMs(duration),
          error_code: errorCode
        })
        // A download the app interrupted (it is quitting) is not something to ask about.
        if (errorCode !== 'interrupted') owner.noteFailure()
      }
    }
  } catch {
    /* Statistics must never break a download. */
  }
}

const RUNTIME_ENGINE: Partial<Record<RuntimeId, Engine>> = {
  speech: 'onnx',
  embeddings: 'onnx',
  transcription: 'whisper',
  grounding: 'llama.cpp',
  decision: 'llama.cpp'
}

function engineFor(runtime: RuntimeId, model: string, backend?: string): Engine | null {
  if (backendOf(backend) === 'remote') return 'remote'
  if (runtime === 'image') {
    if (/core ?ml/i.test(backend ?? '')) return 'coreml'
    if (/mflux|mlx/i.test(model)) return 'mlx'
    return 'sd.cpp'
  }
  if (runtime === 'video') return 'sd.cpp'
  if (runtime === 'transcription' && /parakeet/i.test(model)) return 'onnx'
  return RUNTIME_ENGINE[runtime] ?? null
}

/** A model load, from start to its end. Returns the callback that reports how it ended. */
export function reportModelLoadStart(load: {
  runtime: RuntimeId
  model: string
}): (
  outcome: { ok: true; backend?: string } | { ok: false; errorCode: string } | { ok: null }
) => void {
  const owner = maybeAnalytics()
  if (!owner) return () => {}
  const ref = modelRef(load.model)
  const startedAt = Date.now()
  const endWork = owner.beginWork({
    stage: 'load',
    model: ref.model,
    engine: engineFor(load.runtime, load.model),
    backend: null,
    freeRamGb: freeRamGb(),
    startedAt
  })
  let settled = false
  return (outcome) => {
    if (settled) return
    settled = true
    endWork()
    // A load stopped or replaced before it finished is neither a success nor a failure.
    if (outcome.ok === null) return
    try {
      const base: AnalyticsProperties = {
        model: ref.model,
        quant: load.runtime === 'video' ? null : ref.quant,
        engine: engineFor(load.runtime, load.model, outcome.ok ? outcome.backend : undefined),
        backend: outcome.ok ? backendOf(outcome.backend) : null,
        // Apple Silicon reports its chip family; others report the architecture only.
        soc: process.arch,
        free_ram_gb: freeRamGb(),
        load_ms: roundMs(Date.now() - startedAt)
      }
      if (outcome.ok) owner.capture('model_loaded', base)
      else {
        owner.capture('model_load_failed', { ...base, error_code: outcome.errorCode })
        owner.noteFailure()
      }
    } catch {
      /* Statistics must never break a load. */
    }
  }
}

const runtimeLoadObserver: RuntimeLoadObserver = {
  started({ id, model }) {
    const end = reportModelLoadStart({ runtime: id, model })
    return (outcome) => {
      if (outcome.state === 'loaded') end({ ok: true, backend: outcome.backend })
      else if (outcome.state === 'error') end({ ok: false, errorCode: 'load_failed' })
      else end({ ok: null })
    }
  }
}

/** The chat engine (llama-server) died after a healthy start. */
export function reportLlamaServerCrash(crash: {
  model: string
  backend?: string
  exitCode: number | null
  classified: string | null
}): void {
  try {
    const ref = modelRef(crash.model)
    const owner = maybeAnalytics()
    if (!owner) return
    owner.captureCrash('llama_server_crashed', {
      model: ref.model,
      engine: 'llama.cpp',
      backend: backendOf(crash.backend),
      exit_code: crash.exitCode,
      classified: crash.classified ?? 'unclassified'
    })
    owner.noteFailure()
  } catch {
    /* best effort */
  }
}

// --- generation ---------------------------------------------------------------------------------

function generationEngine(
  outcome: Pick<AIRequestOutcome, 'modality' | 'model' | 'backend'>
): Engine | null {
  if (backendOf(outcome.backend) === 'remote') return 'remote'
  switch (outcome.modality) {
    case 'text':
      return 'llama.cpp'
    case 'tts':
    case 'embedding':
      return 'onnx'
    case 'stt':
      return /parakeet/i.test(outcome.model ?? '') ? 'onnx' : 'whisper'
    case 'image':
      return /core ?ml/i.test(outcome.backend ?? '')
        ? 'coreml'
        : /mflux|mlx/i.test(outcome.model ?? '')
          ? 'mlx'
          : 'sd.cpp'
    case 'video':
      return 'sd.cpp'
  }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The backend the video runtime is on, or last ran on, for this model. */
function lastVideoBackend(model: string | undefined): string | undefined {
  try {
    const video = runtimeBackendSnapshot().find((item) => item.id === 'video')
    if (!video || (model && video.model && video.model !== model)) return undefined
    return video.backend ?? video.lastRun?.backend
  } catch {
    return undefined
  }
}

const inflightGenerations = new Map<string, () => void>()

const MODALITY_FEATURE: Partial<Record<AIRequestOutcome['modality'], AnalyticsFeature>> = {
  image: 'image_generation',
  video: 'video_generation',
  stt: 'voice_input',
  tts: 'tts'
}

const aiRequestObserver: AIRequestObserver = {
  started(request) {
    // Background indexing embeds constantly. Only work someone waits on is tracked.
    if (request.modality === 'embedding') return
    const ref = modelRef(request.model)
    inflightGenerations.set(
      request.id,
      analytics().beginWork({
        stage: 'generate',
        model: ref.model,
        engine: generationEngine({ modality: request.modality, model: request.model }),
        backend: null,
        freeRamGb: freeRamGb(),
        startedAt: Date.now()
      })
    )
  },
  finished(outcome) {
    inflightGenerations.get(outcome.id)?.()
    inflightGenerations.delete(outcome.id)
    if (outcome.origin === 'app') {
      const feature =
        outcome.modality === 'text' && outcome.hasImage
          ? 'vision'
          : MODALITY_FEATURE[outcome.modality]
      if (feature) track('feature_used', { feature })
    }
    // Indexing embeddings are counted only when an API client asked for them.
    if (outcome.modality === 'embedding' && outcome.origin !== 'api') return
    const owner = analytics()
    const metrics = outcome.metrics ?? {}
    const ttftSeconds = num(metrics.timeToFirstTokenSeconds)
    const rate = num(metrics.decodeTokensPerSecond)
    const promptTokens = num(metrics.promptTokens) ?? num(metrics.estimatedPromptTokens)
    const ref = modelRef(outcome.model)
    const modality = outcome.modality === 'text' && outcome.hasImage ? 'vision' : outcome.modality
    // A clip stopped before its engine was ready has no backend of its own yet: report the one
    // this video model last ran on, so a stop is still placed.
    const reported =
      outcome.backend ??
      (outcome.modality === 'video' ? lastVideoBackend(outcome.model) : undefined)
    owner.capture('generation_finished', {
      modality,
      model: ref.model,
      engine: generationEngine({ ...outcome, backend: reported }),
      backend: backendOf(reported),
      outcome:
        outcome.status === 'completed'
          ? 'done'
          : outcome.status === 'cancelled'
            ? 'stopped'
            : 'failed',
      ttft_ms: ttftSeconds !== undefined ? roundMs(ttftSeconds * 1000) : null,
      tokens_per_sec: rate !== undefined ? roundRate(rate) : null,
      context_tokens_bucket: promptTokens !== undefined ? contextBucket(promptTokens) : null,
      error_code: outcome.status === 'failed' ? generationErrorCode(outcome.error) : null,
      source: outcome.origin,
      // A clip has no tokens: its whole generation time is the speed figure.
      ...(outcome.modality === 'video'
        ? {
            duration_ms: roundMs(outcome.durationMs),
            has_init_image: outcome.hasInitImage === true
          }
        : {})
    })
    if (outcome.origin !== 'app') return
    if (outcome.status === 'failed') owner.noteFailure()
    else if (outcome.status === 'completed' && outcome.modality === 'text')
      owner.noteSuccessfulReply()
  }
}

// --- actions ------------------------------------------------------------------------------------

/** A document was attached to a chat or added to a project: its extension and size only. */
export function reportDocumentAdded(fileName: string, bytes: number): void {
  try {
    maybeAnalytics()?.capture('document_added', {
      file_type: documentFileType(fileName),
      size_bucket: documentSizeBucket(bytes)
    })
  } catch {
    /* best effort */
  }
}

/** A usage event from a main-process seam. Never throws. */
export function track(event: string, properties: AnalyticsProperties = {}): void {
  try {
    maybeAnalytics()?.capture(event, properties)
  } catch {
    /* best effort */
  }
}

/** A flow report from a main-process seam. Never throws. */
export function trackFlow(report: Parameters<AnalyticsService['flow']>[0]): void {
  try {
    maybeAnalytics()?.flow(report)
  } catch {
    /* best effort */
  }
}

// --- daily features snapshot --------------------------------------------------------------------

type FeatureSource = () =>
  Partial<Record<AnalyticsFeature, boolean>> | Promise<Partial<Record<AnalyticsFeature, boolean>>>
const featureSources = new Set<FeatureSource>()

/** Pro adds the features it owns (sync, meetings, clipboard). Returns the unregister function. */
export function registerFeatureSnapshotSource(source: FeatureSource): () => void {
  featureSources.add(source)
  return () => featureSources.delete(source)
}

/** Which features are switched on right now, one true/false per feature. */
export async function readFeatureSnapshot(): Promise<Record<string, boolean>> {
  const snapshot: Record<string, boolean> = Object.fromEntries(FEATURES.map((f) => [f, false]))
  const tools = getSetting<unknown>('toolsEnabled', true) !== false
  const disabled = getSetting<unknown>('disabledTools', [])
  snapshot.tools = tools
  snapshot.web_search = tools && !(Array.isArray(disabled) && disabled.includes('web_search'))
  snapshot.mcp_tool = getSetting<unknown>('connectorsEnabled', false) === true
  try {
    const { getActiveRemoteVisionServer } = await import('../vision/remote-vision-server')
    snapshot.remote_server = Boolean(getActiveRemoteVisionServer())
  } catch {
    /* unknown stays false */
  }
  for (const source of featureSources) {
    try {
      for (const [feature, on] of Object.entries(await source())) {
        if ((FEATURES as readonly string[]).includes(feature) && typeof on === 'boolean')
          snapshot[feature] = on
      }
    } catch {
      /* a failing source leaves its features false */
    }
  }
  return snapshot
}

const SNAPSHOT_CHECK_MS = 60 * 60 * 1000

// --- lifecycle ----------------------------------------------------------------------------------

export interface AnalyticsInstallOptions {
  ipc?: Pick<IpcMain, 'on' | 'handle'>
  freeMemoryMB?: () => number | undefined
  registerShutdown: (owner: { name: string; shutdown: () => Promise<void> }) => void
}

let installed = false
/** Away this long, the session ends: `app_backgrounded` and `session_summary` go. */
const SESSION_IDLE_MS = 5 * 60 * 1000

/**
 * Wire analytics into the app at ready: IPC, observers, crash capture, the shutdown flush and the
 * previous launch's unclean exit. Creates the client only when the user already opted in.
 */
export function installAnalytics(options: AnalyticsInstallOptions): void {
  if (installed) return
  installed = true
  if (options.freeMemoryMB) freeMemoryMB = options.freeMemoryMB
  analytics().start()
  registerAnalyticsIpc(options.ipc ?? ipcMain, analytics)
  setAIRequestObserver(aiRequestObserver)
  setRuntimeLoadObserver(runtimeLoadObserver)
  options.registerShutdown({ name: 'core:analytics', shutdown: () => analytics().shutdown() })
  void analytics().reportPreviousExit()
  analytics().reportPreviousSession()

  // Crash capture. Each handler only observes: the existing behaviour stays.
  process.on('uncaughtExceptionMonitor', (error) =>
    analytics().captureException(error, { process: 'main', handled: false })
  )
  process.on('unhandledRejection', (reason) => {
    // A listener here replaces Node's own warning, so the rejection is still logged.
    console.error('[main] unhandled rejection', reason)
    analytics().captureException(reason, { process: 'main', handled: false })
  })
  app.on('render-process-gone', (_event, contents, details) => {
    if (details.reason === 'clean-exit') return
    // The main window only: Pro's popups and overlays have their own recovery.
    const main = getMainWindow()
    if (!main || main.isDestroyed() || main.webContents !== contents) return
    analytics().captureException(
      { name: 'RenderProcessGone', message: details.reason, stack: '' },
      { process: 'renderer', handled: false }
    )
  })
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') return
    analytics().captureException(
      { name: 'ChildProcessGone', message: `${details.type} ${details.reason}`, stack: '' },
      { process: details.type, handled: false }
    )
  })

  // Sessions: the app is in the foreground while one of its windows has focus. A session ends
  // after SESSION_IDLE_MS away (or at quit), so switching apps for a moment does not split it.
  let blurTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const focused = (): void => {
    if (blurTimer) clearTimeout(blurTimer)
    if (idleTimer) clearTimeout(idleTimer)
    blurTimer = undefined
    idleTimer = undefined
    analytics().setForeground(true)
    analytics().sessionFocused()
  }
  const blurred = (): void => {
    if (blurTimer) clearTimeout(blurTimer)
    // Focus moving between two of our windows blurs one before focusing the other.
    blurTimer = setTimeout(() => {
      blurTimer = undefined
      if (BrowserWindow.getFocusedWindow()) return
      analytics().setForeground(false)
      analytics().sessionBlurred()
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimer = undefined
        analytics().endSession()
      }, SESSION_IDLE_MS)
      idleTimer.unref()
    }, 1_000)
    blurTimer.unref()
  }
  app.on('browser-window-focus', focused)
  app.on('browser-window-blur', blurred)
  app.on('browser-window-created', (_event, win) => {
    win.on('hide', blurred)
    win.on('minimize', blurred)
  })
  if (BrowserWindow.getFocusedWindow()) focused()

  // The daily snapshot: checked shortly after launch, then hourly; sent once a calendar day.
  const snapshot = (): void =>
    void analytics()
      .snapshotFeatures(readFeatureSnapshot)
      .catch(() => {})
  setTimeout(snapshot, 60_000).unref()
  setInterval(snapshot, SNAPSHOT_CHECK_MS).unref()
}

/** The main window finished its first load: the cold start is over. */
export function reportAppOpened(): void {
  track('app_opened', { cold_start_ms: roundMs(process.uptime() * 1000), resumed: false })
}

/** Count one interaction from a main-process seam (a zoom key, a setting) into the session. */
export function countInteraction(
  counter: Parameters<AnalyticsService['countInteraction']>[0],
  key: string
): void {
  try {
    maybeAnalytics()?.countInteraction(counter, key)
  } catch {
    /* best effort */
  }
}
