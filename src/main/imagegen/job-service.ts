import { randomUUID } from 'node:crypto'
import { generatedImageMetadataJson } from '@offgrid/sync'
import type { ChatHome } from '@offgrid/sync'
import {
  type ImageGenerationJobContract,
  type ImageGenerationProgressContract,
  type ImageGenerationRequestContract
} from '../../shared/image-generation-contract'
import {
  cancelImageGen,
  generateImage,
  preserveGeneratedImageSource,
  saveGeneratedImageScope,
  type ImageGenOutput
} from '../imagegen'
import type { GeneratedImageSidecar } from './gallery-sidecar'
import { noteGeneratedImageMessage, shareGeneratedImage } from './generated-image-share'

export type ImageGenerationJobRequest = ImageGenerationRequestContract & {
  conversationId?: string
  projectId?: string | null
}

type JobListener = (snapshot: ImageGenerationJobContract) => void
type ConversationListener = (conversationId: string) => void

/** A finished image, and the name it answers to on every device. */
export type ImageGenerationResult = ImageGenOutput & { syncId: string }

export interface ImageGenerationRuntime {
  generate(
    request: ImageGenerationJobRequest,
    onProgress: (progress: ImageGenerationProgressContract) => void
  ): Promise<ImageGenOutput>
  cancel(): boolean
  /** The scope, not the whole request: the sidecar owns these facts and nothing else here. */
  saveScope(path: string, facts: GeneratedImageSidecar): void
  /** Offer the finished image to the mesh, described from the sidecar. */
  share(path: string): boolean
  /** Record the message the image hangs under, and offer it again with that link. */
  noteMessage(path: string, shownIn: ChatHome): boolean
  /** Keep the app's own copy of the image this generation was based on. */
  preserveSource(syncId: string, sourcePath: string): string | null
}

const nativeImageGenerationRuntime: ImageGenerationRuntime = {
  generate: (request, onProgress) => generateImage(request, onProgress),
  cancel: () => cancelImageGen(),
  saveScope: (path, facts) => saveGeneratedImageScope(path, facts),
  share: (path) => shareGeneratedImage(path),
  noteMessage: (path, shownIn) => noteGeneratedImageMessage({ ...shownIn, imagePath: path }),
  preserveSource: (syncId, sourcePath) => preserveGeneratedImageSource(syncId, sourcePath)
}

const idleSnapshot = (): ImageGenerationJobContract => ({
  id: null,
  phase: 'idle',
  conversationId: null,
  projectId: null,
  progress: null,
  outputPath: null,
  error: null,
  startedAt: null,
  finishedAt: null
})

/** Main-process owner for renderer-started image jobs. The native runtime remains
 * in imagegen.ts; this service adds durable identity/observation across renderer
 * navigation without introducing a second generation state machine. */
export class ImageGenerationJobService {
  private snapshot: ImageGenerationJobContract = idleSnapshot()
  private active = false
  private readonly listeners = new Set<JobListener>()
  private readonly conversationListeners = new Set<ConversationListener>()

  constructor(private readonly runtime: ImageGenerationRuntime = nativeImageGenerationRuntime) {}

  status(): ImageGenerationJobContract {
    return { ...this.snapshot, progress: this.snapshot.progress && { ...this.snapshot.progress } }
  }

