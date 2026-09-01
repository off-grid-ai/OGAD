import { randomUUID } from 'node:crypto'
import {
  canAcknowledgeImageConversation,
  isImageApplicationInFlight,
  type ImageApplicationSnapshot
} from '@offgrid/models'
import { generatedImageMetadataJson } from '@offgrid/sync'
import type { ChatHome } from '@offgrid/sync'
import {
  type ImageGenerationJobContract,
  type ImageGenerationRequestContract,
  type ImageGenerationResultContract
} from '../../shared/image-generation-contract'
import {
  preserveGeneratedImageSource,
  saveGeneratedImageScope,
  type ImageGenOutput
} from '../imagegen'
import { desktopImageApplication, type DesktopImageApplicationRequest } from './application-service'
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

export interface ImageGenerationPersistencePort {
  /** The scope, not the whole request: the sidecar owns these facts and nothing else here. */
  saveScope(path: string, facts: GeneratedImageSidecar): void
  /** Offer the finished image to the mesh, described from the sidecar. */
  share(path: string): boolean
  /** Record the message the image hangs under, and offer it again with that link. */
  noteMessage(path: string, shownIn: ChatHome): boolean
  /** Keep the app's own copy of the image this generation was based on. */
  preserveSource(syncId: string, sourcePath: string): string | null
}

export interface DesktopImageApplicationPort {
  status(): ImageApplicationSnapshot<ImageGenOutput>
  onChange(listener: (snapshot: ImageApplicationSnapshot<ImageGenOutput>) => void): () => void
  isRunning(): boolean
  start(request: DesktopImageApplicationRequest): Promise<ImageGenOutput>
  cancel(): Promise<boolean>
}

const nativeImageGenerationPersistence: ImageGenerationPersistencePort = {
  saveScope: (path, facts) => saveGeneratedImageScope(path, facts),
  share: (path) => shareGeneratedImage(path),
  noteMessage: (path, shownIn) => noteGeneratedImageMessage({ ...shownIn, imagePath: path }),
  preserveSource: (syncId, sourcePath) => preserveGeneratedImageSource(syncId, sourcePath)
}

function jobPhase(
  snapshot: ImageApplicationSnapshot<ImageGenOutput>
): ImageGenerationJobContract['phase'] {
  if (isImageApplicationInFlight(snapshot.phase)) return 'running'
  if (snapshot.phase === 'done') return 'succeeded'
  if (snapshot.phase === 'error') return 'failed'
  if (snapshot.phase === 'cancelled') return 'cancelled'
  return 'idle'
}

function jobStage(
  snapshot: ImageApplicationSnapshot<ImageGenOutput>
): ImageGenerationJobContract['stage'] {
  if (snapshot.phase === 'enhancing') return 'enhancing'
  if (snapshot.phase === 'loading') return 'preparing'
  if (snapshot.phase === 'generating' && snapshot.progress?.stage === 'decoding') return 'decoding'
  if (snapshot.phase === 'generating' || snapshot.phase === 'saving') return 'generating'
  return null
}

function projectSnapshot(
  snapshot: ImageApplicationSnapshot<ImageGenOutput>
): ImageGenerationJobContract {
  return {
    id: snapshot.requestId,
    phase: jobPhase(snapshot),
    conversationId: snapshot.conversationId,
    projectId: snapshot.projectId,
    stage: jobStage(snapshot),
    enhancedPrompt: snapshot.prompt ?? '',
    progress: snapshot.progress
      ? {
          step: snapshot.progress.step,
          total: snapshot.progress.totalSteps,
          secPerStep: snapshot.progress.secondsPerStep ?? 0,
          preview: snapshot.progress.previewUri,
          phase: snapshot.progress.stage
        }
      : null,
    outputPath: snapshot.result?.path ?? null,
    error: snapshot.error,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt
  }
}

/** Main-process owner for renderer-started image jobs. The native runtime remains
 * in imagegen.ts; this service adds durable identity/observation across renderer
 * navigation without introducing a second generation state machine. */
export class ImageGenerationJobService {
  private readonly conversationListeners = new Set<ConversationListener>()

  constructor(
    private readonly persistence: ImageGenerationPersistencePort = nativeImageGenerationPersistence,
    private readonly application: DesktopImageApplicationPort = desktopImageApplication
  ) {}

  status(): ImageGenerationJobContract {
    return projectSnapshot(this.application.status())
  }

  onChange(listener: JobListener): () => void {
    return this.application.onChange((snapshot) => {
      try {
        listener(projectSnapshot(snapshot))
      } catch (error) {
        console.error(
          `[image-job] ${JSON.stringify({
            event: 'job-observer-failed',
            error: error instanceof Error ? error.message : String(error)
          })}`
        )
      }
    })
  }

  onConversationUpdated(listener: ConversationListener): () => void {
    this.conversationListeners.add(listener)
    return () => this.conversationListeners.delete(listener)
  }

  /** Reject before a caller reserves related state for a job this service cannot accept. */
  assertCanStart(): void {
    if (this.application.isRunning()) {
      throw new Error('An image is already generating — please wait for it to finish.')
    }
  }

  async start(request: ImageGenerationJobRequest): Promise<ImageGenerationResult> {
    this.assertCanStart()
    const id = randomUUID()
    const output = await this.application.start({ ...request, requestId: id })
    const startedAt = this.application.status().startedAt ?? Date.now()
    this.finalize({ id, request, output, startedAt })
    return { ...output, syncId: id }
  }

  cancel(): boolean {
    const running = this.application.isRunning()
    if (running) void this.application.cancel()
    return running
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
    const snapshot = this.status()
    if (!canAcknowledgeImageConversation(snapshot, conversationId)) return false
    if (messageId && snapshot.outputPath) {
      this.persistence.noteMessage(snapshot.outputPath, { conversationId, messageId })
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
    const keptSource = request.initImage
      ? this.persistence.preserveSource(id, request.initImage)
      : null
    if (output.path) {
      try {
        this.persistence.saveScope(output.path, {
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
      this.persistence.share(output.path)
    }
  }
}

export const imageGenerationJobs = new ImageGenerationJobService()
