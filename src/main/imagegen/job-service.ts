import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  canAcknowledgeImageConversation,
  isImageApplicationInFlight,
  type ImageApplicationSnapshot
} from '@offgrid/models'
import { createGeneratedImageRecord, type GeneratedImageRecord } from '@offgrid/application'
import type { ChatHome } from '@offgrid/sync'
import sharp from 'sharp'
import {
  type ImageGenerationJobContract,
  type ImageGenerationRequestContract,
  type ImageGenerationResultContract
} from '../../shared/image-generation-contract'
import { preserveGeneratedImageSource, type ImageGenOutput } from '../imagegen'
import {
  applicationMutationAdmission,
  type ApplicationMutationAdmission
} from '../mutation-admission'
import { desktopImageApplication, type DesktopImageApplicationRequest } from './application-service'
import {
  prepareDesktopGeneratedImageCreation,
  settleMissingDesktopGeneratedImageSource,
  settleDesktopGeneratedImageCreation
} from './creation-intent-runtime'
import { desktopGeneratedImageGallery } from './gallery-repository'
import { noteGeneratedImageMessage } from './generated-image-share'

export type ImageGenerationJobRequest = ImageGenerationRequestContract & {
  conversationId?: string
  /** The durable assistant message this image will hang under. */
  messageId?: string
  projectId?: string | null
}

type JobListener = (snapshot: ImageGenerationJobContract) => void
type ConversationListener = (conversationId: string) => void

export class ImageGenerationPersistenceError extends Error {
  readonly code = 'IMAGE_GENERATION_PERSISTENCE_FAILED'

  constructor(
    readonly syncId: string,
    readonly imagePath: string,
    options: { cause: unknown }
  ) {
    super('The generated image could not be committed to the image library.', options)
    this.name = 'ImageGenerationPersistenceError'
  }
}

export class ImageGenerationCancellationError extends Error {
  readonly code = 'IMAGE_GENERATION_CANCELLATION_FAILED'

  constructor(
    readonly requestId: string,
    readonly reason: 'refused' | 'failed',
    options: { cause: unknown }
  ) {
    super(
      reason === 'refused'
        ? 'The active image generation refused cancellation.'
        : 'The active image generation could not be cancelled.',
      options
    )
    this.name = 'ImageGenerationCancellationError'
  }
}

/** A finished image, and the name it answers to on every device. */
export type ImageGenerationResult = ImageGenerationResultContract

export interface ImageGenerationPersistencePort {
  /** Persist recovery evidence before the native owner can create bytes. */
  prepareCreation?(requestId: string, expectsSource: boolean): void
  /** Remove recovery evidence only after gallery admission or verified cleanup. */
  settleCreation?(requestId: string): void
  /** Prove that a requested retained source created no app-owned destination. */
  settleMissingSource?(requestId: string): void
  /** Commit metadata only after the native artifact exists. */
  create(record: GeneratedImageRecord): Promise<void>
  /** Record the durable message association and offer the image with that link. */
  noteMessage(path: string, shownIn: ChatHome): Promise<boolean>
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
  prepareCreation: prepareDesktopGeneratedImageCreation,
  settleCreation: settleDesktopGeneratedImageCreation,
  settleMissingSource: settleMissingDesktopGeneratedImageSource,
  create: async (record) => {
    const outcome = await desktopGeneratedImageGallery().create(record)
    if (!outcome.ok) throw new Error(outcome.failure.message)
  },
  noteMessage: (imagePath, shownIn) => noteGeneratedImageMessage({ ...shownIn, imagePath }),
  preserveSource: (syncId, sourcePath) => preserveGeneratedImageSource(syncId, sourcePath)
}

