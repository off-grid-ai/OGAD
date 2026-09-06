export interface LlmSettingsUpdate {
  temperature?: number
  ctxSize?: number
  topP?: number
  topK?: number
  minP?: number
  repeatPenalty?: number
  maxTokens?: number
  maxToolCalls?: number
  reasoningBudget?: number
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  thinkingEnabled?: boolean
  systemPrompt?: string
  kvCacheType?: 'f16' | 'q8_0' | 'q4_0'
  flashAttn?: boolean
  gpuLayers?: number
  threads?: number
  batchSize?: number
  performanceMode?: 'conservative' | 'balanced' | 'extreme'
  imageParams?: Record<
    string,
    { steps?: number | null; size?: number | null; cfgScale?: number | null }
  >
  imgSeed?: string
  imgNegative?: string
  enhanceImagePrompts?: boolean
}
