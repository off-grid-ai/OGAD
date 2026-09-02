/**
 * User journeys through the main-owned image job boundary. The service and its
 * observer lifecycle are production code; only the native image runtime is a
 * controlled boundary so navigation, cancellation, and failure remain deterministic.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ImageGenerationCancellationError,
  ImageGenerationJobService,
  ImageGenerationPersistenceError,
  type DesktopImageApplicationPort,
  type ImageGenerationPersistencePort,
  type ImageGenerationJobRequest
} from '../imagegen/job-service'
import type { ImageApplicationSnapshot } from '@offgrid/models'
import type {
  ImageGenerationPipelineUpdateContract,
  ImageGenerationProgressContract
} from '../../shared/image-generation-contract'
import type { ImageGenOutput } from '../imagegen'
import type { GeneratedImageSidecar } from '../imagegen/gallery-sidecar'
import { generatedImageMetadataJson, type ChatHome } from '@offgrid/sync'

/**
 * A real file on disk for the runtime to claim it produced.
 *
 * On success the service stats the output and publishes it as a shared file, so that other devices can
 * receive the generated image - it needs the real byte size, and it reads it from the file. A fictional
 * path makes that stat throw ENOENT and the whole generation rejects, which reads as "generating an
 * image is broken" when the only thing missing was the file.
 *
 * Disk is a boundary this test can afford to keep real, so it does.
 */
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-image-job-'))
const generatedFile = (name: string): string => {
  const filePath = path.join(workspace, name)
  fs.writeFileSync(filePath, Buffer.from('89504e470d0a1a0a', 'hex')) // PNG signature; size is what is read
  return filePath
}
afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }))

interface ControlledGeneration {
  update(update: ImageGenerationPipelineUpdateContract): void
  progress(progress: ImageGenerationProgressContract): void
  succeed(output: ImageGenOutput): void
  fail(error: unknown): void
}

interface ControlledRuntimeOptions {
  cancelError?: Error
  noteMessageResult?: boolean
  noteMessageError?: Error
}

