export interface RestoredModelSwapTiming {
  swapInMs: number
  runMs: number
  swapOutMs: number
}

interface RestoredModelSwapDeps<T> {
  swapIn: () => Promise<void>
  run: () => Promise<T>
  restore: () => Promise<void>
  now?: () => number
}

/**
 * Run a temporary model swap without allowing a partial swap-in to become durable.
 * The restore boundary runs after both swap and task failures.
 */
export async function runRestoredModelSwap<T>(
  deps: RestoredModelSwapDeps<T>
): Promise<{ result: T; timing: RestoredModelSwapTiming }> {
  const now = deps.now ?? Date.now
  let swapInMs = 0
  let runMs = 0
  let swapOutMs = 0
  let runStartedAt: number | null = null
  let result!: T
  let operationError: unknown
  let restoreError: unknown

  try {
    const swapStartedAt = now()
    await deps.swapIn()
    swapInMs = now() - swapStartedAt
    runStartedAt = now()
    result = await deps.run()
    runMs = now() - runStartedAt
  } catch (error) {
    operationError = error
    if (runStartedAt !== null) runMs = now() - runStartedAt
  } finally {
    const restoreStartedAt = now()
    try {
      await deps.restore()
    } catch (error) {
      restoreError = error
    }
    swapOutMs = now() - restoreStartedAt
  }

  if (restoreError) {
    throw new Error('The Computer Use model swap failed to restore the chat model.', {
      cause: operationError ?? restoreError
    })
  }
  if (operationError) throw operationError

  return { result, timing: { swapInMs, runMs, swapOutMs } }
}
