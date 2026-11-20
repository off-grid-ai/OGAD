import type { MutexInterface } from 'async-mutex'

/**
 * Run `fn` holding `mutex`, but give up the wait when `signal` aborts. Found live: Stop on a Web
 * Use task did nothing while its model call waited for the model behind another request, because
 * the wait for the lock did not listen to the task's signal.
 */
export async function runExclusiveAbortable<T>(
  mutex: MutexInterface,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return mutex.runExclusive(fn)
  signal.throwIfAborted()
  const acquired = mutex.acquire()
  let onAbort = (): void => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  let release: MutexInterface.Releaser
  try {
    release = await Promise.race([acquired, aborted])
  } catch (error) {
    // The lock is still coming: hand it straight back when it does.
    void acquired.then((late) => late())
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  try {
    return await fn()
  } finally {
    release()
  }
}
