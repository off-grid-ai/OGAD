import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ImageExecutionPlanError,
  IMAGE_CANCELLED_MESSAGE,
  ModelAdmissionError,
  imageGenerationOperation,
  isImageApplicationInFlight,
  gatewayImageExtensionForMime,
  resolveImageGenerationSettings,
  resolveImageParameters,
  type ImageParameterStore,
  type ImageApplicationSnapshot,
  type ImageGenerationApplicationPorts,
  type ImageNativeExecutionFacts,
  type ImageRuntimeInspection,
  type RuntimeModel,
  imageEnhancementGenerationRequest
} from '@offgrid/models'
import type {
  ImageGenerationJobStage,
  ImageGenerationPipelineUpdateContract,
  ImageGenerationRequestContract,
  ImageGenerationOutputContract
} from '../../shared/image-generation-contract'
import {
  imageMemoryGuardErrorMessage,
  imageModelAdmissionMessage,
  parseImageMemoryGuardError
} from '../../shared/image-generation-contract'
import { generateDesktopOperation } from '../desktop-generation'
import { getSetting } from '../database'
import { desktopModelServices } from '../model-service-access'
import { dataDir } from '../runtime-env'
import { enhanceImagePrompt } from '@offgrid/models'
import { resolveExistingOwnedPath } from './owned-path'
import { decodeDataUrl, toDataUrl } from '../model-server/image-bytes'
import { imageGenerationApplication } from '../composition/imagegen'

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

function localImageArtifactPath(value: string, generatedImagesRoot: string): string | null {
  if (!value) return null
  let candidate = value
  if (/^file:/i.test(value)) {
    try {
      candidate = fileURLToPath(value)
    } catch {
      return null
    }
  }
  if (!path.isAbsolute(candidate)) return null
  return resolveExistingOwnedPath(generatedImagesRoot, candidate)
}

type PersistedImageMime = 'image/png' | 'image/jpeg' | 'image/webp'

function imageMimeType(filePath: string): PersistedImageMime | null {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    default:
      return null
  }
}

function supportedImageMime(value: string | null | undefined): PersistedImageMime | null {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase()
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp' ? mime : null
}

function imageMimeFromSignature(bytes: Buffer): PersistedImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

function validateImageArtifact(bytes: Buffer, declaredMime: string | null | undefined): PersistedImageMime {
  const expected = supportedImageMime(declaredMime)
  if (!expected) {
    throw new Error('The image engine returned an unsupported image content type.')
  }
  const detected = imageMimeFromSignature(bytes)
  if (!detected) {
    throw new Error('The image engine returned unsupported or damaged image data.')
  }
  if (detected !== expected) {
    throw new Error(`The image engine returned ${detected} data as ${expected}.`)
  }
  return detected
}

export async function persistImageGenerationOutput(
  output: ImageGenerationOutputContract
): Promise<ImageGenerationOutputContract> {
  const directory = path.join(dataDir(), 'generated-images')
  fs.mkdirSync(directory, { recursive: true })
  const localPath = localImageArtifactPath(output.path, directory)
  if (localPath) {
    const bytes = await fs.promises.readFile(localPath)
    const mime = validateImageArtifact(bytes, imageMimeType(localPath))
    return {
      ...output,
      path: localPath,
      dataUrl: toDataUrl(bytes, mime)
    }
  }
  let bytes: Buffer | null = null
  let declaredMime: string | null = null
  if (output.dataUrl.startsWith('data:')) {
    const decoded = decodeDataUrl(output.dataUrl)
    bytes = decoded.data
    declaredMime = decoded.mime
  } else if (/^https?:\/\//i.test(output.path)) {
    const response = await fetch(output.path)
    if (!response.ok) throw new Error(`Remote image download failed (${String(response.status)}).`)
    bytes = Buffer.from(await response.arrayBuffer())
    declaredMime = response.headers.get('content-type')
  }
  if (!bytes?.length) {
    throw new Error('The image engine returned no readable image artifact.')
  }
  const mime = validateImageArtifact(bytes, declaredMime)
  const destination = path.join(
    directory,
    `img-${String(Date.now())}-${randomUUID()}${gatewayImageExtensionForMime(mime)}`
  )
  await fs.promises.writeFile(destination, bytes)
  return {
    ...output,
    path: destination,
    dataUrl: toDataUrl(bytes, mime)
  }
}

