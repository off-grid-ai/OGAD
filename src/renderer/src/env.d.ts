/// <reference types="vite/client" />

type UserProfile = import('../../shared/ipc-contracts').UserProfileContract

interface ProLicenseInfo {
  isPro: boolean
  tier: 'lifetime' | 'monthly' | 'annual' | 'subscription' | null
  expiry: string | null
  verifiedAt: number
}

type OffGridPermissionStatus = import('../../shared/ipc-contracts').PermissionStatusContract

interface DashboardStats {
  totalChats: number
  totalMemories: number
  totalEntities: number
  totalRelationships: number
  totalMessages: number
  totalFacts: number
  todayChats: number
  todayMemories: number
  todayEntities: number
  recentChats: Array<{
    session_id: string
    title: string | null
    app_name: string
    memory_count: number
    entity_count: number
    updated_at: string
  }>
  recentMemories: Array<{
    id: number
    content: string
    source_app: string
    created_at: string
  }>
  topEntities: Array<{
    id: number
    name: string
    type: string
    fact_count: number
    session_count: number
  }>
  entityTypeCounts: Array<{
    type: string
    count: number
  }>
  appDistribution: Array<{
    app_name: string
    chat_count: number
    memory_count: number
  }>
  activityByDay: Array<{
    date: string
    chats: number
    memories: number
  }>
}

type RagConversation = import('../../shared/ipc-contracts').RagConversationContract

type RagMessage = import('../../shared/ipc-contracts').RagMessageContract
type RagChatResult = import('../../shared/ipc-contracts').RagChatResultContract

// DUPLICATE (ambient decl). Canonical shape: the `reprocess:progress` IPC payload
// emitted in src/main/ipc.ts. Keep in sync; guarded by ipc-type-parity.test.ts.
interface ReprocessProgress {
  phase: string
  processed: number
  total: number
}

interface AppSettings {
  memoryStrictness?: 'lenient' | 'balanced' | 'strict'
  entityStrictness?: 'lenient' | 'balanced' | 'strict'
  [key: string]: unknown
}

interface ChatSessionRecord {
  session_id: string
  last_activity: string
  memory_count: number
  entity_count: number
  summary: string | null
}

interface SessionMemoryRecord {
  id: number
  content: string
  raw_text: string | null
  source_app: string | null
  session_id: string
  created_at: string
}

interface MemoryListRecord {
  id: number
  name: string | null
  content: string
  source_app: string
  created_at: string
}

interface SessionEntityRecord {
  id: number
  name: string
  type: string
  summary: string | null
  updated_at: string
  fact_count: number
}

type ArtifactKind = import('../../shared/ipc-contracts').ArtifactKindContract

