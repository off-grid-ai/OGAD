import { backendChoicesForUi } from './backend-facts'
import { settingsChanged } from './settings-version'
import { withStorageDownload, storageDownloadsActive } from './model-storage-guard'
import { moveModelStorage } from './model-storage-move'
import { ipcMain, BrowserWindow, app, clipboard } from 'electron'
import { listBridgeBrowsers } from './extension-bridge/bridge-electron'
import { setupAIRequestLogIPC } from './ai-request-log-ipc'
import { setupChatNextActionIpc } from './chat-next-action'
import { setupArtifactPreviewIpc } from './artifact-preview-ipc'
import {
  getDB,
  getChatSessions,
  upsertChatSummary,
  getMemoriesForSession,
  getEntitiesForSession,
  getUserProfile,
  saveUserProfile,
  UserProfile,
  createRagConversation,
  getRagConversations,
  getRagConversation,
  deleteRagConversation,
  addRagMessage,
  getRagMessages,
  updateRagConversationTitle,
  searchRagConversationIds,
  getSettings,
  saveSetting,
  getSetting
} from './database'
import { deleteEntityById } from './entity-domain'
import { setComputerUseSettings } from './computer-use-settings'
import { COMPUTER_USE_SETTINGS_KEY } from '../shared/computer-use-settings'
import { setWebUseSettings } from './web-use-settings'
import { WEB_USE_SETTINGS_KEY } from '../shared/web-use-settings'
import {
  getResidency,
  setResidencyMode,
  type Modality,
  type ResidencyMode
} from './runtime-residency'
import { getBackendPreferences, setBackendPreference } from './backend-preferences'
import type { BackendModality, BackendPreference } from '../shared/backend-preferences'
import {
  requestAccessibilityPermission,
  requestScreenRecordingPermission,
  openAccessibilitySettings,
  openScreenRecordingSettings,
  openMicrophoneSettings,
  openLocalNetworkSettings
} from './permissions'
import { setupSystemStatusIpc } from './system-status-ipc'
import { CACHE_CLEANUP_CHANNEL } from '../shared/ipc-contracts'
import { toResponseGenerationResult, type ResponseGenerationResult } from './llm/response-result'
import { getAllPromptDefs } from './prompts'
import { getPrompt, getPromptTemplate, resetPrompt } from './prompt-store'
import { setupTtsIpc } from './tts-ipc'
import { setupVoiceTranscriptionIpc } from './voice-transcription-ipc'
import { requestApplicationRelaunch } from './shutdown'
import {
  activateInstalledPerformancePack,
  onPerformancePackChanged,
  pausePerformancePack,
  performancePackStatus,
  startPerformancePack
} from './performance-pack'
import { engineUpdater } from './engine-updates-service'
import { sampleProgressRate, type ProgressRateSample } from '@offgrid/ui'
import { notifyRagConversationChanged } from './rag-conversation-events'
// import { llm } from './llm'; // Moved to dynamic import to support ESM

// Generate the answer for a rag:chat turn. When a streamId + sender are present,
// stream tokens/reasoning to the renderer over the 'rag:stream' channel as they
// arrive (inline chain-of-thought); otherwise fall back to a single blocking call.
// Active streaming turns, keyed by streamId, so a renderer 'rag:cancel' can abort
// an in-flight generation and keep whatever was produced so far.
import {
  activeChatStreamSnapshots,
  beginChatImageStream,
  bindChatStream,
  continueChatStreamWithImage,
  currentChatStreamMessageId,
  endChatStream,
  endChatStreamForConversation,
  noteChatStreamImageProgress,
  noteChatStreamDelta,
  resetChatStreamPartial,
  noteChatStreamToolCompleted,
  noteChatStreamToolStarted,
  takeChatStreamMessageId
} from './chat-stream-state'
import { runChatWithFallback } from './chat-fallback'

const streamControllers = new Map<string, AbortController>()

function deviceFallbackNotices(
  sender: { send: (channel: string, payload: unknown) => void } | undefined,
  streamId: string | undefined
): Pick<
  NonNullable<Parameters<typeof runChatWithFallback>[1]>,
  'onDeviceFallback' | 'onRestarting'
> {
  if (!sender || !streamId) return {}
  const send = (step: unknown): void => {
    try {
      sender.send('rag:stream', { streamId, type: 'step', step })
    } catch {
      /* window gone */
    }
  }
  return {
    onDeviceFallback: (message) => send({ kind: 'device_fallback', message }),
    onRestarting: (restarting) => {
      if (restarting) resetChatStreamPartial(streamId)
      send({ kind: restarting ? 'restarting_model' : 'waiting' })
    }
  }
}

async function streamAnswer(
  event: { sender?: { send: (channel: string, payload: unknown) => void } } | undefined,
  streamId: string | undefined,
  prompt: string,
  thinking: boolean = false,
  images: string[] = []
): Promise<ResponseGenerationResult> {
  const { llm } = await import('./llm')
  const { modalityQueue, CHAT_JOB } = await import('./modality-queue/queue')

  // No-renderer fallback still uses the same streaming transport with a no-op
  // observer, so finish metadata and the configured cap cannot diverge by caller.
  if (!streamId || !event?.sender) {
    // Interactive chat is foreground work - Tier 2, a peer of image gen. During
    // image gen the LLM is evicted so this waits anyway (consistent); background
    // screen-replay (Tier 3) defers to it. Chat runs ON the 'llm' engine, so it
    // evicts nothing (evicting 'llm' would evict itself). run()'s finally releases
    // the slot even if fn throws, so we let errors propagate from inside.
    return modalityQueue.run(CHAT_JOB, async () => {
      const { result, modelName } = await runChatWithFallback(
        () => llm.chatStream(prompt, images, () => {}, { thinking }),
        deviceFallbackNotices(event?.sender, streamId)
      )
      const response = toResponseGenerationResult(result)
      return modelName ? { ...response, metrics: { ...response.metrics, modelName } } : response
    })
  }

  const sender = event.sender
  // Register the abort controller BEFORE queuing so a rag:cancel that arrives while
  // this turn is still WAITING in the queue is honored - the stream then starts with
  // an already-aborted signal (and resolves immediately) rather than running in full.
  const controller = new AbortController()
  streamControllers.set(streamId, controller)
  try {
    // Interactive streaming chat = Tier 2 (see above). Await the full stream inside
    // the run() callback so the queue slot is held for the whole generation; the
    // cancel path aborts via the controller registered above.
    return await modalityQueue.run(CHAT_JOB, async () => {
      const { result, modelName } = await runChatWithFallback(
        () =>
          llm.chatStream(
            prompt,
            images,
            (text, kind) => {
              noteChatStreamDelta(streamId, text, kind)
              try {
                sender.send('rag:stream', { streamId, type: kind, text })
              } catch {
                /* window gone */
              }
            },
            { thinking, signal: controller.signal }
          ),
        {
          signal: controller.signal,
          ...deviceFallbackNotices(sender, streamId),
          onModelChanged: (failed, next) => {
            resetChatStreamPartial(streamId)
            try {
              sender.send('rag:stream', {
                streamId,
                type: 'step',
                step: { kind: 'model_changed', failed, next }
              })
            } catch {
              /* window gone */
            }
          }
        }
      )
      const response = toResponseGenerationResult(result)
      return modelName ? { ...response, metrics: { ...response.metrics, modelName } } : response
    })
  } finally {
    streamControllers.delete(streamId)
    endChatStream(streamId, controller.signal.aborted ? 'discarded' : 'record_pending')
    try {
      sender.send('rag:stream', { streamId, type: 'done' })
    } catch {
      /* window gone */
    }
  }
}

