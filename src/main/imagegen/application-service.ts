import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ImageGenerationApplicationService,
  ImageExecutionPlanError,
  IMAGE_CANCELLED_MESSAGE,
  imageGenerationOperation,
  isImageApplicationInFlight,
  resolveImageGenerationSettings,
  standardImageModelDefaults,
  type ImageApplicationSnapshot,
  type ImageGenerationApplicationPorts,
  type ImageNativeExecutionFacts,
  type ImageRuntimeInspection,
  type RuntimeModel
} from '@offgrid/models'
import type {
  ImageGenerationJobStage,
  ImageGenerationPipelineUpdateContract,
  ImageGenerationRequestContract,
  ImageGenerationOutputContract
} from '../../shared/image-generation-contract'
import {
  imageMemoryGuardErrorMessage,
  parseImageMemoryGuardError
} from '../../shared/image-generation-contract'
import { generateDesktopOperation, generateDesktopText } from '../desktop-generation'
import { getSetting } from '../database'
import { desktopModelServices } from '../model-service-access'
import { dataDir } from '../runtime-env'
import { enhanceImagePrompt } from '@offgrid/models'

let nativeCancelBoundary: () => void | Promise<void> = () => undefined
let nativeInspectionBoundary: (input: {
  modelId: string
  sourceImageUri?: string
  persistentRequested: boolean
}) => Promise<ImageNativeExecutionFacts> = async () => {
  throw new Error('The Desktop image native inspection boundary is not registered.')
}

/** Composition-root registration keeps the Shared use case independent of its native engine. */
export function registerDesktopImageCancelBoundary(boundary: () => void | Promise<void>): void {
  nativeCancelBoundary = boundary
}

export function registerDesktopImageInspectionBoundary(
  boundary: typeof nativeInspectionBoundary
): void {
  nativeInspectionBoundary = boundary
}

export interface DesktopImageApplicationRequest extends ImageGenerationRequestContract {
  requestId?: string
  routeId?: string
  conversationId?: string
  projectId?: string | null
  messageId?: string
}

function sharedRequest(request: DesktopImageApplicationRequest): DesktopImageApplicationRequest & {
  guidanceScale?: number
  sourceImageUri?: string
} {
  return {
    ...request,
    guidanceScale: request.cfgScale,
    sourceImageUri: request.initImage
  }
}

function routeIdentity(model: RuntimeModel): string {
  return model.routeId ?? model.id
}

function localRuntimeInspection(model: RuntimeModel, threads: number): ImageRuntimeInspection {
  const identity = routeIdentity(model)
  const resident = desktopModelServices.residency
    .getResidents()
    .find((candidate) => candidate.modelId === identity || candidate.modelId === model.id)
  return {
    loaded: Boolean(resident),
    loadedIdentity: resident ? identity : null,
    desiredIdentity: identity,
    loadedThreads: resident ? threads : null,
    wasWarmed: Boolean(resident),
    hasKernelCache: true
  }
}

