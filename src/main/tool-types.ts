import type { SearchResult } from '../shared/search-contract'
import type { ProposalDeferredImageRequest } from './proposal-deck/tool'

export interface ToolContext {
  conversationId?: string
  taskLaunch?: { launchId: string; requestingDeviceId: string }
  userQuery?: string
  history?: ToolConversationTurn[]
  onActivity?: (activity: ToolActivity) => void
  projectId?: string
}

export interface ToolConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export type ToolCallStatus = 'completed' | 'failed' | 'pending'

export type ToolActivity = { kind: 'planning'; label: 'Planning next action…' }

export interface ToolResult {
  text: string
  status?: ToolCallStatus
  authoritative?: boolean
  sources?: SearchResult[]
  imageRequest?: { prompt: string }
  imageRequests?: ProposalDeferredImageRequest[]
}
