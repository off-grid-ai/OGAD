/** Await the usable window, then start cleanup on a later event-loop turn.
 * Cleanup completion must never delay the rest of startup. */
export async function createWindowAndScheduleModelStorageCleanup(
  createWindow: () => Promise<void>,
  cleanup: () => Promise<void>
): Promise<void> {
  await createWindow()
  setImmediate(() => {
    void Promise.resolve()
      .then(cleanup)
      .catch((error) => console.error('[model-storage] Background cleanup failed:', error))
  })
}
