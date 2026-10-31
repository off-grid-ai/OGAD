// Applies the shared chat fallback policy (@offgrid/models nextChatFallbackStep): a request that
// does not fit or was refused fails once; a server that could not answer is retried once on the
// same model. It never moves to another model: only the person changes the model, so a failed
// turn fails as the model they picked instead of switching the whole app to one nobody chose.
// GPU faults restart the same model once, then run it on its CPU engine.

import { nextChatFallbackStep, type ChatFailureKind } from '@offgrid/models'
import { demoteBackend } from './backend-facts'
import { ModelServerError } from './llm/http-post'

let deviceFallbackNotified = false

function failureKind(error: unknown): ChatFailureKind {
  if (error instanceof ModelServerError) return error.kind
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  return 'unknown'
}

/** Retry a failed model round without re-running any tool call that already started. */
export async function runChatWithFallback<T>(
  /** `documentScale` < 1 on a retry after the prompt did not fit: send less document text. */
  run: (attempt: { documentScale?: number }) => Promise<T>,
  options: {
    signal?: AbortSignal
    canRetry?: () => boolean
    onDeviceFallback?: (message: string) => void
    onRestarting?: (restarting: boolean) => void
    /** Both arguments are display names, never model ids. */
    onModelChanged?: (failed: string, next: string) => void
  } = {}
): Promise<{ result: T; modelName?: string }> {
  let failures = 0
  let deviceFailures = 0
  let deviceRecovery = false
  let documentScale: number | undefined
  for (;;) {
    try {
      return { result: await run(documentScale === undefined ? {} : { documentScale }) }
    } catch (error) {
      if (options.signal?.aborted || options.canRetry?.() === false) throw error
      failures++
      const { llm } = await import('./llm')
      const reportedKind = failureKind(error)
      const kind =
        reportedKind === 'device_fault' ||
        ((reportedKind === 'unavailable' || reportedKind === 'unknown') &&
          (llm.hasDeviceFault() || deviceRecovery))
          ? 'device_fault'
          : reportedKind
      if (kind === 'device_fault') {
        deviceRecovery = true
        deviceFailures++
      }
      const step = nextChatFallbackStep({
        kind,
        failures: kind === 'device_fault' ? deviceFailures : failures,
        localAlternatives: []
      })
      if (step.action === 'restart-same' || step.action === 'restart-cpu') {
        if (step.action === 'restart-cpu') {
          const backend = llm.gpuBackend()
          if (backend) demoteBackend('llm', backend)
          // A second GPU must not replace the failed GPU during CPU recovery.
          for (const gpu of ['cuda', 'vulkan', 'metal'] as const) demoteBackend('llm', gpu)
        }
        options.onRestarting?.(true)
        try {
          await llm.restartSameModel()
        } finally {
          options.onRestarting?.(false)
        }
        if (options.signal?.aborted) throw error
        if (step.action === 'restart-cpu' && !deviceFallbackNotified && options.onDeviceFallback) {
          deviceFallbackNotified = true
          options.onDeviceFallback(
            'Chat moved to the CPU. The GPU stopped responding. Replies will be slower.'
          )
        }
        continue
      }
      if (step.action === 'retry-same') continue
      if (step.action === 'retry-smaller') {
        documentScale = step.scale
        continue
      }
      throw error
    }
  }
}
