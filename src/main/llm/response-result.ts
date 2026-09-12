import type { ResponseCutoffContract } from '../../shared/ipc-contracts'
import type { GenerationMetrics } from '../../shared/generation-metrics'

export interface ResponseGenerationResult {
  answer: string
  cutoff?: ResponseCutoffContract
  /** How the generation performed, when it was measured. Absent for an unmeasured path. */
  metrics?: GenerationMetrics
}

/** Normalize engine-specific completion metadata at the main-process boundary. */
export function toResponseGenerationResult(result: {
  content: string
  finishReason: string | null
  maxTokens: number
  metrics?: GenerationMetrics
  modelName?: string
}): ResponseGenerationResult {
  const metrics = result.modelName
    ? { ...result.metrics, modelName: result.modelName }
    : result.metrics
  return {
    answer: result.content.trim(),
    ...(metrics ? { metrics } : {}),
    ...(result.finishReason === 'length'
      ? { cutoff: { reason: 'max_tokens' as const, maxTokens: result.maxTokens } }
      : {})
  }
}