  onChange(listener: JobListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onConversationUpdated(listener: ConversationListener): () => void {
    this.conversationListeners.add(listener)
    return () => this.conversationListeners.delete(listener)
  }

  async start(request: ImageGenerationJobRequest): Promise<ImageGenerationResult> {
    if (this.active) {
      throw new Error('An image is already generating - please wait for it to finish.')
    }
    this.active = true
    const id = randomUUID()
    this.snapshot = {
      id,
      phase: 'running',
      conversationId: request.conversationId ?? null,
      projectId: request.projectId ?? null,
      progress: null,
      outputPath: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null
    }
    this.publish()
    console.log(
      `[image-job] ${JSON.stringify({
        event: 'started',
        id,
        conversationId: this.snapshot.conversationId,
        projectId: this.snapshot.projectId
      })}`
    )

    try {
      const result = await this.runtime.generate(request, (progress) =>
        this.updateProgress(id, progress)
      )
      // Always, not only inside a chat. The syncId is what this image is called on the mesh, so an
      // image made from the tool loop or the gateway needs one exactly as much as one made in a
      // conversation; without it the gallery and the file record name the same picture differently.
      // Kept BEFORE the facts are written, so the record names a copy this app owns rather than a
      // path on the user's disk that can be moved the moment the generation ends.
      const keptSource = request.initImage
        ? this.runtime.preserveSource(id, request.initImage)
        : null
      if (result.path) {
        try {
          this.runtime.saveScope(result.path, {
            syncId: id,
            ...(keptSource ? { initImage: keptSource } : {}),
            ...(request.conversationId ? { conversationId: request.conversationId } : {}),
            projectId: request.projectId ?? null,
            createdAt: new Date(this.snapshot.startedAt ?? Date.now()).toISOString(),
            ...(request.width ? { width: request.width } : {}),
            ...(request.height ? { height: request.height } : {}),
            // The shared names, so the phone reads what this Mac wrote. It wrote `model` and the
            // phone reads `modelId`, so every image made here arrived with its model reading
            // "synced" and its steps reading 0.
            metadataJson: generatedImageMetadataJson({
              prompt: request.prompt,
              ...(request.negativePrompt === undefined
                ? {}
                : { negativePrompt: request.negativePrompt }),
              ...(request.steps === undefined ? {} : { steps: request.steps }),
              seed: result.seed,
              modelId: result.model
            })
          })
        } catch (scopeError) {
          console.error(
            `[image-job] ${JSON.stringify({
              event: 'save-scope-failed',
              id,
              error: scopeError instanceof Error ? scopeError.message : String(scopeError)
            })}`
          )
        }
      }
      this.snapshot = {
        ...this.snapshot,
        phase: 'succeeded',
        outputPath: result.path ?? null,
        progress: null,
        finishedAt: Date.now()
      }
      // Described from the sidecar just written, by the one function the chat link also calls, so a
      // picture offered when it is made and the same picture offered once its message exists cannot
      // be described two different ways.
      if (result.path) this.runtime.share(result.path)
      this.publish()
      console.log(`[image-job] ${JSON.stringify({ event: 'succeeded', id, path: result.path })}`)
      return { ...result, syncId: id }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = this.snapshot.id === id && this.snapshot.phase === 'cancelled'
      this.snapshot = {
        ...this.snapshot,
        phase: cancelled ? 'cancelled' : 'failed',
        error: message,
        progress: null,
        finishedAt: Date.now()
      }
      this.publish()
      console.error(
        `[image-job] ${JSON.stringify({ event: this.snapshot.phase, id, error: message })}`
      )
      throw error
    } finally {
      this.active = false
    }
  }

  cancel(): boolean {
    if (this.snapshot.phase !== 'running') return false
    const cancelled = this.runtime.cancel()
    if (!cancelled) return false
    this.snapshot = {
      ...this.snapshot,
      phase: 'cancelled',
      progress: null,
      finishedAt: Date.now()
    }
    this.publish()
    return true
  }

  /**
   * Called only after the renderer has persisted the generated assistant message.
   * A remounted Chat observes this and refreshes the conversation from SQLite.
   *
   * This is also the first moment the message EXISTS, so it is the only moment the image can be told
   * which message it hangs under. The picture is offered again with that link, which is what lets a
   * phone move it out of the gallery and under the message instead of drawing a hole.
   */
  acknowledgeConversation(conversationId: string, messageId?: string): boolean {
    if (
      !conversationId ||
      this.snapshot.phase !== 'succeeded' ||
      this.snapshot.conversationId !== conversationId
    )
      return false
    if (messageId && this.snapshot.outputPath) {
      this.runtime.noteMessage(this.snapshot.outputPath, { conversationId, messageId })
    }
    for (const listener of this.conversationListeners) {
      try {
        listener(conversationId)
      } catch (error) {
        console.error(
          `[image-job] ${JSON.stringify({
            event: 'conversation-observer-failed',
            conversationId,
            error: error instanceof Error ? error.message : String(error)
          })}`
        )
      }
    }
    return true
  }

  private updateProgress(id: string, progress: ImageGenerationProgressContract): void {
    if (this.snapshot.id !== id || this.snapshot.phase !== 'running') return
    this.snapshot = { ...this.snapshot, progress: { ...progress } }
    this.publish()
  }

  private publish(): void {
    const snapshot = this.status()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        console.error(
          `[image-job] ${JSON.stringify({
            event: 'observer-failed',
            id: snapshot.id,
            error: error instanceof Error ? error.message : String(error)
          })}`
        )
      }
    }
  }
}

export const imageGenerationJobs = new ImageGenerationJobService()
