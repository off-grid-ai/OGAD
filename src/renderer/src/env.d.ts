/// <reference types="vite/client" />

interface UserProfile {
  role?: string;
  companySize?: string;
  aiUsageFrequency?: string;
  primaryTools?: string[];
  painPoints?: string[];
  primaryUseCase?: string;
  privacyConcern?: string;
  expectedBenefit?: string;
  referralSource?: string;
  completedAt?: string;
}

interface PermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
  allGranted: boolean;
}

interface DashboardStats {
  totalChats: number;
  totalMemories: number;
  totalEntities: number;
  totalRelationships: number;
  totalMessages: number;
  totalFacts: number;
  todayChats: number;
  todayMemories: number;
  todayEntities: number;
  recentChats: Array<{
    session_id: string;
    title: string | null;
    app_name: string;
    memory_count: number;
    entity_count: number;
    updated_at: string;
  }>;
  recentMemories: Array<{
    id: number;
    content: string;
    source_app: string;
    created_at: string;
  }>;
  topEntities: Array<{
    id: number;
    name: string;
    type: string;
    fact_count: number;
    session_count: number;
  }>;
  entityTypeCounts: Array<{
    type: string;
    count: number;
  }>;
  appDistribution: Array<{
    app_name: string;
    chat_count: number;
    memory_count: number;
  }>;
  activityByDay: Array<{
    date: string;
    chats: number;
    memories: number;
  }>;
}

interface RagConversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

interface RagMessage {
  id: number;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  context: string | null;
  created_at: string;
}

interface ReprocessProgress {
  phase: string;
  processed: number;
  total: number;
}

interface AppSettings {
  memoryStrictness?: 'lenient' | 'balanced' | 'strict';
  entityStrictness?: 'lenient' | 'balanced' | 'strict';
  [key: string]: any;
}

interface IElectronAPI {
  getMemories: (limit: number, appName?: string) => Promise<any[]>
  addMemory: (content: string, source?: string) => Promise<{ id: number }>
  searchMemories: (query: string) => Promise<any[]>
  getStats: () => Promise<any>
  getDashboardStats: () => Promise<DashboardStats>
  extractMemory: (text: string) => Promise<{ summary: string; entities: string[]; topic: string }>

  getChatSessions: (appName?: string) => Promise<any[]>
  getMemoriesForSession: (sessionId: string) => Promise<any[]>
  getEntitiesForSession: (sessionId: string) => Promise<any[]>
  getMemoryRecordsForSession: (sessionId: string) => Promise<any[]>
  summarizeSession: (sessionId: string) => Promise<string>
  deleteSession: (sessionId: string) => Promise<boolean>

  // Master Memory
  getMasterMemory: () => Promise<{ content: string | null; updated_at: string | null }>
  regenerateMasterMemory: () => Promise<string | null>

  // RAG Chat
  ragChat: (query: string, appName?: string, conversationHistory?: { role: string; content: string }[], projectId?: string | null, conversationId?: string, noMemory?: boolean, streamId?: string, thinking?: boolean) => Promise<{ answer: string; context: any }>
  onRagStream: (callback: (data: { streamId: string; type: 'content' | 'reasoning' | 'step'; text?: string; step?: any }) => void) => () => void
  cancelRag: (streamId: string) => void

  // RAG Conversations
  createRagConversation: (id: string, title?: string, projectId?: string | null) => Promise<string>
  getRagConversations: (projectId?: string | null) => Promise<RagConversation[]>
  setRagConversationProject: (id: string, projectId: string | null) => Promise<boolean>
  getRagConversation: (id: string) => Promise<RagConversation | null>
  getRagMessages: (conversationId: string) => Promise<RagMessage[]>
  addRagMessage: (conversationId: string, role: 'user' | 'assistant', content: string, context?: any) => Promise<number>
  updateRagConversationTitle: (id: string, title: string) => Promise<void>
  deleteRagConversation: (id: string) => Promise<void>

  // App Settings
  getSettings: () => Promise<AppSettings>
  saveSetting: (key: string, value: any) => Promise<void>
  reprocessAllSessions: (clean?: boolean) => Promise<{ processed: number; total: number }>

  getEntities: (appName?: string) => Promise<any[]>
  getEntityDetails: (entityId: number, appName?: string) => Promise<any>
  getEntityGraph: (appName?: string, focusEntityId?: number, edgeLimit?: number) => Promise<{ nodes: any[]; edges: any[] }>
  rebuildEntityGraph: () => Promise<boolean>
  deleteEntity: (entityId: number) => Promise<boolean>
  deleteMemory: (memoryId: number) => Promise<boolean>

  // Artifacts library
  saveArtifact: (a: { kind: 'html' | 'svg' | 'mermaid' | 'react'; code: string; title?: string }) => Promise<{ id: string; kind: 'html' | 'svg' | 'mermaid' | 'react'; code: string; title: string; created: number }>
  listArtifacts: () => Promise<{ id: string; kind: 'html' | 'svg' | 'mermaid' | 'react'; code: string; title: string; created: number }[]>
  deleteArtifact: (id: string) => Promise<boolean>
  processFile: (bytes: ArrayBuffer, name: string) => Promise<{ name: string; kind: 'text' | 'pdf' | 'docx' | 'image' | 'audio' | 'video'; text: string }>

  // Skills
  listSkills: () => Promise<{ name: string; description: string }[]>
  getSkill: (name: string) => Promise<{ name: string; description: string; instructions: string } | null>
  saveSkill: (input: { name: string; description: string; instructions: string; originalName?: string }) => Promise<{ name: string; description: string; instructions: string }>
  deleteSkill: (name: string) => Promise<boolean>
  skillsDir: () => Promise<string>

  // User Profile
  getUserProfile: () => Promise<UserProfile | null>
  saveUserProfile: (profile: UserProfile) => Promise<boolean>

  // Events
  onWatcherData: (callback: (data: any) => void) => () => void
  onPermissionDenied: (callback: () => void) => () => void
  onNewMessages: (callback: (data: any) => void) => () => void
  onNewMemory: (callback: (data: any) => void) => () => void
  onNewEntity: (callback: (data: any) => void) => () => void
  onSummaryGenerated: (callback: (data: any) => void) => () => void
  onReprocessProgress: (callback: (data: ReprocessProgress) => void) => () => void

  // Permission APIs
  getPermissionStatus: () => Promise<PermissionStatus>
  requestAccessibilityPermission: () => Promise<boolean>
  requestScreenRecordingPermission: () => Promise<boolean>
  openAccessibilitySettings: () => Promise<boolean>
  openScreenRecordingSettings: () => Promise<boolean>
}

interface Window {
  api: IElectronAPI
}