// A legacy chat session's summary (chat_summaries, searched as 'summary' records). The legacy
// memories and entity facts that used to be extracted alongside it are retired: nothing writes or
// reads them, and their rows stay until the user deletes their data. Live memory is screen moments,
// entities, to-dos, meetings and chats.
async function summarizeSession(sessionId: string): Promise<string | null> {
  const memories = getMemoriesForSession(sessionId)
  if (memories.length === 0) return null

  const conversationText = memories.map((m) => `[${m.role || 'unknown'}]: ${m.content}`).join('\n')
  const prompt = getPrompt('sessionSummary', { CONVERSATION_TEXT: conversationText })

  try {
    const { llm } = await import('./llm')
    const summary = await llm.chat(prompt, [], 120000, 2048)
    upsertChatSummary(sessionId, summary)
    return summary
  } catch (e) {
    console.error('Failed to summarize session:', e)
    throw e
  }
}

export function setupIPC(): void {
  activateInstalledPerformancePack()
  onPerformancePackChanged((status) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.send('performance-pack:changed', status)
    )
  })
  ipcMain.handle('performance-pack:status', performancePackStatus)
  ipcMain.handle('performance-pack:start', startPerformancePack)
  ipcMain.handle('performance-pack:pause', pausePerformancePack)
  // Engines published between releases install in the background unless the user turns it off.
  engineUpdater.onChanged((status) => {
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.send('engine-updates:changed', status)
    )
  })
  ipcMain.handle('engine-updates:status', () => engineUpdater.status())
  ipcMain.handle('engine-updates:check', () => engineUpdater.check())
  ipcMain.handle('engine-updates:set-enabled', (_event, enabled: unknown) =>
    engineUpdater.setEnabled(enabled !== false)
  )
  engineUpdater.start()
  setupAIRequestLogIPC()
  setupChatNextActionIpc()
  setupVoiceTranscriptionIpc()
  getDB()
  setupTtsIpc()
  setupSystemStatusIpc(ipcMain, {
    publish: (health) =>
      BrowserWindow.getAllWindows().forEach((window) =>
        window.webContents.send('system:chat-health-changed', health)
      )
  })

  ipcMain.handle('llm:extract', async (_, text: string) => {
    try {
      const { llm } = await import('./llm')
      const response = await llm.chat(
        `Analyze the following text and extract a summary and key topics. Return JSON only with keys: summary, topic, entities. Text: "${text}"`
      )

      // Basic cleanup if the model returns markdown code blocks
      const cleanJson = response.replace(/```json\n?|\n?```/g, '').trim()

      return JSON.parse(cleanJson)
    } catch (e) {
      console.error('LLM Extraction failed:', e)
      // Fallback
      return {
        summary: text.slice(0, 50) + '...',
        topic: 'General (Fallback)',
        entities: []
      }
    }
  })

  // Cancel an in-flight streaming turn; chatStream resolves with the partial answer.
  ipcMain.handle('rag:active-streams', () => activeChatStreamSnapshots())
  ipcMain.on('rag:cancel', (_evt, streamId: string) => {
    streamControllers.get(streamId)?.abort()
  })

  // A plain on-device model turn: no memory retrieval and no routing. Memory, tools and artifacts
  // are the chat tools loop's (tools.ts); this channel is the direct call the preset setup form
  // uses to fill a field. The memory arguments of the old contract are accepted and ignored.
  ipcMain.handle(
    'rag:chat',
    async (
      event,
      query: string,
      _appName?: string,
      conversationHistory?: { role: string; content: string }[],
      _projectId?: string | null,
      conversationId?: string,
      _noMemory?: boolean,
      streamId?: string,
      thinking?: boolean,
      images?: string[]
    ) => {
      bindChatStream(streamId, conversationId, thinking ? 'thinking' : 'waiting')
      const history = (conversationHistory ?? [])
        .slice(-10)
        .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
        .join('\n')
      const prompt = [
        'You are Off Grid AI, a private, on-device assistant.',
        history ? `Conversation so far:\n${history}` : '',
        `User: ${query}`,
        'Assistant:'
      ]
        .filter(Boolean)
        .join('\n\n')
      const completion = await streamAnswer(event, streamId, prompt, thinking, images ?? [])
      return { ...completion, context: undefined }
    }
  )

  ipcMain.handle('db:get-chat-sessions', () => {
    return getChatSessions()
  })
  ipcMain.handle('db:get-memories-for-session', (_, sessionId: string) => {
    // Need to export this from database.ts first or import it
    return getMemoriesForSession(sessionId)
  })
  ipcMain.handle('db:get-entities-for-session', (_, sessionId: string) => {
    return getEntitiesForSession(sessionId)
  })

  ipcMain.handle('db:delete-session', (_, sessionId: string) => {
    const db = getDB()
    // Delete from new tables (messages will cascade due to foreign key)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(sessionId)
    // Also delete from legacy tables for cleanup (retired memories stay deletable)
    db.prepare('DELETE FROM memories WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM chat_summaries WHERE session_id = ?').run(sessionId)
    console.log(`Deleted session: ${sessionId}`)
    return true
  })

  ipcMain.handle('llm:summarize-session', async (_, sessionId: string) => {
    return await summarizeSession(sessionId)
  })

  ipcMain.handle('db:delete-entity', (_, entityId: number) => {
    const result = deleteEntityById(entityId)
    console.log(`[IPC] Deleted entity ${entityId}: ${result}`)
    return result
  })

  // User Profile handlers
  ipcMain.handle('db:get-user-profile', () => {
    return getUserProfile()
  })

  ipcMain.handle('db:save-user-profile', (_, profile: UserProfile) => {
    saveUserProfile(profile)
    console.log('[IPC] User profile saved:', profile)
    return true
  })

  // Permission handlers
  ipcMain.handle('permissions:request-accessibility', () => {
    return requestAccessibilityPermission()
  })

  ipcMain.handle('permissions:open-accessibility-settings', () => {
    openAccessibilitySettings()
    return true
  })

  ipcMain.handle('permissions:open-screen-recording-settings', () => {
    openScreenRecordingSettings()
    return true
  })

  ipcMain.handle('permissions:open-microphone-settings', () => {
    openMicrophoneSettings()
    return true
  })

  ipcMain.handle('permissions:open-local-network-settings', () => {
    openLocalNetworkSettings()
    return true
  })

  ipcMain.handle('permissions:request-screen-recording', async () => {
    return await requestScreenRecordingPermission()
  })

  ipcMain.handle('permissions:relaunch', () => {
    requestApplicationRelaunch(app)
    return true
  })

  // === RAG CONVERSATION HANDLERS ===

  ipcMain.handle(
    'rag:create-conversation',
    (
      _,
      id: string,
      title?: string,
      projectId?: string | null,
      surface?: import('../shared/ipc-contracts').ConversationSurface
    ) => {
      return createRagConversation(id, title, projectId, surface)
    }
  )

  // Both reads are bounded at their owner. `page` and `limit` are optional: a caller that wants
  // older conversations or more matches asks for them, and one that asks for nothing still gets a
  // page rather than the whole table.
  ipcMain.handle(
    'rag:get-conversations',
    (
      _,
      projectId?: string | null,
      page?: import('./database').RagConversationPage,
      surface?: import('../shared/ipc-contracts').ConversationSurface
    ) => getRagConversations(projectId, page, surface)
  )

  ipcMain.handle('rag:search-conversation-ids', (_, query: string, limit?: number) =>
    searchRagConversationIds(query, limit)
  )

  ipcMain.handle(
    'rag:set-conversation-project',
    async (_, id: string, projectId: string | null) => {
      const { setRagConversationProject } = await import('./database')
      setRagConversationProject(id, projectId)
      notifyRagConversationChanged({ conversationId: id, projectId })
      return true
    }
  )

  ipcMain.handle('rag:get-conversation', (_, id: string) => {
    return getRagConversation(id)
  })

  ipcMain.handle('rag:get-messages', (_, conversationId: string) => {
    return getRagMessages(conversationId)
  })

  ipcMain.handle(
    'rag:update-message',
    async (_e, conversationId: string, messageId: string, content: string, context?: unknown) => {
      const { updateRagMessage } = await import('./database')
      return updateRagMessage(conversationId, messageId, content, context)
    }
  )

  ipcMain.handle('rag:truncate-messages', async (_e, conversationId: string, keepCount: number) => {
    const { truncateRagMessages } = await import('./database')
    return truncateRagMessages(conversationId, keepCount)
  })
  ipcMain.handle(
    'rag:add-message',
    (_, conversationId: string, role: 'user' | 'assistant', content: string, context?: unknown) => {
      // A reply that was streamed is already named, and keeps that name: every paired device has been
      // rendering it under this id, so the arriving record retires their live preview instead of
      // standing beside it. Read from the one owner of "what this device is generating", so no caller
      // has to pass it and none can forget to.
      const streamed = role === 'assistant' ? takeChatStreamMessageId(conversationId) : undefined
      return addRagMessage(conversationId, role, content, context, streamed)
    }
  )

  ipcMain.handle('rag:update-conversation-title', (_, id: string, title: string) => {
    return updateRagConversationTitle(id, title)
  })

  ipcMain.handle('rag:delete-conversation', async (_, id: string) => {
    // Clean the conversation's generated artifacts too, so they don't orphan in
    // the library (D23) — same lifecycle tie deleteProject has for a project.
    const { deleteArtifactsForConversation } = await import('./artifacts')
    deleteArtifactsForConversation(id)
    const deleted = deleteRagConversation(id)
    // Documents only this chat used go with it, now rather than at the 30-day cleanup.
    const documents = await import('./documents')
    const { forgetConversationExclusions } = await import('./documents/sqlite-store')
    forgetConversationExclusions(id)
    void documents.forgetUnreferencedDocuments()
    return deleted
  })

  // API credentials can be managed only through the trusted desktop IPC surface.
  ipcMain.handle('gateway:keys:list', async () =>
    (await import('./model-server')).gatewayApiKeySettings()
  )
  ipcMain.handle('gateway:keys:required', async (_, enabled: boolean) =>
    (await import('./model-server')).setGatewayApiKeyRequired(enabled)
  )
  ipcMain.handle(
    'gateway:keys:create',
    async (_, name: string, expiresAt: number | null, replaceId?: string) =>
      (await import('./model-server')).createGatewayApiKey(name, expiresAt, replaceId)
  )
  ipcMain.handle('gateway:keys:revoke', async (_, id: string) =>
    (await import('./model-server')).revokeGatewayApiKey(id)
  )

  // === SETTINGS HANDLERS ===

  ipcMain.handle('settings:get', () => {
    return getSettings()
  })

  // Browsers paired through the extension bridge, and which are connected (Tasks > Web Use).
  ipcMain.handle('extension-bridge:browsers', () => listBridgeBrowsers())

  // App version (for the Settings footer — so users know what build they're on). A packaged app
  // reads its own; an unpackaged launch of a script reports Electron's, so it uses the build's.
  ipcMain.handle('app:version', () =>
    !app.isPackaged && typeof __OFFGRID_APP_VERSION__ === 'string'
      ? __OFFGRID_APP_VERSION__
      : app.getVersion()
  )

  ipcMain.handle('settings:save', (_, key: string, value: unknown) => {
    if (key === COMPUTER_USE_SETTINGS_KEY) setComputerUseSettings(value)
    else if (key === WEB_USE_SETTINGS_KEY) setWebUseSettings(value)
    else saveSetting(key, value)
    return true
  })

  // Per-modality runtime residency (on-demand vs in-memory/resident). The full map
  // drives the queue's mode-aware re-warm and each engine's job path.
  ipcMain.handle('runtime:residency:get', () => getResidency())
  ipcMain.handle('runtime:residency:set', async (_e, modality: Modality, mode: ResidencyMode) => {
    ;(await import('./best-settings')).markSpeedSettingsManual()
    return setResidencyMode(modality, mode)
  })
  ipcMain.handle('runtime:backend:choices', () => backendChoicesForUi())
  // "Try the GPU again": forget this session's demotion and restart the engine on its ladder.
  ipcMain.handle('runtime:backend:retry', async (_e, modality: BackendModality) => {
    const { clearDemotions, invalidateBackendFacts } = await import('./backend-facts')
    clearDemotions(modality)
    invalidateBackendFacts()
    if (modality === 'llm') {
      const { llm } = await import('./llm')
      if (llm.shouldBeRunning()) await llm.restartSameModel()
    } else if (modality === 'grounding') {
      const { grounderRuntime } = await import('./vision/grounder-runtime')
      if (grounderRuntime.shouldBeRunning()) await grounderRuntime.restart()
    } else if (modality === 'decision') {
      const { decisionRuntime } = await import('./accessibility/decision-runtime')
      if (decisionRuntime.shouldBeRunning()) await decisionRuntime.restart()
    } else if (modality === 'tts') {
      await (await import('./tts')).ttsOnnxRuntime.restart()
    } else if (modality === 'embeddings') {
      await (await import('./embeddings')).embeddings.restart()
    }
    // Image and transcription load per job; their next job uses the restored ladder.
  })
  ipcMain.handle('runtime:backend:get', () => getBackendPreferences())
  ipcMain.handle(
    'runtime:backend:set',
    async (_e, modality: BackendModality, preference: BackendPreference) => {
      ;(await import('./best-settings')).markSpeedSettingsManual()
      const next = setBackendPreference(modality, preference)
      // Chat, image and the task engines take the new backend at their next load (the UI says
      // so); voice and search helpers restart between requests onto it.
      if (modality === 'embeddings') void (await import('./embeddings')).embeddings.restart()
      if (modality === 'tts') void (await import('./tts')).ttsOnnxRuntime.restart()
      return next
    }
  )
  ipcMain.handle('runtime:best-settings:apply', async () => {
    const { applyBestSettings } = await import('./best-settings')
    return applyBestSettings()
  })
  ipcMain.handle('runtime:best-settings:status', async () => {
    const { bestSettingsStatus } = await import('./best-settings')
    return bestSettingsStatus()
  })
  // Unload one modality's model from memory now (the "free RAM" button). Goes through
  // the same evict() seam as residency/shutdown; the engine reloads on next use.
  ipcMain.handle('runtime:unload', async (_e, modality: Modality) => {
    const { unloadRuntime } = await import('./runtime-manager')
    const freed = await unloadRuntime(modality)
    console.log(`[runtime] unload ${modality}: ${freed ? 'freed' : 'nothing registered'}`)
    return freed
  })

  // Pipeline queue config — the user-facing controls for the shared scheduler.
  // Reads/writes go through modality-queue/config (single source for the keys) and
  // apply to the live queue immediately, so a toggle takes effect without a restart.
  ipcMain.handle('queue:config:get', async () => {
    const { readQueueConfig } = await import('./modality-queue/config')
    return readQueueConfig(getSetting)
  })
  ipcMain.handle(
    'queue:config:set',
    async (_e, patch: { enabled?: boolean; tier1Coexists?: boolean }) => {
      const { readQueueConfig, applyQueueConfig, QUEUE_ENABLED_KEY, TIER1_COEXIST_KEY } =
        await import('./modality-queue/config')
      const { modalityQueue } = await import('./modality-queue/queue')
      if (typeof patch.enabled === 'boolean') {
        saveSetting(QUEUE_ENABLED_KEY, patch.enabled)
      }
      if (typeof patch.tier1Coexists === 'boolean') {
        saveSetting(TIER1_COEXIST_KEY, patch.tier1Coexists)
      }
      const cfg = readQueueConfig(getSetting)
      applyQueueConfig(modalityQueue, cfg)
      return cfg
    }
  )
  // Live queue activity (running + queued jobs) for a status indicator.
  ipcMain.handle('queue:state', async () => {
    const { modalityQueue } = await import('./modality-queue/queue')
    return modalityQueue.getState()
  })

  // Fleet console IPC (console:*) is a pro feature — registered by pro's
  // activateMain, not here, so the open build doesn't ship it.

  // === PROMPT HANDLERS ===

  ipcMain.handle('prompts:get-all', () => {
    const defs = getAllPromptDefs()
    return defs.map((def) => ({
      ...def,
      currentTemplate:
        getPromptTemplate(def.key) !== def.defaultTemplate ? getPromptTemplate(def.key) : null
    }))
  })

  ipcMain.handle('prompts:save', (_, key: string, value: string) => {
    saveSetting(`prompt:${key}`, value)
    console.log(`[IPC] Prompt saved: ${key}`)
    return true
  })

  ipcMain.handle('prompts:reset', (_, key: string) => {
    resetPrompt(key)
    console.log(`[IPC] Prompt reset: ${key}`)
    return true
  })

  // === MODEL DOWNLOAD HANDLERS ===

  ipcMain.handle('model:check-status', async () => {
    const { llm } = await import('./llm')
    return {
      downloaded: llm.modelsExist(),
      modelsDir: llm.getModelsDir()
    }
  })

  ipcMain.handle('model:download', () =>
    withStorageDownload(async () => {
      const { llm } = await import('./llm')
      const modelsDir = llm.getModelsDir()
      const fs = await import('fs')
      const path = await import('path')
      const https = await import('https')

      // Ensure models directory exists
      if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true })
      }

      const models = [
        {
          name: 'Qwen3-VL-4B-Instruct-Q4_K_M.gguf',
          url: 'https://huggingface.co/bartowski/Qwen_Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen_Qwen3-VL-4B-Instruct-Q4_K_M.gguf'
        },
        {
          name: 'mmproj-Qwen3VL-4B-Instruct-F16.gguf',
          url: 'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-4B-Instruct-F16.gguf'
        }
      ]

      const downloadFile = (url: string, destPath: string, modelName: string): Promise<void> => {
        return new Promise((resolve, reject) => {
          const file = fs.createWriteStream(destPath)
          let rateSample: ProgressRateSample | undefined

          const request = (redirectUrl: string): void => {
            https
              .get(redirectUrl, (response) => {
                if (
                  response.statusCode &&
                  response.statusCode >= 300 &&
                  response.statusCode < 400 &&
                  response.headers.location
                ) {
                  request(response.headers.location)
                  return
                }

                if (response.statusCode !== 200) {
                  fs.unlink(destPath, () => {})
                  reject(new Error(`HTTP ${response.statusCode}`))
                  return
                }

                const totalSize = parseInt(response.headers['content-length'] || '0', 10)
                let downloaded = 0

                response.pipe(file)

                response.on('data', (chunk: Buffer) => {
                  downloaded += chunk.length
                  const percent = totalSize ? Math.round((downloaded / totalSize) * 100) : 0
                  const rate = sampleProgressRate(rateSample, {
                    currentBytes: downloaded,
                    sampledAtMs: Date.now()
                  })
                  rateSample = rate.sample

                  // Send progress to renderer
                  BrowserWindow.getAllWindows().forEach((win) => {
                    win.webContents.send('model:download-progress', {
                      modelName,
                      percent,
                      downloadedBytes: downloaded,
                      totalBytes: totalSize || undefined,
                      bytesPerSecond: rate.bytesPerSecond,
                      downloadedMB: (downloaded / 1024 / 1024).toFixed(1),
                      totalMB: totalSize ? (totalSize / 1024 / 1024).toFixed(1) : '?'
                    })
                  })
                })

                file.on('finish', () => {
                  file.close()
                  resolve()
                })
              })
              .on('error', (err) => {
                fs.unlink(destPath, () => {})
                reject(err)
              })
          }

          request(url)
        })
      }

      try {
        for (const model of models) {
          const destPath = path.join(modelsDir, model.name)

          if (fs.existsSync(destPath)) {
            console.log(`[Model] ${model.name} already exists, skipping`)
            continue
          }

          console.log(`[Model] Downloading ${model.name}...`)
          await downloadFile(model.url, destPath, model.name)
          console.log(`[Model] ${model.name} downloaded`)
        }

        return { success: true }
      } catch (err: unknown) {
        console.error('[Model] Download failed:', err)
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  )

  // === Off Grid AI MODEL CATALOG (text, vision, image, voice, transcription) ===

  // Model management lives in ./models-manager (one source of truth, shared with
  // the headless gateway HTTP admin endpoints). These IPC handlers are thin
  // wrappers; the download one adds a renderer progress broadcast.
  ipcMain.handle('models:catalog', () => import('./models-manager').then((m) => m.getCatalog()))
  ipcMain.handle('models:vision-status', () =>
    import('./models-manager').then((m) => m.getVisionStatuses())
  )
  ipcMain.handle('models:installed', () =>
    import('./models-manager').then((m) => m.listInstalled())
  )
  ipcMain.handle('models:search', (_, query: string, kind?: string) =>
    import('./models-manager').then((m) => m.searchModels(query, kind))
  )
  ipcMain.handle('models:files', (_, modelId: string) =>
    import('./models-manager').then((m) => m.getModelFiles(modelId))
  )

  ipcMain.handle('models:download', async (_, modelId: string, fileName?: string) => {
    const { downloadModel } = await import('./models-manager')
    return downloadModel(
      modelId,
      (p) =>
        BrowserWindow.getAllWindows().forEach((w) =>
          w.webContents.send('model:download-progress', p)
        ),
      fileName
    )
  })
  ipcMain.handle('models:cancel-download', (_evt, modelId: string) =>
    import('./models-manager').then((m) => m.cancelDownload(modelId))
  )
  ipcMain.handle('models:delete', (_, modelId: string) =>
    import('./models-manager').then((m) => m.deleteModel(modelId))
  )

  // A new chat model can change MTP support and memory needs: refresh auto-managed settings.
  const refreshBestSettings = (): void => {
    void import('./best-settings')
      .then((m) => m.ensureBestSettings())
      .catch((error: unknown) => console.warn('[best-settings] refresh failed', error))
  }
  ipcMain.handle('models:set-active', async (_, modelId: string) => {
    const result = await import('./models-manager').then((m) => m.setActiveModel(modelId))
    refreshBestSettings()
    return result
  })
  // Single activation seam: route any model to the right backend by its kind.
  ipcMain.handle('models:activate', async (_, modelId: string, requestedKind?: string) => {
    const result = await import('./models-manager').then((m) =>
      m.activateModel(modelId, requestedKind)
    )
    refreshBestSettings()
    return result
  })
  ipcMain.handle('models:get-active', () =>
    import('./models-manager').then((m) => m.getActiveModel())
  )
  // Active model ids across ALL modalities — the UI's single "what's active" source.
  ipcMain.handle('models:active-ids', () =>
    import('./models-manager').then((m) => m.getActiveModelIds())
  )
  ipcMain.handle('models:set-active-modal', (_, kind: string, modelId: string | null) =>
    import('./models-manager').then((m) => m.setActiveModalChoice(kind, modelId))
  )
  ipcMain.handle('models:active-modalities', () =>
    import('./models-manager').then((m) => m.getActiveModalities())
  )
  ipcMain.handle('models:computer-use-active', () =>
    import('./vision/vision-task-model-strategy').then((m) =>
      m.getComputerUseActiveModelProjection()
    )
  )
  ipcMain.handle('models:web-use-active', () =>
    import('./vision/vision-task-model-strategy').then((m) => m.getWebUseActiveModelProjection())
  )
  // Every Models screen's view of the task models, and the one way to give a model a role.
  ipcMain.handle('models:task-roles', () =>
    import('./vision/vision-task-model-strategy').then((m) => m.getTaskRolesView())
  )
  ipcMain.handle('models:set-task-role', (_, task: unknown, role: unknown, modelId: unknown) =>
    import('./task-role-requests').then((m) => m.setTaskRoleFromRequest({ task, role, modelId }))
  )

  // Storage + download manager
  ipcMain.handle('models:storage', () => import('./models-manager').then((m) => m.getStorageInfo()))
  ipcMain.handle('models:choose-directory', async () => {
    const { dialog } = await import('electron')
    const fs = await import('node:fs')
    const current = (await import('./runtime-env')).modelsDir()
    const result = await dialog.showOpenDialog({
      title: 'Choose model storage folder',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const directory = result.filePaths[0]
    const manager = await import('./models-manager')
    const downloads = manager.listDownloads()
    if (
      storageDownloadsActive() ||
      downloads.some((entry) => entry.status === 'queued' || entry.status === 'downloading')
    ) {
      return { error: 'Wait for model downloads to finish or cancel them, then try again.' }
    }
    try {
      const { saveModelStorageChoice } = await import('./model-storage-choice')
      const profile = app.getPath('userData')
      const currentFiles = fs.existsSync(current) ? fs.readdirSync(current) : []
      const sameFolder =
        fs.existsSync(current) && fs.realpathSync(current) === fs.realpathSync(directory)
      let moved = false
      let left = false
      let unknownEntriesLeft = 0
      if (!sameFolder && currentFiles.length) {
        const choice = await dialog.showMessageBox({
          type: 'question',
          title: 'Existing model files',
          message: 'Move your existing model files to the new folder?',
          detail:
            'Move copies Off Grid model files and uses the new folder now. Old copies are removed after the next restart if verified. Unknown files stay in place. Leave adds the old folder as a folder to scan.',
          buttons: ['Move files', 'Leave files', 'Cancel'],
          defaultId: 0,
          cancelId: 2
        })
        if (choice.response === 2) return { canceled: true }
        if (choice.response === 0) {
          const moveResult = await moveModelStorage(profile, current, directory, {
            ownedFiles: [],
            loadOwnedFiles: async () =>
              (await manager.desktopCatalog()).flatMap((model) => model.files),
            downloadsActive: () =>
              manager
                .listDownloads()
                .some((entry) => entry.status === 'queued' || entry.status === 'downloading')
          })
          moved = true
          unknownEntriesLeft = moveResult.unknownEntriesLeft
        } else {
          const { leaveModelStorage } = await import('./model-storage-move')
          leaveModelStorage(profile, current, directory)
          left = true
        }
      }
      if (!moved && !left) saveModelStorageChoice(profile, directory)
      return { directory, moved, unknownEntriesLeft, restartRequired: !sameFolder }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Cannot use this folder.' }
    }
  })
  ipcMain.handle('models:restart-for-directory', () => requestApplicationRelaunch(app))
  ipcMain.handle('models:scan-folders', () =>
    import('./model-storage-choice').then((m) => m.readModelScanFolders(app.getPath('userData')))
  )
  ipcMain.handle('models:add-scan-folder', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      title: 'Add a model folder',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    try {
      const folders = await import('./model-storage-choice').then((m) =>
        m.addModelScanFolder(app.getPath('userData'), result.filePaths[0]!)
      )
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('models:inventory-changed'))
      settingsChanged()
      return { folders }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Cannot read this folder.' }
    }
  })
  ipcMain.handle('models:remove-scan-folder', async (_, directory: string) => {
    const folders = await import('./model-storage-choice').then((m) =>
      m.removeModelScanFolder(app.getPath('userData'), directory)
    )
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('models:inventory-changed'))
    settingsChanged()
    return folders
  })
  ipcMain.handle('models:delete-orphans', () =>
    import('./models-manager').then((m) => m.deleteOrphans())
  )
  ipcMain.handle('models:downloads', () =>
    import('./models-manager').then((m) => m.listDownloads())
  )
  ipcMain.handle('models:retry-download', async (_, modelId: string) => {
    const { retryDownload } = await import('./models-manager')
    return retryDownload(modelId, (p) =>
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('model:download-progress', p))
    )
  })
  ipcMain.handle('models:clear-download', (_, modelId: string) =>
    import('./models-manager').then((m) => m.clearDownload(modelId))
  )
  ipcMain.handle('models:clear-downloads', () =>
    import('./models-manager').then((m) => m.clearInactiveDownloads())
  )
  ipcMain.handle(CACHE_CLEANUP_CHANNEL, () =>
    import('./cache-cleanup').then((m) => m.clearEphemeralCache())
  )
  // Import a local .gguf from disk (file picker → validate → copy → register).
  ipcMain.handle('models:import', async () => {
    const { dialog } = await import('electron')
    const r = await dialog.showOpenDialog({
      title: 'Import a local model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF model', extensions: ['gguf'] }]
    })
    if (r.canceled || !r.filePaths[0]) return { canceled: true }
    const { importLocalModel } = await import('./models-manager')
    return importLocalModel(r.filePaths[0], (p) =>
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('model:download-progress', p))
    )
  })

  // --- Setup + system health -----------------------------------------------
  // One aggregated snapshot of every local component (chat LLM, gateway, vision,
  // embeddings, STT, TTS, image gen) for the Settings → Health panel.
  // Preview what "Configure for me" would pick for a mode (no side effects).
  ipcMain.handle('setup:recommendation', (_e, mode?: string) =>
    import('./setup').then((m) =>
      m.getRecommendation(mode as 'conservative' | 'balanced' | 'extreme' | undefined)
    )
  )
  // Full setup plan (chat + STT + TTS + image) for a mode, so the UI can list every
  // model "Configure for me" will download before the user commits.
  ipcMain.handle('setup:plan', (_e, mode?: string) =>
    import('./setup').then((m) =>
      m.getSetupPlan(mode as 'conservative' | 'balanced' | 'extreme' | undefined)
    )
  )
  // Whether the active chat model can read images (gate image attachments on this).
  ipcMain.handle('model:chat-vision', () => import('./llm').then((m) => m.llm.hasVision()))
  // Reliable text→clipboard (the renderer's navigator.clipboard is flaky in Electron).
  ipcMain.handle('clipboard:write-text', (_e, text?: string) => {
    try {
      clipboard.writeText(String(text ?? ''))
      return true
    } catch {
      return false
    }
  })
  // "Configure for me": pick a RAM-appropriate model, download, activate, start,
  // verify. Streams progress back to all windows via 'setup:progress'.
  ipcMain.handle('setup:auto-configure', async () => {
    const { autoConfigure } = await import('./setup')
    return autoConfigure((p) =>
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('setup:progress', p))
    )
  })
  // Restart a component. We only ever stop OUR OWN processes — never SIGKILL an
  // arbitrary PID holding the port (that could kill an unrelated user app, and the
  // handler is renderer-reachable). llm.restart() tears down our llama-server with
  // a command-name guard; the gateway just stops + restarts our own server.
  ipcMain.handle('system:restart', async (_e, id: string) => {
    if (id === 'chat') {
      const { llm } = await import('./llm')
      await llm.restart() // safely stops our llama-server (guarded) and respawns
      return { success: true }
    }
    if (id === 'gateway') {
      const { startModelServer, stopModelServer } = await import('./model-server')
      try {
        stopModelServer()
      } catch {
        /* not running */
      }
      try {
        await startModelServer()
        return { success: true }
      } catch (error) {
        console.error('[model-server] restart failed', error)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { success: false, error: `cannot restart "${id}"` }
  })
  // Pre-activate RAM fit estimate (for a warning before loading a big model).
  ipcMain.handle('system:estimate-fit', (_e, modelId: string) =>
    import('./setup').then((m) => m.estimateModelFit(modelId))
  )

  // Open a safe web link or email draft in the user's default app.
  ipcMain.handle('app:open-external', async (_e, url: string) => {
    if (!/^(https:\/\/|mailto:)/i.test(url)) return { success: false }
    const { shell } = await import('electron')
    await shell.openExternal(url)
    return { success: true }
  })

  // Data & privacy — see and delete on-device data from one place.
  ipcMain.handle('data:summary', () => import('./data-privacy').then((m) => m.getDataSummary()))
  ipcMain.handle('data:clear', (_e, id: string, olderThanDays?: number) =>
    import('./data-privacy').then((m) =>
      m.clearCategory(
        id as 'chats' | 'memories' | 'captures' | 'meetings' | 'images',
        olderThanDays
      )
    )
  )
  ipcMain.handle('data:delete-all', () => import('./data-privacy').then((m) => m.deleteAllData()))

  // --- Image generation (stable-diffusion.cpp) ----------------------------
  ipcMain.handle('imagegen:status', async () => {
    const { imageGenStatus } = await import('./imagegen')
    return imageGenStatus()
  })

  const imageJobPublisher = (
    snapshot: import('../shared/image-generation-contract').ImageGenerationJobContract
  ): void => {
    if (snapshot.phase === 'running') {
      noteChatStreamImageProgress(
        snapshot.conversationId,
        snapshot.progress?.step,
        snapshot.progress?.total
      )
    } else if (snapshot.phase === 'succeeded') {
      endChatStreamForConversation(snapshot.conversationId, 'record_pending')
    } else if (snapshot.phase === 'failed' || snapshot.phase === 'cancelled') {
      endChatStreamForConversation(snapshot.conversationId, 'discarded')
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send('imagegen:job-state', snapshot)
    }
  }
  const imageConversationPublisher = (conversationId: string): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send('imagegen:conversation-updated', conversationId)
    }
  }
  const imageJobPublisherReady = import('./imagegen/job-service').then(
    ({ imageGenerationJobs }) => {
      imageGenerationJobs.onChange(imageJobPublisher)
      imageGenerationJobs.onConversationUpdated(imageConversationPublisher)
      return imageGenerationJobs
    }
  )

  ipcMain.handle('imagegen:job-status', async () => {
    const imageGenerationJobs = await imageJobPublisherReady
    return imageGenerationJobs.status()
  })

  ipcMain.handle(
    'imagegen:generate',
    async (
      _e,
      params: import('./imagegen').ImageGenParams & {
        conversationId?: string
        projectId?: string | null
      }
    ) => {
      const imageGenerationJobs = await imageJobPublisherReady
      // Admission belongs to the job service. Reject before changing the conversation stream, so a
      // second request cannot reset or discard the identity of the image that is already running.
      imageGenerationJobs.assertCanStart()
      beginChatImageStream(params.conversationId)
      try {
        const messageId = currentChatStreamMessageId(params.conversationId)
        return await imageGenerationJobs.start({
          ...params,
          ...(messageId ? { messageId } : {})
        })
      } catch (error) {
        endChatStreamForConversation(params.conversationId, 'discarded')
        throw error
      }
    }
  )

  ipcMain.handle('imagegen:cancel', async () => {
    const imageGenerationJobs = await imageJobPublisherReady
    return imageGenerationJobs.cancel()
  })

  ipcMain.handle(
    'imagegen:conversation-persisted',
    async (_event, conversationId: string, messageId?: string) => {
      const imageGenerationJobs = await imageJobPublisherReady
      return imageGenerationJobs.acknowledgeConversation(conversationId, messageId)
    }
  )

  ipcMain.handle(
    'imagegen:list',
    async (_e, scope?: { conversationId?: string; projectId?: string | null }) => {
      const { listGeneratedImages } = await import('./imagegen')
      return listGeneratedImages(scope)
    }
  )

  ipcMain.handle('imagegen:style-thumbs', async () => {
    const { listStyleThumbs } = await import('./imagegen')
    return listStyleThumbs()
  })
  ipcMain.handle('imagegen:list-loras', async () => {
    const { listLoras } = await import('./imagegen')
    return listLoras()
  })
  ipcMain.handle('imagegen:reveal-loras', async () => {
    const { ensureLoraDir } = await import('./imagegen')
    const { shell } = await import('electron')
    const dir = ensureLoraDir()
    await shell.openPath(dir)
    return dir
  })
  ipcMain.handle('imagegen:download-lora', async (e, url: string, filename: string) => {
    const { downloadLora } = await import('./imagegen')
    return downloadLora(url, filename, (pct) => {
      try {
        e.sender.send('imagegen:lora-progress', { filename, pct })
      } catch {
        /* window gone */
      }
    })
  })

  ipcMain.handle('imagegen:delete', async (_e, p: string) => {
    const { deleteGeneratedImage } = await import('./imagegen')
    return deleteGeneratedImage(p)
  })

  ipcMain.handle('imagegen:export', async (e, srcPath: string, suggestedName?: string) => {
    const { dialog } = await import('electron')
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showSaveDialog(win!, {
      title: 'Save image',
      defaultPath: suggestedName || 'off-grid-image.png',
      filters: [{ name: 'PNG', extensions: ['png'] }]
    })
    if (res.canceled || !res.filePath) return false
    const { exportGeneratedImage } = await import('./imagegen')
    await exportGeneratedImage(srcPath, res.filePath)
    return true
  })

  // --- Agentic tool-calling (isolated, opt-in) ----------------------------
  ipcMain.handle('tools:list', async () => {
    const { listTools } = await import('./tools')
    return listTools()
  })
  ipcMain.handle('tools:set-enabled', async (_e, name: string, enabled: boolean) => {
    const { setToolEnabled } = await import('./tools')
    setToolEnabled(name, enabled)
  })
  ipcMain.handle(
    'tools:chat',
    async (
      event,
      query: string,
      history?: { role: string; content: string }[],
      opts?: {
        assistantOnly?: boolean
        allTools?: boolean
        connectors?: boolean
        conversationId?: string
        projectId?: string
        allMemory?: boolean
        images?: string[]
        imageAvailable?: boolean
        streamId?: string
        thinking?: boolean
        /** What the user is doing now (God's context), added to the system prompt. */
        context?: string
        /** God's standing rules, which every reply follows. */
        rules?: readonly string[]
      }
    ) => {
      const { toolChat } = await import('./tools')
      const { modalityQueue, CHAT_JOB } = await import('./modality-queue/queue')
      const { imageGenerationRunsBesideChat } = await import('./imagegen')
      const streamId = opts?.streamId
      const sender = event.sender
      // Non-stream fallback (no streamId): buffer, no live deltas (matches streamAnswer).
      if (!streamId) {
        return modalityQueue.run(CHAT_JOB, async () => {
          const { result, modelName } = await runChatWithFallback(
            (attempt) => toolChat(query, history || [], { ...(opts || {}), ...attempt }),
            deviceFallbackNotices(sender, streamId)
          )
          return modelName ? { ...result, metrics: { ...result.metrics, modelName } } : result
        })
      }
      // Streaming: same channel/queue/abort as streamAnswer, so a tools turn streams
      // thinking -> tool-call activity -> answer, and the stop button (rag:cancel) aborts it.
      const controller = new AbortController()
      streamControllers.set(streamId, controller)
      bindChatStream(streamId, opts.conversationId, opts.thinking ? 'thinking' : 'waiting')
      let continuesAsImage = false
      let toolStarted = false
      try {
        const { result, modelName } = await modalityQueue.run(CHAT_JOB, () =>
          runChatWithFallback(
            (attempt) =>
              toolChat(query, history || [], {
                ...opts,
                ...attempt,
                thinking: opts.thinking,
                signal: controller.signal,
                onDelta: (text, kind) => {
                  noteChatStreamDelta(streamId, text, kind)
                  try {
                    sender.send('rag:stream', { streamId, type: kind, text })
                  } catch {
                    /* window gone */
                  }
                },
                onStep: (call) => {
                  toolStarted = true
                  noteChatStreamToolStarted(streamId, call.name)
                  try {
                    sender.send('rag:stream', {
                      streamId,
                      type: 'step',
                      step: { kind: 'running_tool', name: call.name }
                    })
                  } catch {
                    /* window gone */
                  }
                },
                onActivity: (activity) => {
                  try {
                    sender.send('rag:stream', { streamId, type: 'step', step: activity })
                  } catch {
                    /* window gone */
                  }
                },
                onToolResult: (call) => {
                  toolStarted = true
                  noteChatStreamToolCompleted(streamId, call.name, call.result, call.status)
                  try {
                    sender.send('rag:stream', { streamId, type: 'tool_result', call })
                  } catch {
                    /* window gone */
                  }
                },
                // A remote image server can start each picture while the model writes the next.
                ...(imageGenerationRunsBesideChat()
                  ? {
                      onImageRequest: (request: { prompt: string; enhancePrompt?: boolean }) => {
                        toolStarted = true
                        try {
                          sender.send('rag:stream', { streamId, type: 'image_request', request })
                        } catch {
                          /* window gone */
                        }
                      }
                    }
                  : {})
              }),
            {
              signal: controller.signal,
              canRetry: () => !toolStarted,
              ...deviceFallbackNotices(sender, streamId),
              onModelChanged: (failed, next) => {
                resetChatStreamPartial(streamId)
                try {
                  sender.send('rag:stream', {
                    streamId,
                    type: 'step',
                    step: { kind: 'model_changed', failed, next }
                  })
                } catch {
                  /* window gone */
                }
              }
            }
          )
        )
        if (result.imageRequests.length > 0) {
          continuesAsImage = continueChatStreamWithImage(streamId)
        }
        return modelName ? { ...result, metrics: { ...result.metrics, modelName } } : result
      } finally {
        streamControllers.delete(streamId)
        if (!continuesAsImage) {
          endChatStream(streamId, controller.signal.aborted ? 'discarded' : 'record_pending')
          try {
            sender.send('rag:stream', { streamId, type: 'done' })
          } catch {
            /* window gone */
          }
        }
      }
    }
  )

  // --- LLM inference settings (temperature, context window) ---------------
  ipcMain.handle('llm:get-settings', async () => {
    const { llm } = await import('./llm')
    return llm.getSettings()
  })
  ipcMain.handle('llm:set-settings', async (_e, s: import('./llm').LlmSettings) => {
    const { llm } = await import('./llm')
    const { isSpeedSettingsPatch } = await import('../shared/best-settings')
    if (isSpeedSettingsPatch(s)) (await import('./best-settings')).markSpeedSettingsManual()
    await llm.setSettings(s)
    return llm.getSettings()
  })
  ipcMain.handle('vision:remote-server:get', async () => {
    const { getRemoteVisionServerSettings } = await import('./vision/remote-vision-server')
    return getRemoteVisionServerSettings()
  })
  ipcMain.handle(
    'vision:remote-server:set',
    async (_e, update: import('../shared/remote-vision-server').RemoteVisionServerUpdate) => {
      const { setRemoteVisionServerSettings } = await import('./vision/remote-vision-server')
      return setRemoteVisionServerSettings(update)
    }
  )
  ipcMain.handle(
    'vision:remote-server:test',
    async (_e, update: import('../shared/remote-vision-server').RemoteVisionServerUpdate) => {
      const { testRemoteVisionServer } = await import('./vision/remote-vision-server')
      return testRemoteVisionServer(update)
    }
  )
  ipcMain.handle('vision:remote-server:remove', async (_e, serverId: string) => {
    const { removeRemoteVisionServer } = await import('./vision/remote-vision-server')
    return removeRemoteVisionServer(serverId)
  })
  // Cleanly unload the chat engine so it stops holding the model port (frees it for LM Studio /
  // another tool without force-quitting the app). Returns whether the port was actually freed.
  ipcMain.handle('llm:unload', async () => {
    const { llm } = await import('./llm')
    return llm.unload()
  })

  // --- Canvas / artifacts sandbox runtime ---------------------------------
  ipcMain.handle('artifacts:runtime', async (_e, kind: import('./artifacts').ArtifactKind) => {
    const { artifactRuntime } = await import('./artifacts')
    return artifactRuntime(kind)
  })
  setupArtifactPreviewIpc()
  ipcMain.handle(
    'artifacts:save',
    async (
      _e,
      a: {
        kind: import('./artifacts').ArtifactKind
        code: string
        title?: string
        conversationId?: string
        projectId?: string | null
      }
    ) => {
      const { saveArtifact } = await import('./artifacts')
      return saveArtifact(a)
    }
  )
  ipcMain.handle(
    'artifacts:list',
    async (_e, scope?: { conversationId?: string; projectId?: string | null }) => {
      const { listArtifacts } = await import('./artifacts')
      return listArtifacts(scope)
    }
  )
  ipcMain.handle('artifacts:delete', async (_e, id: string) => {
    const { deleteArtifact } = await import('./artifacts')
    return deleteArtifact(id)
  })

  // --- File attachments: any file -> text (read / parse / caption / transcribe) ---
  ipcMain.handle('files:process', async (_e, bytes: ArrayBuffer | Uint8Array, name: string) => {
    const { processUpload } = await import('./files')
    return processUpload(name, bytes)
  })
  // A picked or dropped file read where it is, so a large document never crosses IPC as bytes.
  ipcMain.handle('files:process-path', async (_e, filePath: string, name: string) => {
    const path = await import('path')
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Invalid file.')
    const { processUploadPath } = await import('./files')
    return processUploadPath(
      filePath,
      typeof name === 'string' && name ? name : path.basename(filePath)
    )
  })

  // --- Documents in a chat: what the conversation holds, and which ones answers may use ---
  ipcMain.handle('documents:list', async (_e, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId) return []
    const { conversationDocuments } = await import('./documents/conversation-documents')
    const { excludedDocuments } = await import('./documents/sqlite-store')
    const { documentIngest, documentStore } = await import('./documents')
    const excluded = excludedDocuments(conversationId)
    const seen = new Set<string>()
    const rows: Record<string, unknown>[] = []
    for (const source of await conversationDocuments.list(conversationId)) {
      if (seen.has(source.id)) continue
      seen.add(source.id)
      const stored = await documentStore.getDocument(source.id)
      rows.push({
        id: source.id,
        name: source.name,
        kind: source.kind,
        path: source.path ?? null,
        pageCount: stored?.pageCount ?? 0,
        state: stored?.state ?? 'reading',
        unreadablePages: stored?.unreadablePages ?? 0,
        error: stored?.error ?? null,
        excluded: excluded.has(source.id),
        progress: documentIngest.progressOf(source.id) ?? null
      })
    }
    return rows
  })
  ipcMain.handle(
    'documents:set-excluded',
    async (_e, conversationId: string, documentId: string, excluded: boolean) => {
      if (typeof conversationId !== 'string' || typeof documentId !== 'string') return false
      const { setDocumentExcluded } = await import('./documents/sqlite-store')
      setDocumentExcluded(conversationId, documentId, excluded === true)
      return true
    }
  )
  // An allowed local media file as a data URL. The chat viewer uses this for uploaded PDFs, and
  // artifact download uses it to make exported HTML images work outside the app. Admission matches
  // ogcapture: so this renderer-reachable handler cannot read arbitrary local files.
  ipcMain.handle('files:data-url', async (_e, p?: string) => {
    try {
      const fs = await import('fs')
      const path = await import('path')
      const { app } = await import('electron')
      const { localMediaRoots } = await import('./media-roots')
      const { isPathAllowed } = await import('./media-range')
      const { mimeForExt } = await import('./mime')
      const resolved = path.resolve(p ?? '')
      if (!isPathAllowed(resolved, localMediaRoots(app.getPath('userData')))) return null
      const buf = await fs.promises.readFile(resolved)
      const ext = (resolved.split('.').pop() || '').toLowerCase()
      const mime = mimeForExt(ext)
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })

  // --- Skills (.skills folder, invoked from chat with /skill-name) ---
  ipcMain.handle('skills:list', async () => {
    const { listSkills } = await import('./skills')
    return listSkills()
  })
  ipcMain.handle('skills:get', async (_e, name: string) => {
    const { getSkill } = await import('./skills')
    return getSkill(name)
  })
  ipcMain.handle('skills:save', async (_e, input: import('./skills').SkillSaveInput) => {
    const { saveSkill } = await import('./skills')
    return saveSkill(input)
  })
  ipcMain.handle('skills:delete', async (_e, name: string) => {
    const { deleteSkill } = await import('./skills')
    return deleteSkill(name)
  })
  ipcMain.handle('skills:dir', async () => {
    const { skillsDir } = await import('./skills')
    return skillsDir()
  })
  ipcMain.handle(
    'filesystem:pick-folder',
    async (_event, input?: { title?: string; defaultPath?: string }) => {
      const { dialog } = await import('electron')
      const result = await dialog.showOpenDialog({
        title: input?.title ?? 'Choose a folder',
        ...(input?.defaultPath ? { defaultPath: input.defaultPath } : {}),
        properties: ['openDirectory', 'createDirectory']
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }
  )

  // Which STT engine + model would run right now (provenance) + the installed transcription
  // models a picker can switch to (via the existing models:set-active-modal — this only lists).
  ipcMain.handle('transcription:active-info', async () =>
    (await import('./transcription/select')).readTranscriptionInfo()
  )

  /**
   * Keep the image a generation will be based on, and give it a name the mesh can use.
   *
   * The user picks an init image from their own disk. Referring to it there is not enough for two
   * reasons: the file can move or be deleted the moment the turn ends, and its path means nothing on
   * any other device. So it is copied into the app's own storage and given a uuid, which is what lets
   * it travel as an ordinary attachment on the message that used it.
   */
  ipcMain.handle('imagegen:keep-init-image', async (_e, sourcePath: string) => {
    const { preserveGeneratedImageSource } = await import('./imagegen')
    const id = crypto.randomUUID()
    const kept = preserveGeneratedImageSource(id, sourcePath)
    return kept ? { id, path: kept } : null
  })

  ipcMain.handle('imagegen:pick-image', async (e) => {
    const { dialog } = await import('electron')
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose an init image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })
}
