export const IMAGE_CANCELLED_MESSAGE = 'Image generation cancelled.'

type GenerationState = 'idle' | 'running' | 'cancelled'

/**
 * Owns one image generation from admission through native-runtime teardown.
 * Cancellation applies before, during, and after native process startup, so a
 * Stop received during memory reclamation cannot be lost between layers.
 */
export class ImageGenerationLifecycle {
  private state: GenerationState = 'idle'
  private releaseAbortListener?: () => void

  isRunning(): boolean {
    return this.state !== 'idle'
  }

  isCancelled(): boolean {
    return this.state === 'cancelled'
  }

  start(signal?: AbortSignal, cancelRuntime?: () => void): void {
    if (signal?.aborted) throw new Error(IMAGE_CANCELLED_MESSAGE)
    if (this.isRunning()) {
      throw new Error('An image is already generating — please wait for it to finish.')
    }
    this.state = 'running'
    if (signal) {
      const abort = (): void => {
        this.cancel()
        cancelRuntime?.()
      }
      signal.addEventListener('abort', abort, { once: true })
      this.releaseAbortListener = () => signal.removeEventListener('abort', abort)
    }
  }

  cancel(): boolean {
    if (!this.isRunning()) return false
    this.state = 'cancelled'
    return true
  }

  finish(): void {
    this.releaseAbortListener?.()
    this.releaseAbortListener = undefined
    this.state = 'idle'
  }

  throwIfCancelled(): void {
    if (this.isCancelled()) throw new Error(IMAGE_CANCELLED_MESSAGE)
  }

  async waitForMemoryReclaim(reclaimMs = 2500, cancellationPollMs = 50): Promise<void> {
    for (let elapsed = 0; elapsed < reclaimMs; elapsed += cancellationPollMs) {
      this.throwIfCancelled()
      await new Promise((resolve) => setTimeout(resolve, cancellationPollMs))
    }
    this.throwIfCancelled()
  }
}
