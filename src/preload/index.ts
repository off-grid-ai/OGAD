import { contextBridge, ipcRenderer } from 'electron'
import type { ArtifactKindContract } from '../shared/ipc-contracts'
import { createSyncPortableApi } from './sync-portable'

console.log('PRELOAD SCRIPT LOADED')

type IpcListener = Parameters<typeof ipcRenderer.removeListener>[1]

function unsubscribe(channel: string, listener: IpcListener): () => void {
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const offGridApi = {
  sync: createSyncPortableApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  // Open-core: is the pro tier active in this build/session? The main process
  // owns the decision (pro code bundled AND a valid Keygen license / env override)
  // and we read it synchronously at preload time so the renderer can lock/unlock
  // pro tabs without an async round-trip. See main/license-ipc.ts (`pro:is-enabled`).
  // Falls back to false if the handler isn't registered (should never happen).
  isPro: ipcRenderer.sendSync('pro:is-enabled') === true,
  // Host OS, bridged once so renderer copy and availability rules use the same value.
  platform: process.platform,
  // License (Keygen) activation + status for the upgrade/settings UI.
  license: {
    status: () => ipcRenderer.invoke('license:status'),
    activate: (key: string) => ipcRenderer.invoke('license:activate', key),
    listDevices: () => ipcRenderer.invoke('license:list-devices'),
    deactivate: (machineId: string) => ipcRenderer.invoke('license:deactivate', machineId),
    clear: () => ipcRenderer.invoke('license:clear'),
    payUrl: () => ipcRenderer.invoke('license:pay-url'),
    openPay: () => ipcRenderer.invoke('license:open-pay'),
    relaunch: () => ipcRenderer.invoke('license:relaunch'),
    onChanged: (cb: (info: unknown) => void) => {
      const sub = (_e: unknown, info: unknown): void => cb(info)
      ipcRenderer.on('license:changed', sub)
      return unsubscribe('license:changed', sub)
    }
  },
  // Generic passthrough so pro renderer code can reach pro IPC channels without
  // the core preload bundle enumerating them.
  proInvoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  proOn: (channel: string, cb: (...a: unknown[]) => void) => {
    const sub = (_e: unknown, ...a: unknown[]): void => cb(...a)
    ipcRenderer.on(channel, sub)
    return unsubscribe(channel, sub)
  },
  proOff: (channel: string) => ipcRenderer.removeAllListeners(channel),
  // Loopback HTTP URL for seekable local media (meeting recordings) — <video>
  // can't reliably stream large files over the custom protocol, so use real HTTP.
  getMediaUrl: (absPath: string) => ipcRenderer.invoke('media:url', absPath),
  // Clipboard manager is a Pro feature: its renderer reaches IPC through the
  // generic proInvoke / proOn passthrough above (no dedicated namespace here).
  getMemories: (limit: number, appName?: string) =>
    ipcRenderer.invoke('db:get-memories', limit, appName),
  addMemory: (content: string, source?: string) =>
    ipcRenderer.invoke('db:add-memory', content, source),
  searchMemories: (query: string) => ipcRenderer.invoke('db:search-memories', query),
  getStats: () => ipcRenderer.invoke('db:get-stats'),
  getDashboardStats: () => ipcRenderer.invoke('db:get-dashboard-stats'),
  extractMemory: (text: string) => ipcRenderer.invoke('llm:extract', text),

  // Chat Summaries
  getChatSessions: (appName?: string) => ipcRenderer.invoke('db:get-chat-sessions', appName),
  getMemoriesForSession: (sessionId: string) =>
    ipcRenderer.invoke('db:get-memories-for-session', sessionId),
  getEntitiesForSession: (sessionId: string) =>
    ipcRenderer.invoke('db:get-entities-for-session', sessionId),
  getMemoryRecordsForSession: (sessionId: string) =>
    ipcRenderer.invoke('db:get-memory-records-for-session', sessionId),
  summarizeSession: (sessionId: string) => ipcRenderer.invoke('llm:summarize-session', sessionId),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('db:delete-session', sessionId),

  // Master Memory
  getMasterMemory: () => ipcRenderer.invoke('db:get-master-memory'),
  regenerateMasterMemory: () => ipcRenderer.invoke('db:regenerate-master-memory'),

  // RAG Chat - updated to support conversation history + live streaming
  ragChat: (
    query: string,
    appName?: string,
    conversationHistory?: { role: string; content: string }[],
    projectId?: string | null,
    conversationId?: string,
    noMemory?: boolean,
    streamId?: string,
    thinking?: boolean,
    images?: string[]
  ) =>
    ipcRenderer.invoke(
      'rag:chat',
      query,
      appName,
      conversationHistory,
      projectId,
      conversationId,
      noMemory,
      streamId,
      thinking,
      images
    ),
  // Live token/reasoning/step events for an in-flight ragChat (matched by streamId).
  onRagStream: (
    callback: (data: {
      streamId: string
      type: 'content' | 'reasoning' | 'step'
      text?: string
      step?: unknown
    }) => void
  ) => {
    const sub = (
      _: unknown,
      data: {
        streamId: string
        type: 'content' | 'reasoning' | 'step'
        text?: string
        step?: unknown
      }
    ): void => callback(data)
    ipcRenderer.on('rag:stream', sub)
    return unsubscribe('rag:stream', sub)
  },
  // Stop an in-flight streaming turn; the partial answer is kept.
  cancelRag: (streamId: string) => ipcRenderer.send('rag:cancel', streamId),

  // RAG Conversation History
  createRagConversation: (id: string, title?: string, projectId?: string | null) =>
    ipcRenderer.invoke('rag:create-conversation', id, title, projectId),
  getRagConversations: (projectId?: string | null) =>
    ipcRenderer.invoke('rag:get-conversations', projectId),
  searchRagConversationIds: (query: string) =>
    ipcRenderer.invoke('rag:search-conversation-ids', query),
  setRagConversationProject: (id: string, projectId: string | null) =>
    ipcRenderer.invoke('rag:set-conversation-project', id, projectId),
  getRagConversation: (id: string) => ipcRenderer.invoke('rag:get-conversation', id),
  getRagMessages: (conversationId: string) =>
    ipcRenderer.invoke('rag:get-messages', conversationId),
  addRagMessage: (
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    context?: unknown
  ) => ipcRenderer.invoke('rag:add-message', conversationId, role, content, context),
  truncateRagMessages: (conversationId: string, keepCount: number) =>
    ipcRenderer.invoke('rag:truncate-messages', conversationId, keepCount),
  updateRagConversationTitle: (id: string, title: string) =>
    ipcRenderer.invoke('rag:update-conversation-title', id, title),
  deleteRagConversation: (id: string) => ipcRenderer.invoke('rag:delete-conversation', id),

  // Entities
  getEntities: (appName?: string) => ipcRenderer.invoke('db:get-entities', appName),
  getEntityDetails: (entityId: number, appName?: string) =>
    ipcRenderer.invoke('db:get-entity-details', entityId, appName),
  getEntityGraph: (appName?: string, focusEntityId?: number, edgeLimit?: number) =>
    ipcRenderer.invoke('db:get-entity-graph', appName, focusEntityId, edgeLimit),
  rebuildEntityGraph: () => ipcRenderer.invoke('db:rebuild-entity-graph'),
  deleteEntity: (entityId: number) => ipcRenderer.invoke('db:delete-entity', entityId),
  deleteMemory: (memoryId: number) => ipcRenderer.invoke('db:delete-memory', memoryId),

  // User Profile
  getUserProfile: () => ipcRenderer.invoke('db:get-user-profile'),
  saveUserProfile: (profile: Record<string, unknown>) =>
    ipcRenderer.invoke('db:save-user-profile', profile),

  // App Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:save', key, value),
  consoleEnroll: (url: string, token: string) => ipcRenderer.invoke('console:enroll', url, token),
  consoleStatus: () => ipcRenderer.invoke('console:status'),
  consoleSyncNow: () => ipcRenderer.invoke('console:sync-now'),
  consoleDisconnect: () => ipcRenderer.invoke('console:disconnect'),
  reprocessAllSessions: (clean?: boolean) =>
    ipcRenderer.invoke('db:reprocess-all-sessions', clean ?? false),

  // Master Memory Progress
  onMasterMemoryProgress: (callback: (data: { current: number; total: number }) => void) => {
    const subscription = (_event: unknown, data: { current: number; total: number }): void =>
      callback(data)
    ipcRenderer.on('master-memory:progress', subscription)
    return unsubscribe('master-memory:progress', subscription)
  },

  // Prompts
  getPrompts: () => ipcRenderer.invoke('prompts:get-all'),
  savePrompt: (key: string, value: string) => ipcRenderer.invoke('prompts:save', key, value),
  resetPrompt: (key: string) => ipcRenderer.invoke('prompts:reset', key),
  onReprocessProgress: (
    callback: (data: { phase: string; processed: number; total: number }) => void
  ) => {
    const subscription = (
      _event: unknown,
      data: { phase: string; processed: number; total: number }
    ): void => callback(data)
    ipcRenderer.on('reprocess:progress', subscription)
    return unsubscribe('reprocess:progress', subscription)
  },

  // Auto-update — fired when a new version finished downloading and is staged.
  // installUpdate() forces the quit+swap (Squirrel only applies on a graceful
  // quit; a force-kill would otherwise leave the download unapplied).
  onUpdateDownloaded: (callback: (data: { version: string }) => void) => {
    const subscription = (_event: unknown, data: { version: string }): void => callback(data)
    ipcRenderer.on('update:downloaded', subscription)
    return unsubscribe('update:downloaded', subscription)
  },
  getStagedUpdateVersion: () => ipcRenderer.invoke('update:staged-version'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  // Software-update controls for Settings: current version + auto-update toggle,
  // Per-modality runtime residency (on-demand vs resident/in-memory).
  residencyGet: () => ipcRenderer.invoke('runtime:residency:get'),
  residencySet: (modality: string, mode: string) =>
    ipcRenderer.invoke('runtime:residency:set', modality, mode),
  // and a manual "check for updates" that resolves with a definite status.
  updateGetPrefs: () => ipcRenderer.invoke('update:get-prefs'),
  updateSetAuto: (on: boolean) => ipcRenderer.invoke('update:set-auto', on),
  updateSetChannel: (channel: 'stable' | 'beta') =>
    ipcRenderer.invoke('update:set-channel', channel),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),

  // Watcher Events
  onWatcherData: (callback: (data: unknown) => void) => {
    const subscription = (_event: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('watcher:data', subscription)
    return unsubscribe('watcher:data', subscription)
  },
  onPermissionDenied: (callback: () => void) => {
    const subscription = (): void => callback()
    ipcRenderer.on('watcher:permission-denied', subscription)
    return unsubscribe('watcher:permission-denied', subscription)
  },

  // Notification Events — only the things that need the user's attention:
  // proactive approvals queued, and new to-dos extracted.
  onNewApproval: (
    callback: (data: {
      approvalId: number
      title: string
      detail: string
      entityName: string | null
    }) => void
  ) => {
    const subscription = (
      _event: unknown,
      data: {
        approvalId: number
        title: string
        detail: string
        entityName: string | null
      }
    ): void => callback(data)
    ipcRenderer.on('notification:new-approval', subscription)
    return unsubscribe('notification:new-approval', subscription)
  },
  onNewAction: (
    callback: (data: {
      actionId: number
      text: string
      due: string | null
      entityName: string | null
      sourceApp: string
    }) => void
  ) => {
    const subscription = (
      _event: unknown,
      data: {
        actionId: number
        text: string
        due: string | null
        entityName: string | null
        sourceApp: string
      }
    ): void => callback(data)
    ipcRenderer.on('notification:new-action', subscription)
    return unsubscribe('notification:new-action', subscription)
  },

  // Permission APIs
  getPermissionStatus: () => ipcRenderer.invoke('permissions:get-status'),
  requestAccessibilityPermission: () => ipcRenderer.invoke('permissions:request-accessibility'),
  requestScreenRecordingPermission: () =>
    ipcRenderer.invoke('permissions:request-screen-recording'),
  openAccessibilitySettings: () => ipcRenderer.invoke('permissions:open-accessibility-settings'),
  openScreenRecordingSettings: () =>
    ipcRenderer.invoke('permissions:open-screen-recording-settings'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),

  // Model Download APIs
  checkModelStatus: () => ipcRenderer.invoke('model:check-status'),
  downloadModels: () => ipcRenderer.invoke('model:download'),
  onModelDownloadProgress: (
    callback: (data: {
      modelName: string
      percent: number
      downloadedMB: string
      totalMB: string
    }) => void
  ) => {
    const subscription = (
      _event: unknown,
      data: { modelName: string; percent: number; downloadedMB: string; totalMB: string }
    ): void => callback(data)
    ipcRenderer.on('model:download-progress', subscription)
    return unsubscribe('model:download-progress', subscription)
  },

  // Off Grid model catalog (text, vision, image, voice, transcription)
  getModelCatalog: () => ipcRenderer.invoke('models:catalog'),
  getInstalledModels: () => ipcRenderer.invoke('models:installed'),
  searchModels: (query: string, kind?: string) => ipcRenderer.invoke('models:search', query, kind),
  downloadModel: (modelId: string) => ipcRenderer.invoke('models:download', modelId),
  cancelModelDownload: (modelId: string) => ipcRenderer.invoke('models:cancel-download', modelId),
  deleteModel: (modelId: string) => ipcRenderer.invoke('models:delete', modelId),
  setActiveModel: (modelId: string) => ipcRenderer.invoke('models:set-active', modelId),
  // Activate any model for its type — UI calls this and never branches on kind.
  activateModel: (modelId: string) => ipcRenderer.invoke('models:activate', modelId),
  getActiveModel: () => ipcRenderer.invoke('models:get-active'),
  getActiveModelIds: () => ipcRenderer.invoke('models:active-ids'),
  setActiveModalModel: (kind: string, modelId: string | null) =>
    ipcRenderer.invoke('models:set-active-modal', kind, modelId),
  getActiveModalities: () => ipcRenderer.invoke('models:active-modalities'),
  onModelProgress: (
    callback: (data: {
      modelName: string
      percent: number
      downloadedMB: string
      totalMB: string
    }) => void
  ) => {
    const subscription = (
      _event: unknown,
      data: { modelName: string; percent: number; downloadedMB: string; totalMB: string }
    ): void => callback(data)
    ipcRenderer.on('model:download-progress', subscription)
    return unsubscribe('model:download-progress', subscription)
  },

  // Setup + system health
  systemHealth: () => ipcRenderer.invoke('system:health'),
  setupRecommendation: (mode?: string) => ipcRenderer.invoke('setup:recommendation', mode),
  setupPlan: (mode?: string) => ipcRenderer.invoke('setup:plan', mode),
  chatVisionAvailable: () => ipcRenderer.invoke('model:chat-vision'),
  writeClipboardText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
  autoConfigure: () => ipcRenderer.invoke('setup:auto-configure'),
  restartComponent: (id: string) => ipcRenderer.invoke('system:restart', id),
  estimateModelFit: (modelId: string) => ipcRenderer.invoke('system:estimate-fit', modelId),

  // Storage + download manager
  getStorageInfo: () => ipcRenderer.invoke('models:storage'),
  deleteOrphans: () => ipcRenderer.invoke('models:delete-orphans'),
  listDownloads: () => ipcRenderer.invoke('models:downloads'),
  retryDownload: (modelId: string) => ipcRenderer.invoke('models:retry-download', modelId),
  clearDownload: (modelId: string) => ipcRenderer.invoke('models:clear-download', modelId),
  clearDownloads: () => ipcRenderer.invoke('models:clear-downloads'),
  importLocalModel: () => ipcRenderer.invoke('models:import'),

  // Data & privacy
  getDataSummary: () => ipcRenderer.invoke('data:summary'),
  clearDataCategory: (id: string, olderThanDays?: number) =>
    ipcRenderer.invoke('data:clear', id, olderThanDays),
  deleteAllData: () => ipcRenderer.invoke('data:delete-all'),
  onSetupProgress: (callback: (data: unknown) => void) => {
    const subscription = (_event: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('setup:progress', subscription)
    return unsubscribe('setup:progress', subscription)
  },

  // --- Agentic tool-calling (built-in tools) ---
  listTools: () => ipcRenderer.invoke('tools:list'),
  setToolEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke('tools:set-enabled', name, enabled),
  toolChat: (
    query: string,
    history?: { role: string; content: string }[],
    opts?: {
      connectors?: boolean
      conversationId?: string
      images?: string[]
      imageAvailable?: boolean
      streamId?: string
      thinking?: boolean
    }
  ) => ipcRenderer.invoke('tools:chat', query, history, opts),

  // --- LLM inference settings ---
  getLlmSettings: () => ipcRenderer.invoke('llm:get-settings'),
  setLlmSettings: (s: {
    temperature?: number
    ctxSize?: number
    topP?: number
    topK?: number
    minP?: number
    repeatPenalty?: number
    maxTokens?: number
    systemPrompt?: string
    kvCacheType?: 'f16' | 'q8_0' | 'q4_0'
    flashAttn?: boolean
    gpuLayers?: number
    threads?: number
    batchSize?: number
    performanceMode?: 'conservative' | 'balanced' | 'extreme'
  }) => ipcRenderer.invoke('llm:set-settings', s),

  // --- Canvas / artifacts sandbox runtime + library ---
  artifactRuntime: (kind: ArtifactKindContract) => ipcRenderer.invoke('artifacts:runtime', kind),
  // Kind union MUST match the renderer's `saveArtifact` contract in
  // src/renderer/src/env.d.ts (text/image are real artifact kinds). Guarded by
  // src/main/__tests__/ipc-type-parity.test.ts.
  saveArtifact: (a: {
    kind: 'html' | 'svg' | 'mermaid' | 'react' | 'text' | 'image'
    code: string
    title?: string
    conversationId?: string
    projectId?: string | null
  }) => ipcRenderer.invoke('artifacts:save', a),
  listArtifacts: (scope?: { conversationId?: string; projectId?: string | null }) =>
    ipcRenderer.invoke('artifacts:list', scope),
  deleteArtifact: (id: string) => ipcRenderer.invoke('artifacts:delete', id),

  // --- File attachments → text ---
  processFile: (bytes: ArrayBuffer, name: string) =>
    ipcRenderer.invoke('files:process', bytes, name),
  fileDataUrl: (path: string) => ipcRenderer.invoke('files:data-url', path),

  // --- Skills ---
  listSkills: () => ipcRenderer.invoke('skills:list'),
  getSkill: (name: string) => ipcRenderer.invoke('skills:get', name),
  saveSkill: (input: {
    name: string
    description: string
    instructions: string
    originalName?: string
    trigger?:
      | { kind: 'schedule'; at: string }
      | { kind: 'keyword'; keywords: string[] }
      | { kind: 'event'; on: 'calendar' | 'approval' }
      | null
    action?: string
    connectors?: boolean
  }) => ipcRenderer.invoke('skills:save', input),
  deleteSkill: (name: string) => ipcRenderer.invoke('skills:delete', name),
  skillsDir: () => ipcRenderer.invoke('skills:dir'),

  // --- Voice input (speech-to-text via whisper) ---
  transcribeAudio: (audio: ArrayBuffer | Uint8Array, ext?: string) =>
    ipcRenderer.invoke('voice:transcribe', audio, ext),

  // --- Voice output (text-to-speech via Kokoro) ---
  ttsVoices: () => ipcRenderer.invoke('tts:voices'),
  speak: (text: string, voice?: string) => ipcRenderer.invoke('tts:speak', text, voice),

  // --- On-device image generation (stable-diffusion.cpp) ---
  imageGenStatus: () => ipcRenderer.invoke('imagegen:status'),
  cancelImageGen: () => ipcRenderer.invoke('imagegen:cancel'),
  listGeneratedImages: (scope?: { conversationId?: string; projectId?: string | null }) =>
    ipcRenderer.invoke('imagegen:list', scope),
  styleThumbs: () => ipcRenderer.invoke('imagegen:style-thumbs'),
  makeStyleThumb: (key: string, prompt: string) =>
    ipcRenderer.invoke('imagegen:make-style-thumb', key, prompt),
  listLoras: () => ipcRenderer.invoke('imagegen:list-loras'),
  revealLoras: () => ipcRenderer.invoke('imagegen:reveal-loras'),
  downloadLora: (url: string, filename: string) =>
    ipcRenderer.invoke('imagegen:download-lora', url, filename),
  onLoraProgress: (cb: (p: { filename: string; pct: number }) => void) => {
    const sub = (_event: unknown, p: { filename: string; pct: number }): void => cb(p)
    ipcRenderer.on('imagegen:lora-progress', sub)
    return unsubscribe('imagegen:lora-progress', sub)
  },
  deleteGeneratedImage: (p: string) => ipcRenderer.invoke('imagegen:delete', p),
  exportGeneratedImage: (srcPath: string, suggestedName?: string) =>
    ipcRenderer.invoke('imagegen:export', srcPath, suggestedName),
  onImageGenProgress: (
    cb: (p: {
      step: number
      total: number
      secPerStep: number
      preview?: string
      phase?: 'sampling' | 'decoding'
    }) => void
  ) => {
    const sub = (
      _event: unknown,
      p: {
        step: number
        total: number
        secPerStep: number
        preview?: string
        phase?: 'sampling' | 'decoding'
      }
    ): void => cb(p)
    ipcRenderer.on('imagegen:progress', sub)
    return unsubscribe('imagegen:progress', sub)
  },
  pickImageForGen: () => ipcRenderer.invoke('imagegen:pick-image'),
  generateImage: (params: {
    prompt: string
    negativePrompt?: string
    width?: number
    height?: number
    steps?: number
    seed?: number
    cfgScale?: number
    model?: string
    initImage?: string
    strength?: number
    loras?: { name: string; weight: number }[]
    conversationId?: string
    projectId?: string | null
  }) => ipcRenderer.invoke('imagegen:generate', params),

  // --- Projects + RAG (knowledge bases) + project chat ---
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (p: {
    name: string
    description?: string
    systemPrompt?: string
    icon?: string
  }) => ipcRenderer.invoke('projects:create', p),
  updateProject: (id: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke('projects:update', id, patch),
  deleteProject: (id: string) => ipcRenderer.invoke('projects:delete', id),
  listProjectDocuments: (projectId: string) =>
    ipcRenderer.invoke('projects:list-documents', projectId),
  addProjectDocuments: (projectId: string) =>
    ipcRenderer.invoke('projects:add-documents', projectId),
  toggleProjectDocument: (docId: number, enabled: boolean) =>
    ipcRenderer.invoke('projects:toggle-document', docId, enabled),
  deleteProjectDocument: (docId: number) => ipcRenderer.invoke('projects:delete-document', docId),
  onProjectIndexProgress: (callback: (data: unknown) => void) => {
    const subscription = (_event: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('projects:index-progress', subscription)
    return unsubscribe('projects:index-progress', subscription)
  },

  // --- CRM: entity records (Entity -> App -> frames) + resolution/corrections ---
  crmListEntities: () => ipcRenderer.invoke('crm:list-entities'),
  crmEntityRecord: (entityId: number, opts?: { surface?: string; limit?: number }) =>
    ipcRenderer.invoke('crm:entity-record', entityId, opts),
  crmObservationFrames: (observationId: number) =>
    ipcRenderer.invoke('crm:observation-frames', observationId),
  crmSearch: (query: string, entityId?: number) =>
    ipcRenderer.invoke('crm:search', query, entityId),
  searchFacets: (query: string) => ipcRenderer.invoke('search:facets', query),
  universalSearch: (
    query: string,
    opts?: {
      limit?: number
      semantic?: boolean
      sources?: string[]
      sort?: 'relevance' | 'recency' | 'match'
    }
  ) => ipcRenderer.invoke('search:universal', query, opts),
  searchStatus: () => ipcRenderer.invoke('search:status'),
  searchSources: () => ipcRenderer.invoke('search:sources'),
  searchReindex: () => ipcRenderer.invoke('search:reindex'),
  crmDayActivity: (startSec: number, endSec: number) =>
    ipcRenderer.invoke('crm:day-activity', startSec, endSec),
  crmAhead: (nowSec?: number) => ipcRenderer.invoke('crm:ahead', nowSec),
  crmEventPrep: (title: string, attendees: string[]) =>
    ipcRenderer.invoke('crm:event-prep', title, attendees),
  crmDayPlan: (nowSec?: number) => ipcRenderer.invoke('crm:day-plan', nowSec),
  crmDayPlanCached: (nowSec?: number) => ipcRenderer.invoke('crm:day-plan-cached', nowSec),
  crmProposeActions: (nowSec?: number) => ipcRenderer.invoke('crm:propose-actions', nowSec),
  crmRenameEntity: (id: number, name: string) => ipcRenderer.invoke('crm:rename-entity', id, name),
  crmRetypeEntity: (id: number, type: string) => ipcRenderer.invoke('crm:retype-entity', id, type),
  crmAddAlias: (id: number, kind: string, value: string) =>
    ipcRenderer.invoke('crm:add-alias', id, kind, value),
  crmRemoveAlias: (aliasId: number) => ipcRenderer.invoke('crm:remove-alias', aliasId),
  crmSetEntityPhoto: (id: number) => ipcRenderer.invoke('crm:set-entity-photo', id),
  crmClearEntityPhoto: (id: number) => ipcRenderer.invoke('crm:clear-entity-photo', id),
  crmMergeEntities: (keepId: number, mergeId: number) =>
    ipcRenderer.invoke('crm:merge-entities', keepId, mergeId),
  crmSplitObservations: (observationIds: number[], toName: string, toType?: string) =>
    ipcRenderer.invoke('crm:split-observations', observationIds, toName, toType),
  crmMergeSuggestions: () => ipcRenderer.invoke('crm:merge-suggestions'),
  crmDismissSuggestion: (id: number) => ipcRenderer.invoke('crm:dismiss-suggestion', id),
  crmSetParent: (childId: number, parentId: number | null) =>
    ipcRenderer.invoke('crm:set-parent', childId, parentId),
  crmSetHidden: (id: number, hidden: boolean) => ipcRenderer.invoke('crm:set-hidden', id, hidden),
  crmUnlinkObservation: (obsId: number, entityId: number) =>
    ipcRenderer.invoke('crm:unlink-observation', obsId, entityId),
  crmReassignObservation: (obsId: number, fromEntityId: number, toName: string, toType?: string) =>
    ipcRenderer.invoke('crm:reassign-observation', obsId, fromEntityId, toName, toType),
  crmDeleteObservation: (obsId: number) => ipcRenderer.invoke('crm:delete-observation', obsId),
  onCrmChanged: (callback: () => void) => {
    const sub = (): void => callback()
    ipcRenderer.on('crm:changed', sub)
    return unsubscribe('crm:changed', sub)
  },
  crmChildren: (parentId: number) => ipcRenderer.invoke('crm:children', parentId),
  crmOrganize: () => ipcRenderer.invoke('crm:organize'),
  crmSummarizeEntity: (id: number) => ipcRenderer.invoke('crm:summarize-entity', id),
  crmDayJournal: (startSec: number, endSec: number) =>
    ipcRenderer.invoke('crm:day-journal', startSec, endSec),
  crmDayJournalCached: (startSec: number) => ipcRenderer.invoke('crm:day-journal-cached', startSec),
  crmReplayFrames: (startSec: number, endSec: number) =>
    ipcRenderer.invoke('crm:replay-frames', startSec, endSec),
  crmReplayThreads: (startSec: number, endSec: number) =>
    ipcRenderer.invoke('crm:replay-threads', startSec, endSec),
  crmReplayEntityDay: (entityId: number, startSec: number, endSec: number) =>
    ipcRenderer.invoke('crm:replay-entity-day', entityId, startSec, endSec),
  crmReplayDefaultDay: () => ipcRenderer.invoke('crm:replay-default-day'),
  crmDayReflection: (startSec: number, endSec: number) =>
    ipcRenderer.invoke('crm:day-reflection', startSec, endSec),
  crmWeekReflection: (anchorDayStartSec: number) =>
    ipcRenderer.invoke('crm:week-reflection', anchorDayStartSec),
  crmListActions: () => ipcRenderer.invoke('crm:list-actions'),
  crmSetActionStatus: (id: number, status: 'open' | 'done' | 'dismissed') =>
    ipcRenderer.invoke('crm:set-action-status', id, status),
  crmAddTodo: (text: string) => ipcRenderer.invoke('crm:add-todo', text),

  // Identity
  idGet: () => ipcRenderer.invoke('id:get'),
  idSet: (id: { name?: string; email?: string; emails?: string[] }) =>
    ipcRenderer.invoke('id:set', id),

  // Secrets (values never returned to renderer — only key names)
  secretsAvailable: () => ipcRenderer.invoke('secrets:available'),
  secretsSet: (key: string, value: string) => ipcRenderer.invoke('secrets:set', key, value),
  secretsDelete: (key: string) => ipcRenderer.invoke('secrets:delete', key),
  secretsListKeys: () => ipcRenderer.invoke('secrets:list-keys'),

  // Approvals (the act-pillar spine)
  approvalsList: (status?: string) => ipcRenderer.invoke('approvals:list', status),
  approvalsProvenance: (id: number) => ipcRenderer.invoke('approvals:provenance', id),
  approvalsApprove: (id: number) => ipcRenderer.invoke('approvals:approve', id),
  approvalsReject: (id: number, reason?: string) =>
    ipcRenderer.invoke('approvals:reject', id, reason),
  reportSelfView: (view: string) => ipcRenderer.invoke('capture:self-view', view),
  secretaryPrefsGet: () => ipcRenderer.invoke('secretary:prefs:get'),
  secretaryPrefsSet: (doc: string) => ipcRenderer.invoke('secretary:prefs:set', doc),
  secretaryPrefsDistill: () => ipcRenderer.invoke('secretary:prefs:distill'),
  approvalsAudit: (limit?: number) => ipcRenderer.invoke('approvals:audit', limit),

  // MCP connectors
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpAdd: (c: {
    name: string
    transport: 'stdio' | 'http'
    command?: string
    args?: string[]
    envKeys?: string[]
    url?: string
  }) => ipcRenderer.invoke('mcp:add', c),
  mcpSetEnabled: (id: number, enabled: boolean) =>
    ipcRenderer.invoke('mcp:set-enabled', id, enabled),
  mcpRemove: (id: number) => ipcRenderer.invoke('mcp:remove', id),
  mcpTest: (id: number) => ipcRenderer.invoke('mcp:test', id),
  mcpIngest: (id: number, query?: string) => ipcRenderer.invoke('mcp:ingest', id, query),
  mcpItems: (surface: string) => ipcRenderer.invoke('mcp:items', surface),

  // Meeting recorder (screen video + system audio + mic → local transcript)
  meetingSave: (audio: Uint8Array, meta: { startedAt: number; endedAt: number; ext?: string }) =>
    ipcRenderer.invoke('meeting:save', audio, meta),
  // Native recorder — main process captures everything via the Swift binary.
  // Commands only — the main-process MeetingController owns the lifecycle.
  meetingStart: (platform?: string) => ipcRenderer.invoke('meeting:start', platform),
  meetingStop: () => ipcRenderer.invoke('meeting:stop'),
  meetingKeepAlive: () => ipcRenderer.invoke('meeting:keep-alive'),
  meetingGetState: () => ipcRenderer.invoke('meeting:get-state'),
  meetingList: () => ipcRenderer.invoke('meeting:list'),
  meetingDelete: (id: number) => ipcRenderer.invoke('meeting:delete', id),
  meetingRetranscribe: (id: number) => ipcRenderer.invoke('meeting:retranscribe', id),
  meetingPlayablePath: (p: string) => ipcRenderer.invoke('meeting:playable-path', p),
  // The controller broadcasts its full state here; the renderer just reflects it.
  onMeetingState: (cb: (s: unknown) => void) => {
    const sub = (_e: unknown, s: unknown): void => cb(s)
    ipcRenderer.on('meeting:state', sub)
    return unsubscribe('meeting:state', sub)
  },
  // Main-driven view navigation (used by the tray to jump to a screen).
  onNavigate: (cb: (view: string) => void) => {
    const sub = (_e: unknown, view: string): void => cb(view)
    ipcRenderer.on('navigate', sub)
    return unsubscribe('navigate', sub)
  }
}

export type OffGridAPI = typeof offGridApi

try {
  contextBridge.exposeInMainWorld('api', offGridApi)
  console.log('API Exposed successfully')
} catch (e) {
  console.error('Failed to expose API:', e)
}
