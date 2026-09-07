import type http from 'node:http'
import { modelControlSurfaceForKind, modelsFailureMessage } from '@offgrid/application'
import { desktopModels } from '../composition/application-access'

type JsonResponse = (response: http.ServerResponse, status: number, body: unknown) => void
type JsonReader = (request: http.IncomingMessage) => Promise<Record<string, unknown>>
type HandlerInput = {
  request: http.IncomingMessage
  response: http.ServerResponse
  url: string
  method: string
  readJson: JsonReader
  respond: JsonResponse
}
type Control = ReturnType<typeof desktopModels.snapshot>['control']

async function handleActivation(input: HandlerInput, control: Control): Promise<void> {
  const { id, kind } = await input.readJson(input.request)
  if (!id) return input.respond(input.response, 400, { error: 'id required' })
  const model = control.models.find((row) => row.id === String(id))
  const requestedKind = typeof kind === 'string' ? kind : model?.kind
  if (requestedKind === undefined) {
    return input.respond(input.response, 404, { error: `unknown model: ${String(id)}` })
  }
  const surface = modelControlSurfaceForKind(requestedKind)
  if (!surface) {
    return input.respond(input.response, 400, {
      error: `unsupported model kind: ${requestedKind}`
    })
  }
  const activated = await desktopModels.control({
    type: 'activate',
    modelId: String(id),
    surface
  })
  return activated.ok
    ? input.respond(input.response, 200, activated.value)
    : input.respond(input.response, 400, { error: modelsFailureMessage(activated.failure) })
}

function handlePullStatus(input: HandlerInput, control: Control): void {
  const id = (input.request.url || '').split('?')[1]?.match(/(?:^|&)id=([^&]+)/)?.[1]
  input.respond(
    input.response,
    200,
    control.downloads.find((download) => download.modelId === decodeURIComponent(id || '')) ?? {
      status: 'idle'
    }
  )
}

async function handlePull(input: HandlerInput): Promise<void> {
  const { id } = await input.readJson(input.request)
  if (!id) return input.respond(input.response, 400, { error: 'id required' })
  const started = await desktopModels.control({ type: 'download', modelId: String(id) })
  if (!started.ok) {
    return input.respond(input.response, 400, { error: modelsFailureMessage(started.failure) })
  }
  input.respond(input.response, 202, {
    status: 'started',
    id,
    poll: `/v1/models/pull/status?id=${encodeURIComponent(String(id))}`
  })
}

async function handleCancel(input: HandlerInput): Promise<void> {
  const { id } = await input.readJson(input.request)
  const cancelled = await desktopModels.control({ type: 'cancel-download', modelId: String(id) })
  if (!cancelled.ok) {
    return input.respond(input.response, 400, { error: modelsFailureMessage(cancelled.failure) })
  }
  input.respond(input.response, 200, { cancelled: cancelled.value.status === 'cancelled' })
}

async function handleDelete(input: HandlerInput): Promise<void> {
  const { id } = await input.readJson(input.request)
  if (!id) return input.respond(input.response, 400, { error: 'id required' })
  await removeModel(input, String(id))
}

async function handleExactRoute(input: HandlerInput, control: Control): Promise<boolean> {
  switch (`${input.method} ${input.url}`) {
    case 'GET /v1/models/catalog':
      input.respond(input.response, 200, { kinds: control.kinds, models: control.models })
      return true
    case 'GET /v1/models/installed':
      input.respond(input.response, 200, { installed: control.installed })
      return true
    case 'GET /v1/models/active':
      input.respond(input.response, 200, control.active)
      return true
    case 'GET /v1/models/pull/status': {
      handlePullStatus(input, control)
      return true
    }
    case 'POST /v1/models/pull': {
      await handlePull(input)
      return true
    }
    case 'POST /v1/models/cancel': {
      await handleCancel(input)
      return true
    }
    case 'POST /v1/models/activate':
      await handleActivation(input, control)
      return true
    case 'POST /v1/models/delete': {
      await handleDelete(input)
      return true
    }
    default:
      return false
  }
}

async function removeModel(input: HandlerInput, id: string): Promise<void> {
  const removed = await desktopModels.control({ type: 'remove', modelId: id })
  return removed.ok
    ? input.respond(input.response, 200, removed.value)
    : input.respond(input.response, 400, { error: modelsFailureMessage(removed.failure) })
}

export async function handleModelManagement(input: HandlerInput): Promise<void> {
  try {
    if (await handleExactRoute(input, desktopModels.snapshot().control)) return
    if (
      input.method === 'DELETE' &&
      input.url.startsWith('/v1/models/') &&
      input.url !== '/v1/models/'
    ) {
      await removeModel(input, decodeURIComponent(input.url.slice('/v1/models/'.length)))
      return
    }
    input.respond(input.response, 404, { error: 'unknown model endpoint' })
  } catch (error) {
    input.respond(input.response, 500, { error: (error as Error).message })
  }
}
