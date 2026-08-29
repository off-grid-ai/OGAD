export interface BoundedOperation<T> {
  label: string
  timeoutMs: number
  signal?: AbortSignal
  run: (signal: AbortSignal) => Promise<T>
}

/** One timeout and cancellation policy for every Playwright external wait. */
export async function runBounded<T>(operation: BoundedOperation<T>): Promise<T> {
  operation.signal?.throwIfAborted()
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(operation.signal?.reason)
  operation.signal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${operation.label} timed out after ${operation.timeoutMs}ms.`)
          controller.abort(error)
          reject(error)
        }, operation.timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    operation.signal?.removeEventListener('abort', onAbort)
  }
}
