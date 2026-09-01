import { randomUUID } from 'node:crypto'
import { canAcknowledgeImageConversation, ImageGenerationJobCoordinator } from '@offgrid/models'
import { generatedImageMetadataJson } from '@offgrid/sync'
import type { ChatHome } from '@offgrid/sync'
import {
  type ImageGenerationJobContract,
  type ImageGenerationPipelineUpdateContract,
  type ImageGenerationRequestContract,
  type ImageGenerationResultContract
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
  /** The durable assistant message this image will hang under. */
  messageId?: string
  projectId?: string | null
}

type JobListener = (snapshot: ImageGenerationJobContract) => void
type ConversationListener = (conversationId: string) => void

/** A finished image, and the name it answers to on every device. */
export type ImageGenerationResult = ImageGenerationResultContract

export interface ImageGenerationRuntime {
  generate(
    request: ImageGenerationJobRequest,
    onUpdate: (update: ImageGenerationPipelineUpdateContract) => void
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
  generate: (request, onUpdate) => generateImage(request, onUpdate),
  cancel: () => cancelImageGen(),
  saveScope: (path, facts) => saveGeneratedImageScope(path, facts),
  share: (path) => shareGeneratedImage(path),
  noteMessage: (path, shownIn) => noteGeneratedImageMessage({ ...shownIn, imagePath: path }),
  preserveSource: (syncId, sourcePath) => preserveGeneratedImageSource(syncId, sourcePath)
}

/** Main-process owner for renderer-started image jobs. The native runtime remains
 * in imagegen.ts; this service adds durable identity/observation across renderer
 * navigation without introducing a second generation state machine. */
export class ImageGenerationJobService {
  private readonly jobs: ImageGenerationJobCoordinator<ImageGenerationJobRequest, ImageGenOutput>
  private readonly conversationListeners = new Set<ConversationListener>()

  constructor(private readonly runtime: ImageGenerationRuntime = nativeImageGenerationRuntime) {
    this.jobs = new ImageGenerationJobCoordinator(runtime, {
      createId: randomUUID,
      outputPath: (output) => output.path,
      finalize: (context) => this.finalize(context)
    })
  }

  status(): ImageGenerationJobContract {
    return this.jobs.status()
  }

  onChange(listener: JobListener): () => void {
    return this.jobs.onChange(listener)
  }

  onConversationUpdated(listener: ConversationListener): () => void {
    this.conversationListeners.add(listener)
    return () => this.conversationListeners.delete(listener)
  }

  /** Reject before a caller reserves related state for a job this service cannot accept. */
  assertCanStart(): void {
    this.jobs.assertCanStart()
  }

  async start(request: ImageGenerationJobRequest): Promise<ImageGenerationResult> {
    return this.jobs.start(request)
  }

  cancel(): boolean {
    return this.jobs.cancel()
  }

  /**
   * Called only after the renderer has persisted the generated assistant message.
   * A remounted Chat observes this and refreshes the conversation from SQLite.
   *
   * The image was already offered with the stable message id reserved at the start of the turn.
   * `noteMessage` confirms the final persisted association. The generated-image owner treats this as
   * an idempotent acknowledgement, so it does not publish or transfer the same image a second time.
   */
  acknowledgeConversation(conversationId: string, messageId?: string): boolean {
    const snapshot = this.jobs.status()
    if (!canAcknowledgeImageConversation(snapshot, conversationId)) return false
    if (messageId && snapshot.outputPath) {
      this.runtime.noteMessage(snapshot.outputPath, { conversationId, messageId })
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

  private finalize(context: {
    id: string
    request: ImageGenerationJobRequest
    output: ImageGenOutput
    startedAt: number
  }): void {
    const { id, request, output, startedAt } = context
    const keptSource = request.initImage ? this.runtime.preserveSource(id, request.initImage) : null
    if (output.path) {
      try {
        this.runtime.saveScope(output.path, {
          syncId: id,
          ...(keptSource ? { initImage: keptSource } : {}),
          ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          ...(request.messageId ? { messageId: request.messageId } : {}),
          projectId: request.projectId ?? null,
          createdAt: new Date(startedAt).toISOString(),
          ...(request.width ? { width: request.width } : {}),
          ...(request.height ? { height: request.height } : {}),
          metadataJson: generatedImageMetadataJson({
            prompt: output.prompt,
            ...(request.negativePrompt === undefined
              ? {}
              : { negativePrompt: request.negativePrompt }),
            ...(request.steps === undefined ? {} : { steps: request.steps }),
            seed: output.seed,
            modelId: output.model
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
      this.runtime.share(output.path)
    }
  }
}

export const imageGenerationJobs = new ImageGenerationJobService()
