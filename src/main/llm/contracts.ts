import type {
  GenerationReasoning,
  LlamaKvCacheType,
  PerformanceMode,
  ReasoningEffort,
  ReasoningWireFragment
} from '@offgrid/models'

export type KvCacheType = LlamaKvCacheType
export type { PerformanceMode }

export interface LlmSettings {
  performanceMode?: PerformanceMode
  temperature?: number
  ctxSize?: number
  topP?: number
  topK?: number
  minP?: number
  repeatPenalty?: number
  maxTokens?: number
  maxToolCalls?: number
  reasoningBudget?: number
  reasoningEffort?: ReasoningEffort
  thinkingEnabled?: boolean
  systemPrompt?: string
  kvCacheType?: KvCacheType
  flashAttn?: boolean
  gpuLayers?: number
  threads?: number
  batchSize?: number
}

export interface LlmSettingsUpdateOptions {
  emitSync?: boolean
}

export interface LlmSettingsUpdateResult {
  launchChanged: boolean
}

export interface StreamChatOptions {
  temperature?: number
  topP?: number
  thinking?: boolean
  reasoning?: GenerationReasoning
  reasoningWire?: ReasoningWireFragment
  signal?: AbortSignal
  tools?: unknown[]
  toolChoice?: unknown
  maxTokens?: number
  responseFormat?: unknown
}
