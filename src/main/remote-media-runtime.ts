import fs from 'node:fs'
import path from 'node:path'
import {
  REMOTE_FETCH_REDIRECT_POLICY,
  parseRemoteImageGenerationResponse,
  parseRemoteEmbeddingResponse,
  parseRemoteTranscriptionResponse,
  remoteAuthorizationHeaders,
  remoteImageEndpoint,
  remoteEmbeddingEndpoint,
  remoteImageGenerationPayload,
  remoteMediaEndpoint,
  remoteProviderErrorMessage,
  remoteVoicePayload,
  remoteEmbeddingPayload,
  type GenerationRequest,
  type RemoteImageArtifact,
  type RuntimeModel
} from '@offgrid/models'
import { getRemoteVisionServer } from './vision/remote-vision-server'

export interface RemoteMediaConnection {
  endpoint: string
  apiKey: string
}

function connectionFor(model: RuntimeModel): RemoteMediaConnection {
  if (!model.serverId) throw new Error('The remote media route has no server identity.')
  const server = getRemoteVisionServer(model.serverId)
  if (!server) throw new Error('The selected remote media server is no longer available.')
  return server
}

async function remoteRequest<T>(
  input: {
    connection: RemoteMediaConnection
    url: string
    init: RequestInit
    request: Pick<GenerationRequest, 'signal' | 'timeoutMs'>
    consume(response: Response): Promise<T>
  },
  fetcher: typeof fetch
): Promise<T> {
  const { connection, url, init, request, consume } = input
  const controller = new AbortController()
  const abort = (): void => controller.abort(request.signal?.reason)
  request.signal?.addEventListener('abort', abort, { once: true })
  // No deadline unless the caller set one; a large image on a slow remote is not a failure.
  const timer =
    request.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => controller.abort(new Error('The remote media request timed out.')),
          request.timeoutMs
        )
  try {
    request.signal?.throwIfAborted()
    const response = await fetcher(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...init.headers,
        ...remoteAuthorizationHeaders(connection.endpoint, connection.apiKey)
      },
      redirect: REMOTE_FETCH_REDIRECT_POLICY,
      signal: controller.signal
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(remoteProviderErrorMessage(response.status, body))
    }
    return await consume(response)
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('Request cancelled.')
    if (controller.signal.aborted) throw new Error('The remote media request timed out.')
    throw error
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', abort)
  }
}

function imageBytes(source: { mimeType?: string; uri?: string; data?: string }): {
  bytes: Buffer
  mimeType: string
  name: string
} {
  const mimeType = source.mimeType || 'image/png'
  if (source.data) {
    return { bytes: Buffer.from(source.data, 'base64'), mimeType, name: 'source.png' }
  }
  const rawPath = source.uri?.startsWith('file://') ? source.uri.slice(7) : source.uri
  if (!rawPath || /^https?:\/\//i.test(rawPath)) {
    throw new Error('Remote image editing needs a local source image.')
  }
  return { bytes: fs.readFileSync(rawPath), mimeType, name: path.basename(rawPath) || 'source.png' }
}

