// Applies the shared chat fallback policy (@offgrid/models nextChatFallbackStep): a request that
// does not fit or was refused fails once; a server that could not answer is retried on the same
// model, then on at most one other local model, with one notice. It no longer walks every
// installed model and remote server. GPU faults restart the same model, then use its CPU engine.

import { nextChatFallbackStep, type ChatFailureKind } from '@offgrid/models'
import { demoteBackend } from './backend-facts'
import { ModelServerError } from './llm/http-post'
import { parseRemoteVisionModelId } from '../shared/remote-vision-server'

let deviceFallbackNotified = false

function failureKind(error: unknown): ChatFailureKind {
  if (error instanceof ModelServerError) return error.kind
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  return 'unknown'
}

async function localAlternatives(): Promise<string[]> {
  const models = await import('./models-manager')
  const selected = models.getActiveModel()
  return (await models.getStorageInfo()).models
    .filter((model) => (model.kind === 'text' || model.kind === 'vision') && model.id !== selected)
    .map((model) => model.id)
    .filter((id) => !parseRemoteVisionModelId(id))
}

async function selectedName(): Promise<string> {
  const models = await import('./models-manager')
  const { getRemoteVisionServerSettings } = await import('./vision/remote-vision-server')
  const remote = getRemoteVisionServerSettings()
  const selectedRemote = remote.servers.find((server) => server.id === remote.activeServerId)
  return selectedRemote?.model ?? models.getActiveModel() ?? 'Selected model'
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
    onModelChanged?: (failed: string, next: string) => void
  } = {}
): Promise<{ result: T; modelName?: string }> {
  let failures = 0
  let deviceFailures = 0
  let deviceRecovery = false
  let modelName: string | undefined
  let documentScale: number | undefined
  for (;;) {
    try {
      const result = await run(documentScale === undefined ? {} : { documentScale })
      return modelName ? { result, modelName } : { result }
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
        localAlternatives:
          failures === 2 && kind !== 'overflow' && !deviceRecovery ? await localAlternatives() : []
      })
      if (step.action === 'fail') throw error
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
      const models = await import('./models-manager')
      const failed = await selectedName()
      let activated = false
      try {
        activated = (await models.activateModel(step.to, 'text')).success
      } catch {
        activated = false
      }
      if (!activated || options.signal?.aborted) throw error
      options.onModelChanged?.(failed, step.to)
      modelName = step.to
    }
  }
}
