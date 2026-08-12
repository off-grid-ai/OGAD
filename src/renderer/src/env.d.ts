/// <reference types="vite/client" />

type UserProfile = import('../../shared/ipc-contracts').UserProfileContract

interface ProLicenseInfo {
  isPro: boolean
  tier: 'lifetime' | 'monthly' | null
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
  proInvoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
  proOn?: (channel: string, cb: (...a: unknown[]) => void) => () => void
  proOff?: (channel: string) => void

  // Keygen licensing (activation + status for the upgrade/settings UI)
  license?: {
    status: () => Promise<ProLicenseInfo>
    activate: (key: string) => Promise<import('@offgrid/sync').PersonalMeshActivationResult>
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
      type: 'content' | 'reasoning' | 'step'
      text?: string
      step?: unknown
    }) => void
  ) => () => void
  cancelRag: (streamId: string) => void

  // RAG Conversations
  createRagConversation: (id: string, title?: string, projectId?: string | null) => Promise<string>
  getRagConversations: (projectId?: string | null) => Promise<RagConversation[]>
  onRagConversationsChanged?: (
    callback: (data: { conversationId: string; projectId: string | null }) => void
  ) => () => void
  setRagConversationProject: (id: string, projectId: string | null) => Promise<boolean>
  getRagConversation: (id: string) => Promise<RagConversation | null>
  getRagMessages: (conversationId: string) => Promise<RagMessage[]>
  addRagMessage: (
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    context?: unknown
  ) => Promise<{ id: number; uuid: string }>
  truncateRagMessages: (conversationId: string, keepCount: number) => Promise<number>
  updateRagConversationTitle: (id: string, title: string) => Promise<RagConversation>
  deleteRagConversation: (id: string) => Promise<void>

  // App Settings
  getSettings: () => Promise<AppSettings>
  saveSetting: (key: string, value: unknown) => Promise<void>
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
  onNewApproval: (
    callback: (data: {
      approvalId: number
      title: string
      detail: string
      entityName: string | null
    }) => void
  ) => () => void
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
  onUpdateDownloaded: (callback: (data: { version: string }) => void) => () => void
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