function controlledRuntime(
  cancelResult = true,
  saveScopeError?: Error,
  options: ControlledRuntimeOptions = {}
): {
  application: DesktopImageApplicationPort
  persistence: ImageGenerationPersistencePort
  generation(): ControlledGeneration
  savedScopes: { path: string; scope: GeneratedImageSidecar }[]
  sharedPaths: string[]
  notedMessages: { path: string; shownIn: ChatHome }[]
  preservedSources: { syncId: string; sourcePath: string }[]
} {
  let resolveGeneration: ((output: ImageGenOutput) => void) | null = null
  let rejectGeneration: ((error: unknown) => void) | null = null
  let snapshot: ImageApplicationSnapshot<ImageGenOutput> = {
    phase: 'idle',
    requestId: null,
    prompt: null,
    conversationId: null,
    projectId: null,
    messageId: null,
    progress: null,
    status: null,
    previewUri: null,
    error: null,
    failure: null,
    result: null,
    startedAt: null,
    finishedAt: null
  }
  const listeners = new Set<(value: ImageApplicationSnapshot<ImageGenOutput>) => void>()
  const publish = (): void => {
    const value = { ...snapshot, progress: snapshot.progress && { ...snapshot.progress } }
    for (const listener of listeners) {
      try {
        listener(value)
      } catch {
        /* renderer observers cannot break the use case */
      }
    }
  }
  const set = (patch: Partial<ImageApplicationSnapshot<ImageGenOutput>>): void => {
    snapshot = { ...snapshot, ...patch }
    publish()
  }
  const savedScopes: { path: string; scope: GeneratedImageSidecar }[] = []
  const sharedPaths: string[] = []
  const notedMessages: { path: string; shownIn: ChatHome }[] = []
  const preservedSources: { syncId: string; sourcePath: string }[] = []

  return {
    application: {
      status: () => ({ ...snapshot, progress: snapshot.progress && { ...snapshot.progress } }),
      onChange: (listener) => {
        listeners.add(listener)
        listener({ ...snapshot })
        return () => listeners.delete(listener)
      },
      isRunning: () =>
        snapshot.phase === 'enhancing' ||
        snapshot.phase === 'loading' ||
        snapshot.phase === 'generating' ||
        snapshot.phase === 'saving',
      start: (generationRequest) => {
        set({
          phase: 'generating',
          requestId: generationRequest.requestId ?? null,
          prompt: generationRequest.prompt,
          conversationId: generationRequest.conversationId ?? null,
          projectId: generationRequest.projectId ?? null,
          messageId: generationRequest.messageId ?? null,
          startedAt: Date.now(),
          finishedAt: null,
          error: null,
          result: null,
          progress: { step: 0, totalSteps: generationRequest.steps ?? 1 }
        })
        return new Promise<ImageGenOutput>((resolve, reject) => {
          resolveGeneration = (output) => {
            set({ phase: 'done', result: output, progress: null, finishedAt: Date.now() })
            resolve(output)
          }
          rejectGeneration = (error) => {
            if (snapshot.phase !== 'cancelled') {
              set({
                phase: 'error',
                error: error instanceof Error ? error.message : String(error),
                progress: null,
                finishedAt: Date.now()
              })
            }
            reject(error)
          }
        })
      },
      cancel: async () => {
        if (options.cancelError) throw options.cancelError
        if (!cancelResult || snapshot.phase !== 'generating') return false
        set({ phase: 'cancelled', progress: null, error: null, finishedAt: Date.now() })
        return true
      }
    },
    persistence: {
      saveScope: (path, scope) => {
        if (saveScopeError) throw saveScopeError
        savedScopes.push({ path, scope })
      },
      // Sharing reaches the mesh, so it is a boundary here. What is SHARED is asserted through the
      // scope the sidecar was given, which is what the description is built from.
      share: (path) => {
        sharedPaths.push(path)
        return true
      },
      noteMessage: (path, shownIn) => {
        if (options.noteMessageError) throw options.noteMessageError
        if (options.noteMessageResult === false) return false
        notedMessages.push({ path, shownIn })
        return true
      },
      preserveSource: (syncId, sourcePath) => {
        preservedSources.push({ syncId, sourcePath })
        return `${sourcePath}.kept`
      }
    },
    generation: () => ({
      update: (update) =>
        snapshot.phase === 'cancelled'
          ? undefined
          : set({
              phase: update.stage === 'enhancing' ? 'enhancing' : 'generating',
              prompt: update.enhancedPrompt ?? snapshot.prompt,
              progress: update.progress
                ? {
                    step: update.progress.step,
                    totalSteps: update.progress.total,
                    secondsPerStep: update.progress.secPerStep,
                    previewUri: update.progress.preview,
                    stage: update.progress.phase
                  }
                : snapshot.progress
            }),
      progress: (progress) =>
        snapshot.phase === 'cancelled'
          ? undefined
          : set({
              phase: 'generating',
              progress: {
                step: progress.step,
                totalSteps: progress.total,
                secondsPerStep: progress.secPerStep,
                previewUri: progress.preview,
                stage: progress.phase
              }
            }),
      succeed: (output) => resolveGeneration?.(output),
      fail: (error) => rejectGeneration?.(error)
    }),
    savedScopes,
    sharedPaths,
    notedMessages,
    preservedSources
  }
}

const request: ImageGenerationJobRequest = {
  prompt: 'A green cabin rendered while navigating',
  model: 'local-image-model',
  conversationId: 'conversation-navigation',
  messageId: 'message-navigation',
  projectId: 'project-navigation',
  seed: 91,
  width: 512,
  height: 512,
  steps: 4
}

