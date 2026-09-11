import {
  DEFAULT_CTX_SIZE,
  MAX_TOKENS_AUTO,
  REASONING_BUDGET_AUTO,
  reconcileBudgets
} from '@offgrid/application'
import type { EngineAccelerator } from '@offgrid/core/shared/engine-accelerator'

export const MAX_OUTPUT_AUTO = MAX_TOKENS_AUTO
export const MAX_OUTPUT_OPTIONS = [2048, 4096, 8192, 16384, 32768]

export type KvCacheType = 'f16' | 'q8_0' | 'q4_0'
export interface LlmSettings {
  temperature?: number
  ctxSize?: number
  topP?: number
  topK?: number
  minP?: number
  repeatPenalty?: number
  maxTokens?: number
  maxToolCalls?: number
  reasoningBudget?: number
  systemPrompt?: string
  kvCacheType?: KvCacheType
  flashAttn?: boolean
  gpuLayers?: number
  threads?: number
  batchSize?: number
  effectiveCtxSize?: number
  modelMaxCtx?: number | null
  gpuAccelerator?: EngineAccelerator | null
}

export function threadsLabel(threads: number): string {
  return threads === 0 ? 'auto' : String(threads)
}

export function thinkingCeiling(settings: LlmSettings): number {
  const maxOutput = settings.maxTokens ?? MAX_OUTPUT_AUTO
  const context = settings.ctxSize ?? DEFAULT_CTX_SIZE
  return maxOutput === MAX_OUTPUT_AUTO ? context : maxOutput
}

export function budgetChange(settings: LlmSettings, patch: LlmSettings): LlmSettings {
  const next = { ...settings, ...patch }
  const reconciled = reconcileBudgets({
    contextWindow: next.ctxSize ?? DEFAULT_CTX_SIZE,
    maxOutput: next.maxTokens ?? MAX_OUTPUT_AUTO,
    thinkingBudget: next.reasoningBudget ?? REASONING_BUDGET_AUTO
  })
  return {
    ...patch,
    ...(reconciled.maxOutput !== (next.maxTokens ?? MAX_OUTPUT_AUTO)
      ? { maxTokens: reconciled.maxOutput }
      : {}),
    ...(reconciled.thinkingBudget !== (next.reasoningBudget ?? REASONING_BUDGET_AUTO)
      ? { reasoningBudget: reconciled.thinkingBudget }
      : {})
  }
}