interface RendererAPIOverrides {
  // Open-core bridge
  isPro?: boolean
  proEntitlementBootstrapEnabled?: boolean
  // Host OS (process.platform), bridged at preload time. Used by lib/device.ts
  // to name the machine ('Mac' on darwin, else 'device').
  platform?: string
  /** Approval UX v2: the inline gate card + outcome/undo feed. */
  actions?: {
    getProjection: () => Promise<import('@offgrid/application').UseSnapshot>
    onProjection: (cb: (snapshot: import('@offgrid/application').UseSnapshot) => void) => () => void
    retry: (
      actionId: string
    ) => Promise<
      import('@offgrid/application').Outcome<boolean, import('@offgrid/application').UseFailure>
    >
    resolveGate: (actionId: string, decision: unknown) => Promise<boolean>
    undo: (record: unknown) => Promise<{ ok: boolean; detail?: string }>
  }
  tasks?: {
    list: (limit?: number) => Promise<
      Array<{
        taskId: string
        journeyId?: string
        modelId?: string
        modelName?: string
        kind: 'web_use' | 'computer_use'
        title: string
        status: 'running' | 'paused' | 'waiting' | 'reconnecting' | 'done' | 'failed' | 'stopped'
        summary?: string
        steps: string[]
        startedAt: number
        finishedAt?: number
        updatedAt: number
        executionDeviceId?: string
        executionDeviceName?: string
        phase?: import('./lib/task-session-store').ComputerUsePhase
        currentStep?: number
        currentAction?: string
        currentReasoning?: string
        reasoningLive?: boolean
        lastUrl?: string
        lastTitle?: string
        screenshotPath?: string
        screenshotDeviceId?: string
        stepDetails?: import('./lib/task-session-store').ComputerUseStepDetail[]
      }>
    >
    retryAvailability: (taskId: string) => Promise<{
      available: boolean
      reason?: string
      executionDeviceId?: string
      executionDeviceName?: string
    }>
    retry: (taskId: string) => Promise<{
      available: boolean
      reason?: string
      taskId?: string
      journeyId?: string
      executionDeviceId?: string
      executionDeviceName?: string
    }>
    guideAvailability: (taskId: string) => Promise<{ available: boolean; reason?: string }>
    guideTask: (
      taskId: string,
      input: import('../../shared/task-guidance').TaskGuideInput
    ) => Promise<{ available: boolean; accepted?: boolean; reason?: string }>
    onChanged: (cb: (task: import('./lib/task-session-store').TaskSession) => void) => () => void
  }
  browser?: {
    /** Report where one surface can host the live page. Main paints the highest-priority owner. */
    setRegion: (
      owner: 'docked' | 'floating',
      rect: { x: number; y: number; width: number; height: number } | null
    ) => void
    newTab: (journeyId?: string) => Promise<{ sessionId: string }>
    openUrl: (url: string, journeyId?: string) => Promise<{ sessionId: string } | null>
    getSessions: () => Promise<{
      activeSessionId: string | null
      sessions: Array<{
        sessionId: string
        historyId?: string
        kind: 'manual' | 'task'
        journeyId?: string
        parentSessionId?: string
        taskId?: string
        status: import('../../shared/browser-session').BrowserTaskStatus | 'open'
        url: string
        title: string
        canGoBack: boolean
        canGoForward: boolean
        isLoading: boolean
      }>
    }>
    activateSession: (sessionId: string) => Promise<boolean>
    closeSession: (sessionId: string) => Promise<boolean>
    control: (
      action: 'back' | 'forward' | 'reload' | 'stop',
      sessionId?: string
    ) => Promise<boolean>
    navigate: (address: string, sessionId?: string) => Promise<{ ok: boolean; detail?: string }>
    reopen: (taskId?: string) => Promise<boolean>
    listManualHistory: () => Promise<
      Array<{ historyId: string; title: string; url: string; updatedAt: number }>
    >
    reopenManual: (historyId: string) => Promise<{ sessionId: string } | null>
    onSessionsState: (cb: (state: unknown) => void) => () => void
    onNavigationState: (cb: (state: unknown) => void) => () => void
    onStep: (cb: (step: unknown) => void) => () => void
    onTaskState: (cb: (state: unknown) => void) => () => void
  }
  vision?: {
    control: (
      command: 'stop' | 'pause' | 'takeover' | 'resume',
      taskId?: string
    ) => Promise<boolean>
    showSupervisor: () => Promise<boolean>
    dismissSupervisor: () => Promise<boolean>
    getCurrent: () => Promise<{ state: unknown; steps: string[] } | null>
    onStep: (cb: (step: unknown) => void) => () => void
    onTaskState: (cb: (state: unknown) => void) => () => void
    onNotice: (cb: (notice: unknown) => void) => () => void
  }
  proInvoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
  proOn?: (channel: string, cb: (...a: unknown[]) => void) => () => void
  proOff?: (channel: string) => void