export type DesktopImageSharedRequest = ReturnType<typeof sharedRequest>

/** Desktop's image I/O: engine, persistence, cancel boundary, eviction. Shared owns the pipeline. */
export function desktopImageApplicationPorts(): ImageGenerationApplicationPorts<
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
      // The user's per-model overrides (Settings > Image, the composer) apply to EVERY path that
      // generates an image: composer, tool call, gateway, paired phone. One store, one resolver.
      const parameters = resolveImageParameters(
        model,
        getSetting<ImageParameterStore>('imageParams', {})
      )
      return {
        ...resolveImageGenerationSettings({
          platform: process.platform,
          request,
          settings: {
            steps: parameters.steps,
            guidanceScale: parameters.cfgScale,
            width: parameters.size,
            height: parameters.size,
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
      const turnId = randomUUID()
      return enhanceImagePrompt(request.prompt, {
        enabled: true,
        onText: (text) => {
          streamed += text
          onPrompt?.(streamed)
        },
        // Shared decides the whole request; this port only runs it and streams text back.
        generate: (_instruction, onText) =>
          desktopModelServices.generation
            .generate(
              imageEnhancementGenerationRequest(
                request.prompt,
                { conversationId: request.conversationId ?? turnId, turnId },
                { signal }
              ),
              { chunk: (chunk) => chunk.content && onText(chunk.content) }
            )
            .then((result) => result.content)
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
    persist: ({ output }) => persistImageGenerationOutput(output),
    cancelBoundary: async () => nativeCancelBoundary(),
    ejectForRetry: () => desktopModelServices.unload('image').then(() => undefined),
    isForceLoadError: (error) =>
      parseImageMemoryGuardError(error) !== null ||
      error instanceof ModelAdmissionError ||
      (error instanceof ImageExecutionPlanError && error.code === 'memory-limit'),
    retainCancelledState: true
  }
}

const application = (): ReturnType<typeof imageGenerationApplication> => imageGenerationApplication()

function pipelineStage(
  snapshot: ImageApplicationSnapshot<ImageGenerationOutputContract>
): ImageGenerationJobStage {
  if (snapshot.phase === 'enhancing') return 'enhancing'
  if (snapshot.phase === 'generating' && snapshot.progress?.stage === 'decoding') return 'decoding'
  if (snapshot.phase === 'generating') return 'generating'
  return 'preparing'
}

function imageApplicationError(
  snapshot: ImageApplicationSnapshot<ImageGenerationOutputContract>
): Error {
  const cause = snapshot.failure?.cause
  if (cause instanceof ModelAdmissionError) {
    return new Error(imageMemoryGuardErrorMessage(imageModelAdmissionMessage(cause.model.name)))
  }
  if (cause instanceof ImageExecutionPlanError && cause.code === 'memory-limit') {
    return new Error(imageMemoryGuardErrorMessage(cause.message))
  }
  if (cause instanceof Error) return cause
  return new Error(snapshot.error ?? 'Image generation failed.')
}

export const desktopImageApplication = {
  status: () => application().status(),
  onChange: (
    listener: (snapshot: ImageApplicationSnapshot<ImageGenerationOutputContract>) => void
  ) => application().onChange(listener),
  isRunning: () => isImageApplicationInFlight(application().status().phase),
  async start(
    request: DesktopImageApplicationRequest,
    onUpdate?: (update: ImageGenerationPipelineUpdateContract) => void,
    input: { force?: boolean } = {}
  ): Promise<ImageGenerationOutputContract> {
    const requestId = request.requestId ?? randomUUID()
    const normalized = sharedRequest({ ...request, requestId })
    const off = onUpdate
      ? application().onChange((snapshot) => {
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
      const result = await application().start(normalized, input)
      if (result) return result
      const snapshot = application().status()
      if (snapshot.phase === 'error') {
        throw imageApplicationError(snapshot)
      }
      if (snapshot.phase === 'cancelled') throw new Error(IMAGE_CANCELLED_MESSAGE)
      throw new Error('An image is already generating — please wait for it to finish.')
    } finally {
      off?.()
    }
  },
  cancel: () => application().cancel()
}