async function generatedImageRecord(input: {
  id: string
  request: ImageGenerationJobRequest
  output: ImageGenOutput
  startedAt: number
  steps: number | undefined
}): Promise<GeneratedImageRecord> {
  const dimensions = await sharp(input.output.path).metadata()
  if (!dimensions.width || !dimensions.height || !input.steps) {
    throw new Error('The generated image is missing canonical dimensions or step count.')
  }
  return createGeneratedImageRecord({
    id: input.id,
    ...(input.request.conversationId === undefined
      ? {}
      : { conversationId: input.request.conversationId }),
    prompt: input.output.prompt,
    ...(input.request.negativePrompt === undefined
      ? {}
      : { negativePrompt: input.request.negativePrompt }),
    width: dimensions.width,
    height: dimensions.height,
    steps: input.steps,
    seed: input.output.seed,
    modelId: input.output.model,
    createdAt: new Date(input.startedAt).toISOString(),
    local: { path: input.output.path, fileName: path.basename(input.output.path) }
  })
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
  private readonly jobListeners = new Set<JobListener>()
  private pendingCommitId: string | null = null
  private pendingTotalSteps: number | null = null
  private persistenceFailure: { requestId: string; error: string; finishedAt: number } | null = null
  private cancellationFailure: { requestId: string; error: string } | null = null

  constructor(
    private readonly persistence: ImageGenerationPersistencePort = nativeImageGenerationPersistence,
    private readonly application: DesktopImageApplicationPort = desktopImageApplication,
    private readonly admission: ApplicationMutationAdmission = applicationMutationAdmission
  ) {
    this.application.onChange((snapshot) => {
      if (snapshot.requestId === this.pendingCommitId && snapshot.progress?.totalSteps) {
        this.pendingTotalSteps = snapshot.progress.totalSteps
      }
      if (snapshot.phase === 'done' && snapshot.requestId === this.pendingCommitId) return
      this.publish(this.project(snapshot))
    })
  }

  status(): ImageGenerationJobContract {
    return this.project(this.application.status())
  }

  onChange(listener: JobListener): () => void {
    this.jobListeners.add(listener)
    this.notify(listener, this.status())
    return () => this.jobListeners.delete(listener)
  }

  onConversationUpdated(listener: ConversationListener): () => void {
    this.conversationListeners.add(listener)
    return () => this.conversationListeners.delete(listener)
  }

  /** Reject before a caller reserves related state for a job this service cannot accept. */
  assertCanStart(): void {
    this.admission.assertOpen('images')
    if (this.application.isRunning()) {
      throw new Error('An image is already generating — please wait for it to finish.')
    }
  }

  async start(request: ImageGenerationJobRequest): Promise<ImageGenerationResult> {
    this.assertCanStart()
    return this.admission.admit('images', () => this.run(request))
  }

  private async run(request: ImageGenerationJobRequest): Promise<ImageGenerationResult> {
    const id = randomUUID()
    this.persistence.prepareCreation?.(id, Boolean(request.initImage))
    this.pendingCommitId = id
    this.pendingTotalSteps = null
    this.persistenceFailure = null
    this.cancellationFailure = null
    try {
      const output = await this.application.start({ ...request, requestId: id })
      const startedAt = this.application.status().startedAt ?? Date.now()
      await this.finalize({ id, request, output, startedAt })
      this.pendingCommitId = null
      this.cancellationFailure = null
      this.publish(this.status())
      return { ...output, syncId: id }
    } catch (error) {
      if (this.application.status().phase === 'done') {
        const failure =
          error instanceof ImageGenerationPersistenceError
            ? error
            : new ImageGenerationPersistenceError(
                id,
                this.application.status().result?.path ?? '',
                { cause: error }
              )
        this.persistenceFailure = {
          requestId: id,
          error: failure.message,
          finishedAt: Date.now()
        }
        this.pendingCommitId = null
        this.cancellationFailure = null
        this.publish(this.status())
        throw failure
      }
      this.pendingCommitId = null
      this.cancellationFailure = null
      throw error
    }
  }

  async cancel(): Promise<boolean> {
    const running = this.application.isRunning()
    if (!running) return false
    const snapshot = this.application.status()
    const requestId = snapshot.requestId ?? this.pendingCommitId ?? ''
    try {
      if (!(await this.application.cancel())) {
        throw new ImageGenerationCancellationError(requestId, 'refused', {
          cause: new Error('The native image runtime refused cancellation.')
        })
      }
      this.cancellationFailure = null
      return true
    } catch (error) {
      const failure =
        error instanceof ImageGenerationCancellationError
          ? error
          : new ImageGenerationCancellationError(requestId, 'failed', { cause: error })
      this.cancellationFailure = { requestId, error: failure.message }
      this.publish(this.status())
      throw failure
    }
  }

  /**
   * Called only after the renderer has persisted the generated assistant message.
   * A remounted Chat observes this and refreshes the conversation from SQLite.
   *
   * The requested message id is not authority. `noteMessage` verifies the acknowledged identity
   * against the durable Workspace Content owner before it performs the deferred offer. The
   * generated-image owner treats a repeated acknowledgement as idempotent.
   */
  async acknowledgeConversation(conversationId: string, messageId?: string): Promise<boolean> {
    const snapshot = this.status()
    if (!canAcknowledgeImageConversation(snapshot, conversationId)) return false
    const syncId = snapshot.id
    if (!syncId) return false
    const reservedMessageId = this.application.status().messageId
    const acknowledgedMessageId = messageId ?? reservedMessageId
    if (!acknowledgedMessageId) return false
    if (snapshot.outputPath) {
      try {
        if (
          !(await this.persistence.noteMessage(snapshot.outputPath, {
            conversationId,
            messageId: acknowledgedMessageId
          }))
        ) {
          throw new Error('The generated image could not be linked to its conversation message.')
        }
      } catch (error) {
        throw new ImageGenerationPersistenceError(syncId, snapshot.outputPath, {
          cause: error
        })
      }
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

  private async finalize(context: {
    id: string
    request: ImageGenerationJobRequest
    output: ImageGenOutput
    startedAt: number
  }): Promise<void> {
    const { id, request, output, startedAt } = context
    if (!output.path) {
      throw new ImageGenerationPersistenceError(id, '', {
        cause: new Error('The native image runtime did not return an owned output path.')
      })
    }
    try {
      if (request.initImage && !this.persistence.preserveSource(id, request.initImage)) {
        this.persistence.settleMissingSource?.(id)
      }
      const steps = this.pendingTotalSteps ?? request.steps
      await this.persistence.create(
        await generatedImageRecord({ id, request, output, startedAt, steps })
      )
    } catch (scopeError) {
      let cleanupError: unknown = null
      try {
        this.persistence.settleCreation?.(id)
      } catch (cause) {
        cleanupError = cause
      }
      console.error(
        `[image-job] ${JSON.stringify({
          event: 'gallery-create-failed',
          id,
          error: scopeError instanceof Error ? scopeError.message : String(scopeError)
        })}`
      )
      throw new ImageGenerationPersistenceError(id, output.path, {
        cause: cleanupError ? new AggregateError([scopeError, cleanupError]) : scopeError
      })
    }
  }

  private project(snapshot: ImageApplicationSnapshot<ImageGenOutput>): ImageGenerationJobContract {
    const projected = projectSnapshot(snapshot)
    if (snapshot.requestId === this.persistenceFailure?.requestId) {
      return {
        ...projected,
        phase: 'failed',
        stage: null,
        outputPath: null,
        progress: null,
        error: this.persistenceFailure.error,
        finishedAt: this.persistenceFailure.finishedAt
      }
    }
    if (
      snapshot.requestId === this.cancellationFailure?.requestId &&
      isImageApplicationInFlight(snapshot.phase)
    ) {
      return { ...projected, error: this.cancellationFailure.error }
    }
    if (snapshot.phase === 'done' && snapshot.requestId === this.pendingCommitId) {
      return {
        ...projected,
        phase: 'running',
        stage: 'generating',
        outputPath: null,
        finishedAt: null
      }
    }
    return projected
  }

  private publish(snapshot: ImageGenerationJobContract): void {
    for (const listener of this.jobListeners) this.notify(listener, snapshot)
  }

  private notify(listener: JobListener, snapshot: ImageGenerationJobContract): void {
    try {
      listener(snapshot)
    } catch (error) {
      console.error(
        `[image-job] ${JSON.stringify({
          event: 'job-observer-failed',
          error: error instanceof Error ? error.message : String(error)
        })}`
      )
    }
  }
}

export const imageGenerationJobs = new ImageGenerationJobService()