  // Keygen licensing (activation + status for the upgrade/settings UI)
  license?: {
    status: () => Promise<ProLicenseInfo>
    activate: (key: string) => Promise<import('@offgrid/application').PersonalMeshActivationResult>
    listDevices: () => Promise<
      Array<{
        id: string
        fingerprint: string
        platform: string | null
        name: string | null
        lastSeen: string | null
      }>
    >
    deactivate: (machineId: string) => Promise<boolean>
    resetCurrentDevice: () => Promise<boolean>
    clear: () => Promise<void>
    payUrl: () => Promise<string>
    openPay: () => Promise<void>
    relaunch: () => Promise<void>
    onChanged: (cb: (info: ProLicenseInfo) => void) => () => void
  }
  onMasterMemoryProgress?: (
    callback: (data: { current: number; total: number }) => void
  ) => () => void
  getMemories: (limit: number, appName?: string) => Promise<MemoryListRecord[]>
  addMemory: (content: string, source?: string) => Promise<{ id: number }>
  searchMemories: (query: string) => Promise<unknown[]>
  getStats: () => Promise<Record<string, number>>
  getDashboardStats: () => Promise<DashboardStats>
  extractMemory: (text: string) => Promise<{ summary: string; entities: string[]; topic: string }>

  getChatSessions: (appName?: string) => Promise<ChatSessionRecord[]>
  getMemoriesForSession: (sessionId: string) => Promise<unknown[]>
  getEntitiesForSession: (sessionId: string) => Promise<SessionEntityRecord[]>
  getMemoryRecordsForSession: (sessionId: string) => Promise<SessionMemoryRecord[]>
  summarizeSession: (sessionId: string) => Promise<string>
  deleteSession: (sessionId: string) => Promise<boolean>

  // Master Memory
  getMasterMemory: () => Promise<{ content: string | null; updated_at: string | null }>
  regenerateMasterMemory: () => Promise<string | null>