describe('main-owned image generation job journeys', () => {
  it('keeps one job observable while the user navigates away and returns', async () => {
    const boundary = controlledRuntime()
    const jobs = new ImageGenerationJobService(boundary.persistence, boundary.application)
    const firstScreen: string[] = []
    const returnedScreen: string[] = []
    const detachFirst = jobs.onChange((job) => firstScreen.push(job.phase))

    const generation = jobs.start(request)
    expect(jobs.status()).toMatchObject({
      phase: 'running',
      conversationId: request.conversationId,
      projectId: request.projectId
    })
    await expect(jobs.start(request)).rejects.toThrow('already generating')

    boundary.generation().update({
      stage: 'enhancing',
      enhancedPrompt: 'A quiet observatory under'
    })
    expect(jobs.status()).toMatchObject({
      stage: 'enhancing',
      enhancedPrompt: 'A quiet observatory under'
    })

    boundary.generation().progress({ step: 2, total: 4, secPerStep: 0.5, phase: 'sampling' })
    expect(jobs.status().stage).toBe('generating')
    const progress = jobs.status().progress
    expect(progress).toEqual({ step: 2, total: 4, secPerStep: 0.5, phase: 'sampling' })
    if (progress) progress.step = 99
    expect(jobs.status().progress?.step).toBe(2)

    detachFirst()
    const detachReturned = jobs.onChange((job) => returnedScreen.push(job.phase))
    const output: ImageGenOutput = {
      dataUrl: 'data:image/png;base64,aW1hZ2U=',
      path: generatedFile('image.png'),
      seed: 91,
      model: 'Local image model',
      prompt: 'A detailed emerald cabin beneath a star-filled sky'
    }
    boundary.generation().succeed(output)
    await expect(generation).resolves.toEqual({ ...output, syncId: jobs.status().id })

    expect(firstScreen).not.toContain('succeeded')
    expect(returnedScreen).toContain('succeeded')
    expect(jobs.status()).toMatchObject({
      phase: 'succeeded',
      outputPath: output.path,
      progress: null,
      error: null
    })
    // Everything the description is built from, in one place. A fact missing here is a fact the
    // second description - the one made once the chat has a message - would silently drop.
    expect(boundary.savedScopes).toEqual([
      {
        path: output.path,
        scope: {
          syncId: jobs.status().id,
          conversationId: request.conversationId,
          messageId: request.messageId,
          projectId: request.projectId,
          createdAt: expect.any(String),
          width: request.width,
          height: request.height,
          // Built by the shared writer, not spelled out here. A literal in the test would let the
          // wire's field names drift on one platform without a single assertion noticing - which is
          // exactly what happened: the Mac wrote `model` and the phone only ever read `modelId`.
          metadataJson: generatedImageMetadataJson({
            prompt: output.prompt,
            steps: request.steps,
            seed: output.seed,
            modelId: output.model
          })
        }
      }
    ])
    expect(boundary.sharedPaths).toEqual([output.path])

    const refreshed: string[] = []
    jobs.onConversationUpdated(() => {
      throw new Error('closed renderer')
    })
    const detachRefresh = jobs.onConversationUpdated((conversationId) =>
      refreshed.push(conversationId)
    )
    expect(jobs.acknowledgeConversation('another-conversation')).toBe(false)
    expect(jobs.acknowledgeConversation(request.conversationId!)).toBe(true)
    expect(refreshed).toEqual([request.conversationId])
    detachRefresh()
    detachReturned()
  })

  it('cancels the active native run and reports a stable cancelled result', async () => {
    const boundary = controlledRuntime()
    const jobs = new ImageGenerationJobService(boundary.persistence, boundary.application)
    const phases: string[] = []
    jobs.onChange((job) => phases.push(job.phase))
    const generation = jobs.start({ prompt: 'Cancel this image' })

    boundary.generation().progress({ step: 1, total: 4, secPerStep: 0.5 })
    await expect(jobs.cancel()).resolves.toBe(true)
    await expect(jobs.cancel()).resolves.toBe(false)
    boundary.generation().progress({ step: 3, total: 4, secPerStep: 0.5 })
    expect(jobs.status().progress).toBeNull()
    boundary.generation().fail(new Error('Native generation cancelled'))
    await expect(generation).rejects.toThrow('cancelled')
    expect(jobs.status()).toMatchObject({
      phase: 'cancelled',
      error: null
    })
    expect(phases.filter((phase) => phase === 'cancelled')).toHaveLength(1)
    expect(jobs.acknowledgeConversation('conversation-navigation')).toBe(false)
  })

  it.each([
    {
      label: 'refuses cancellation',
      boundary: () => controlledRuntime(false),
      reason: 'refused' as const,
      message: 'The active image generation refused cancellation.'
    },
    {
      label: 'fails cancellation',
      boundary: () =>
        controlledRuntime(true, undefined, { cancelError: new Error('native stop failed') }),
      reason: 'failed' as const,
      message: 'The active image generation could not be cancelled.'
    }
  ])(
    'projects a typed failure when the native runtime $label',
    async ({ boundary: makeBoundary, reason, message }) => {
      const boundary = makeBoundary()
      const jobs = new ImageGenerationJobService(boundary.persistence, boundary.application)
      const generation = jobs.start({ prompt: 'Keep this run observable' })

      await expect(jobs.cancel()).rejects.toMatchObject({
        name: ImageGenerationCancellationError.name,
        code: 'IMAGE_GENERATION_CANCELLATION_FAILED',
        reason
      })
      expect(jobs.status()).toMatchObject({ phase: 'running', error: message })

      boundary.generation().fail(new Error('test cleanup'))
      await expect(generation).rejects.toThrow('test cleanup')
    }
  )

  it('surfaces a native failure and stays usable when observers close abruptly', async () => {
    const boundary = controlledRuntime(false)
    const jobs = new ImageGenerationJobService(boundary.persistence, boundary.application)
    jobs.onChange(() => {
      throw 'renderer closed'
    })
    const generation = jobs.start({ prompt: 'A failing image' })

    boundary.generation().progress({ step: 1, total: 4, secPerStep: 0.5 })
    boundary.generation().fail('native runtime unavailable')
    await expect(generation).rejects.toBe('native runtime unavailable')
    expect(jobs.status()).toMatchObject({
      phase: 'failed',
      error: 'native runtime unavailable',
      progress: null,
      conversationId: null,
      projectId: null
    })
  })

  it('does not publish success when the canonical image identity cannot be committed', async () => {
    const boundary = controlledRuntime(true, new Error('scope database unavailable'))
    const jobs = new ImageGenerationJobService(boundary.persistence, boundary.application)
    const generation = jobs.start(request)
    const output: ImageGenOutput = {
      dataUrl: 'data:image/png;base64,aW1hZ2U=',
      path: generatedFile('image-without-scope.png'),
      seed: 91,
      model: 'Local image model',
      prompt: request.prompt
    }

    boundary.generation().succeed(output)

    await expect(generation).rejects.toMatchObject({
      name: 'ImageGenerationPersistenceError',
      code: 'IMAGE_GENERATION_PERSISTENCE_FAILED',
      imagePath: output.path
    })
    expect(jobs.status()).toMatchObject({
      phase: 'failed',
      outputPath: null,
      progress: null,
      error: 'The generated image could not be committed to the image library.'
    })
    expect(boundary.savedScopes).toEqual([])
    expect(boundary.sharedPaths).toEqual([])
  })

  it('does not acknowledge or notify before the durable message link succeeds', async () => {
    const boundary = controlledRuntime(true, undefined, { noteMessageResult: false })
    const jobs = new ImageGenerationJobService(boundary.persistence, boundary.application)
    const generation = jobs.start(request)
    const output: ImageGenOutput = {
      dataUrl: 'data:image/png;base64,aW1hZ2U=',
      path: generatedFile('image-without-message-link.png'),
      seed: 91,
      model: 'Local image model',
      prompt: request.prompt
    }
    const refreshed: string[] = []
    jobs.onConversationUpdated((conversationId) => refreshed.push(conversationId))

    boundary.generation().succeed(output)
    await expect(generation).resolves.toMatchObject({ syncId: expect.any(String) })

    expect(() =>
      jobs.acknowledgeConversation(request.conversationId!, request.messageId!)
    ).toThrow(ImageGenerationPersistenceError)
    expect(refreshed).toEqual([])
    expect(boundary.notedMessages).toEqual([])
  })

  it('defers the first share until an unreserved message association is durable', async () => {
    const boundary = controlledRuntime()
    const jobs = new ImageGenerationJobService(boundary.persistence, boundary.application)
    const generation = jobs.start({
      ...request,
      messageId: undefined
    })
    const output: ImageGenOutput = {
      dataUrl: 'data:image/png;base64,aW1hZ2U=',
      path: generatedFile('image-awaiting-message.png'),
      seed: 91,
      model: 'Local image model',
      prompt: request.prompt
    }
    const refreshed: string[] = []
    jobs.onConversationUpdated((conversationId) => refreshed.push(conversationId))

    boundary.generation().succeed(output)
    await expect(generation).resolves.toMatchObject({ syncId: expect.any(String) })
    expect(boundary.savedScopes).toHaveLength(1)
    expect(boundary.sharedPaths).toEqual([])
    expect(jobs.acknowledgeConversation(request.conversationId!)).toBe(false)

    expect(
      jobs.acknowledgeConversation(request.conversationId!, 'message-after-generation')
    ).toBe(true)
    expect(boundary.notedMessages).toEqual([
      {
        path: output.path,
        shownIn: {
          conversationId: request.conversationId,
          messageId: 'message-after-generation'
        }
      }
    ])
    expect(refreshed).toEqual([request.conversationId])
  })

  it('rejects a native result that has no durable owned output path', async () => {
    const boundary = controlledRuntime()
    const jobs = new ImageGenerationJobService(boundary.persistence, boundary.application)
    const generation = jobs.start({ prompt: 'An unscoped image' })
    const output: ImageGenOutput = {
      dataUrl: 'data:image/png;base64,aW1hZ2U=',
      path: '',
      seed: -1,
      model: 'Local image model',
      prompt: 'An unscoped image'
    }

    boundary.generation().succeed(output)
    await expect(generation).rejects.toMatchObject({
      name: ImageGenerationPersistenceError.name,
      code: 'IMAGE_GENERATION_PERSISTENCE_FAILED',
      imagePath: ''
    })
    expect(jobs.status()).toMatchObject({
      phase: 'failed',
      outputPath: null,
      error: 'The generated image could not be committed to the image library.'
    })
    expect(boundary.savedScopes).toEqual([])
    expect(boundary.sharedPaths).toEqual([])
  })
})