async function persistRemoteOutput(
  output: ImageGenerationOutputContract
): Promise<ImageGenerationOutputContract> {
  if (output.path && path.isAbsolute(output.path) && fs.existsSync(output.path)) return output
  let bytes: Buffer | null = null
  if (output.dataUrl.startsWith('data:')) {
    bytes = Buffer.from(output.dataUrl.split(',', 2)[1] ?? '', 'base64')
  } else if (/^https?:\/\//i.test(output.path)) {
    const response = await fetch(output.path)
    if (!response.ok) throw new Error(`Remote image download failed (${String(response.status)}).`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (!bytes?.length) return output
  const directory = path.join(dataDir(), 'generated-images')
  fs.mkdirSync(directory, { recursive: true })
  const destination = path.join(directory, `img-${String(Date.now())}-${randomUUID()}.png`)
  await fs.promises.writeFile(destination, bytes)
  return {
    ...output,
    path: destination,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`
  }
}

function applicationPorts(): ImageGenerationApplicationPorts<
  ImageGenerationOutputContract,
  ImageGenerationOutputContract,
  ReturnType<typeof sharedRequest>
> {
  return {
    refreshInventory: () => desktopModelServices.refresh().then(() => undefined),
    resolveRouteId: (request) =>
      request.routeId ??
      (request.model
        ? desktopModelServices.routeIdFor('image', request.model)
        : (desktopModelServices.llm.active('image').selectedRouteId ?? undefined)),
    createId: randomUUID,
    resolveSettings(request, model) {
      const defaults = standardImageModelDefaults(model.name || model.id)
      return {
        ...resolveImageGenerationSettings({
          platform: process.platform,
          request,
          settings: {
            steps: defaults.defaultSteps,
            guidanceScale: defaults.defaultCfg,
            width: defaults.defaultSize,
            height: defaults.defaultSize,
            threads: Math.max(1, os.cpus().length - 2),
            useOpenCL: false
          }
        }),
        enhancePrompt: getSetting<boolean>('enhanceImagePrompts', true)
      }
    },
    async enhancePrompt(request, signal, ...callbacks) {
      const [, onPrompt] = callbacks
      let streamed = ''
      return enhanceImagePrompt(request.prompt, {
        enabled: true,
        onText: (text) => {
          streamed += text
          onPrompt?.(streamed)
        },
        generate: (instruction, onText) =>
          generateDesktopText(instruction, {
            temperature: 0.7,
            thinking: false,
            maxTokens: 200,
            timeoutMs: 60_000,
            signal,
            events: { chunk: (chunk) => chunk.content && onText(chunk.content) }
          }).then((result) => result.content)
      })
    },
    inspectRuntime: async (model, settings) => localRuntimeInspection(model, settings.threads),
    inspectExecution: (input) =>
      nativeInspectionBoundary({
        modelId: input.model.id,
        sourceImageUri: input.request.sourceImageUri,
        persistentRequested: input.model.residencyLifecycle === 'persistent'
      }),
    async ensureLoaded() {
      // GenerationService acquires the exact residency lease with the selected adapter.
    },
    async execute(input, onProgress) {
      const operation = imageGenerationOperation({
        request: input.request,
        modelId: input.model.id,
        prompt: input.prompt,
        settings: input.settings,
        force: input.force,
        executionPlan: input.plan
      })
      const turnId = input.request.requestId ?? randomUUID()
      const result = await generateDesktopOperation(operation, {
        routeId: routeIdentity(input.model),
        identity: { conversationId: input.request.conversationId ?? turnId, turnId },
        timeoutMs: 24 * 60 * 60 * 1000,
        allowFallback: false,
        signal: input.signal,
        events: {
          chunk(chunk) {
            const progress = chunk.progress
            if (!progress) return
            onProgress({
              step: progress.completed,
              totalSteps: progress.total,
              previewUri: progress.preview?.uri,
              stage: progress.stage === 'decoding' ? 'decoding' : 'sampling'
            })
          }
        }
      })
      if (result.output.type !== 'image' || !result.output.images[0]) {
        throw new Error('The image engine returned no image artifact.')
      }
      const artifact = result.output.images[0]
      return {
        dataUrl: artifact.data
          ? `data:${artifact.mimeType};base64,${artifact.data}`
          : (artifact.uri ?? ''),
        path: artifact.uri ?? '',
        seed: artifact.seed ?? input.request.seed ?? -1,
        model: artifact.id ?? result.model.name,
        prompt: input.prompt
      }
    },
    persist: ({ output }) => persistRemoteOutput(output),
    cancelBoundary: async () => nativeCancelBoundary(),
    ejectForRetry: () => desktopModelServices.unload('image').then(() => undefined),
    isForceLoadError: (error) =>
      parseImageMemoryGuardError(error) !== null ||
      (error instanceof ImageExecutionPlanError && error.code === 'memory-limit'),
    retainCancelledState: true
  }
}

const application = new ImageGenerationApplicationService<
  ImageGenerationOutputContract,
  ImageGenerationOutputContract,
  ReturnType<typeof sharedRequest>
>(
  { resolveRoute: (requirements) => desktopModelServices.llm.resolveRoute(requirements) },
  applicationPorts()
)

function pipelineStage(
  snapshot: ImageApplicationSnapshot<ImageGenerationOutputContract>
): ImageGenerationJobStage {
  if (snapshot.phase === 'enhancing') return 'enhancing'
  if (snapshot.phase === 'generating' && snapshot.progress?.stage === 'decoding') return 'decoding'
  if (snapshot.phase === 'generating') return 'generating'
  return 'preparing'
}

export const desktopImageApplication = {
  status: () => application.status(),
  onChange: (
    listener: (snapshot: ImageApplicationSnapshot<ImageGenerationOutputContract>) => void
  ) => application.onChange(listener),
  isRunning: () => isImageApplicationInFlight(application.status().phase),
  async start(
    request: DesktopImageApplicationRequest,
    onUpdate?: (update: ImageGenerationPipelineUpdateContract) => void,
    input: { force?: boolean } = {}
  ): Promise<ImageGenerationOutputContract> {
    const requestId = request.requestId ?? randomUUID()
    const normalized = sharedRequest({ ...request, requestId })
    const off = onUpdate
      ? application.onChange((snapshot) => {
          if (snapshot.requestId !== requestId || !isImageApplicationInFlight(snapshot.phase))
            return
          onUpdate({
            stage: pipelineStage(snapshot),
            enhancedPrompt:
              snapshot.phase === 'enhancing'
                ? snapshot.prompt === request.prompt
                  ? ''
                  : (snapshot.prompt ?? '')
                : (snapshot.prompt ?? undefined),
            progress: snapshot.progress
              ? {
                  step: snapshot.progress.step,
                  total: snapshot.progress.totalSteps,
                  secPerStep: snapshot.progress.secondsPerStep ?? 0,
                  preview: snapshot.progress.previewUri,
                  phase: snapshot.progress.stage
                }
              : undefined
          })
        })
      : undefined
    try {
      const result = await application.start(normalized, input)
      if (result) return result
      const snapshot = application.status()
      if (snapshot.phase === 'error') {
        if (
          snapshot.failure?.cause instanceof ImageExecutionPlanError &&
          snapshot.failure.cause.code === 'memory-limit'
        ) {
          throw new Error(imageMemoryGuardErrorMessage(snapshot.failure.cause.message))
        }
        if (snapshot.failure?.cause instanceof Error) throw snapshot.failure.cause
        throw new Error(snapshot.error ?? 'Image generation failed.')
      }
      if (snapshot.phase === 'cancelled') throw new Error(IMAGE_CANCELLED_MESSAGE)
      throw new Error('An image is already generating — please wait for it to finish.')
    } finally {
      off?.()
    }
  },
  cancel: () => application.cancel()
}