  // RAG Chat
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
  ) => Promise<RagChatResult>
  onRagStream: (
    callback: (data: {
      streamId: string
      type: 'content' | 'reasoning' | 'step' | 'tool_result' | 'done'
      text?: string
      step?: unknown
      call?: { name: string; result: string; status: 'completed' | 'failed' | 'pending' }
    }) => void
  ) => () => void
  getActiveRagStreams?: () => Promise<
    import('../../shared/ipc-contracts').ActiveChatStreamContract[]
  >
  cancelRag: (streamId: string) => void

  // RAG Conversations
  createRagConversation: (id: string, title?: string, projectId?: string | null) => Promise<string>
  getRagConversations: (
    projectId?: string | null,
    page?: { limit?: number; updatedBefore?: string }
  ) => Promise<RagConversation[]>
  onRagConversationsChanged?: (
    callback: (data: { conversationId: string; projectId: string | null }) => void
  ) => () => void
  setRagConversationProject: (id: string, projectId: string | null) => Promise<boolean>
  getRagConversation: (id: string) => Promise<RagConversation | null>
  getRagMessages: (conversationId: string) => Promise<RagMessage[]>
  readChatSessionTurns: (
    conversationId: string
  ) => Promise<import('@offgrid/application').ChatTurn[]>
  writeChatSessionTurns: (
    conversationId: string,
    turns: readonly import('@offgrid/application').ChatTurn[]
  ) => Promise<void>
  addRagMessage: (
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    context?: unknown
  ) => Promise<{ id: number; uuid: string }>
  truncateRagMessages: (
    conversationId: string,
    anchor: { messageId: string; keepAnchor: boolean }
  ) => Promise<number>
  updateRagConversationTitle: (id: string, title: string) => Promise<RagConversation>
  deleteRagConversation: (id: string) => Promise<void>

  // App Settings
  getSettings: () => Promise<AppSettings>
  saveSetting: (key: string, value: unknown) => Promise<void>
  getComputerUseSettings: () => Promise<
    import('../../shared/computer-use-settings').ComputerUseSettingsPortResult
  >
  patchComputerUseSettings: (
    patch: import('../../shared/computer-use-settings').ComputerUseSettingsPatch
  ) => Promise<import('../../shared/computer-use-settings').ComputerUseSettingsPortResult>
  consoleEnroll: (
    url: string,
    token: string
  ) => Promise<{ enrolled: boolean; deviceId?: string; error?: string }>
  consoleStatus: () => Promise<{
    enrolled: boolean
    url: string
    deviceId: string
    lastSync: number
    policyVersion: number | null
    killed: boolean
    queued: number
  }>
  consoleSyncNow: () => Promise<{
    enrolled: boolean
    policyVersion: number | null
    lastSync: number
  }>
  consoleDisconnect: () => Promise<boolean>
  reprocessAllSessions: (clean?: boolean) => Promise<{ processed: number; total: number }>

  getEntities: (appName?: string) => Promise<unknown[]>
  getEntityDetails: (entityId: number, appName?: string) => Promise<unknown>
  deleteEntity: (entityId: number) => Promise<boolean>
  deleteMemory: (memoryId: number) => Promise<boolean>

  // Artifacts library
  saveArtifact: (a: {
    kind: ArtifactKind
    code: string
    title?: string
    conversationId?: string
    projectId?: string | null
  }) => Promise<{
    id: string
    kind: ArtifactKind
    code: string
    title: string
    created: number
  }>
  listArtifacts: (scope?: { conversationId?: string; projectId?: string | null }) => Promise<
    {
      id: string
      kind: ArtifactKind
      code: string
      title: string
      created: number
      conversationId?: string
      projectId?: string | null
    }[]
  >
  deleteArtifact: (id: string) => Promise<boolean>
  processFile: (
    bytes: ArrayBuffer,
    name: string
  ) => Promise<{
    name: string
    kind: 'text' | 'pdf' | 'docx' | 'image' | 'audio' | 'video'
    text: string
    path?: string
  }>

  // Skills
  listSkills: () => Promise<{ name: string; description: string }[]>
  getSkill: (name: string) => Promise<{
    name: string
    description: string
    instructions: string
    trigger?:
      | { kind: 'schedule'; at: string }
      | { kind: 'keyword'; keywords: string[] }
      | { kind: 'event'; on: 'calendar' | 'approval' }
    action?: string
    connectors?: boolean
  } | null>
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
  }) => Promise<{ name: string; description: string; instructions: string }>
  deleteSkill: (name: string) => Promise<boolean>
  skillsDir: () => Promise<string>

  // User Profile
  getUserProfile: () => Promise<UserProfile | null>
  saveUserProfile: (profile: UserProfile) => Promise<boolean>

  // Events
  onNewAction: (
    callback: (data: {
      actionId: number
      text: string
      due: string | null
      entityName: string | null
      sourceApp: string
    }) => void
  ) => () => void
  onReprocessProgress: (callback: (data: ReprocessProgress) => void) => () => void
  onUpdateDownloaded: (
    callback: (data: import('../../shared/ipc-contracts').UpdateDownloadedContract) => void
  ) => () => void
  onSetupProgress: (
    callback: (data: import('../../shared/ipc-contracts').SetupProgressContract) => void
  ) => () => void
  getStagedUpdateVersion: () => Promise<string | null>
  installUpdate: () => Promise<void>

  // Permission APIs
  getPermissionStatus: () => Promise<OffGridPermissionStatus>
  requestAccessibilityPermission: () => Promise<boolean>
  requestScreenRecordingPermission: () => Promise<boolean>
  openAccessibilitySettings: () => Promise<boolean>
  openScreenRecordingSettings: () => Promise<boolean>
  relaunchForPermissions: () => Promise<boolean>
  openMicrophoneSettings: () => Promise<boolean>
  openLocalNetworkSettings: () => Promise<boolean>
}

type IElectronAPI = Omit<import('../../preload').OffGridAPI, keyof RendererAPIOverrides> &
  RendererAPIOverrides

interface Window {
  api: IElectronAPI
}