/** Desktop transport adapter for OpenAI-compatible remote media routes. */
export function createRemoteMediaRuntime(
  resolveConnection: (model: RuntimeModel) => RemoteMediaConnection = connectionFor,
  fetcher: typeof fetch = fetch
): {
  image(model: RuntimeModel, request: GenerationRequest): Promise<RemoteImageArtifact>
  transcription(
    model: RuntimeModel,
    request: GenerationRequest
  ): Promise<{
    text: string
    language?: string
    segments?: Array<{ start: number; end: number; text: string }>
  }>
  voice(
    model: RuntimeModel,
    request: GenerationRequest
  ): Promise<{ data: string; mimeType: string }>
  embedding(model: RuntimeModel, request: GenerationRequest): Promise<number[][]>
} {
  return {
    async image(model: RuntimeModel, request: GenerationRequest) {
      if (request.operation?.type !== 'image') throw new Error('An image operation is required.')
      const operation = request.operation
      const connection = resolveConnection(model)
      const payload = remoteImageGenerationPayload({
        model: model.id,
        prompt: operation.prompt,
        negativePrompt: operation.negativePrompt,
        width: operation.width,
        height: operation.height,
        steps: operation.steps,
        guidanceScale: operation.guidanceScale,
        seed: operation.seed
      })
      const source = operation.sourceImage
      let body: BodyInit
      let headers: HeadersInit | undefined
      if (source) {
        const image = imageBytes(source)
        const form = new FormData()
        for (const [key, value] of Object.entries(payload)) form.append(key, String(value))
        if (operation.strength !== undefined) form.append('strength', String(operation.strength))
        form.append(
          'image',
          new Blob([Uint8Array.from(image.bytes)], { type: image.mimeType }),
          image.name
        )
        body = form
      } else {
        body = JSON.stringify(payload)
        headers = { 'Content-Type': 'application/json' }
      }
      return remoteRequest(
        {
          connection,
          url: remoteImageEndpoint(connection.endpoint, Boolean(source)),
          init: { method: 'POST', headers, body },
          request,
          consume: async (response) => parseRemoteImageGenerationResponse(await response.json())
        },
        fetcher
      )
    },

    async transcription(model: RuntimeModel, request: GenerationRequest) {
      if (request.operation?.type !== 'transcription') {
        throw new Error('A transcription operation is required.')
      }
      const operation = request.operation
      if (operation.audio.type !== 'audio' || !operation.audio.uri) {
        throw new Error('Desktop remote transcription needs an audio file URI.')
      }
      const filePath = operation.audio.uri.startsWith('file://')
        ? operation.audio.uri.slice(7)
        : operation.audio.uri
      const bytes = await fs.promises.readFile(filePath)
      const form = new FormData()
      form.append('model', model.id)
      if (operation.language) form.append('language', operation.language)
      if (operation.prompt) form.append('prompt', operation.prompt)
      if (operation.timestamps) form.append('response_format', 'verbose_json')
      form.append(
        'file',
        new Blob([Uint8Array.from(bytes)], { type: operation.audio.mimeType || 'audio/wav' }),
        path.basename(filePath) || 'recording.wav'
      )
      const connection = resolveConnection(model)
      return remoteRequest(
        {
          connection,
          url: remoteMediaEndpoint(connection.endpoint, 'transcription'),
          init: { method: 'POST', body: form },
          request,
          consume: async (response) => parseRemoteTranscriptionResponse(await response.json())
        },
        fetcher
      )
    },

    async voice(model: RuntimeModel, request: GenerationRequest) {
      if (request.operation?.type !== 'voice') throw new Error('A voice operation is required.')
      const operation = request.operation
      const connection = resolveConnection(model)
      return remoteRequest(
        {
          connection,
          url: remoteMediaEndpoint(connection.endpoint, 'voice'),
          init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              remoteVoicePayload({
                model: model.id,
                text: operation.text,
                voice: operation.voice,
                language: operation.language
              })
            )
          },
          request,
          consume: async (response) => ({
            data: Buffer.from(await response.arrayBuffer()).toString('base64'),
            mimeType: response.headers.get('content-type')?.split(';', 1)[0] || 'audio/mpeg'
          })
        },
        fetcher
      )
    },

    async embedding(model: RuntimeModel, request: GenerationRequest) {
      if (request.operation?.type !== 'embedding') {
        throw new Error('An embedding operation is required.')
      }
      const connection = resolveConnection(model)
      return remoteRequest(
        {
          connection,
          url: remoteEmbeddingEndpoint(connection.endpoint),
          init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              remoteEmbeddingPayload({ model: model.id, inputs: request.operation.inputs })
            )
          },
          request,
          consume: async (response) => parseRemoteEmbeddingResponse(await response.json())
        },
        fetcher
      )
    }
  }
}

export const remoteMediaRuntime = createRemoteMediaRuntime()
