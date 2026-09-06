import {
  DEFAULT_IMAGE_MIME,
  generationMessageText as sharedGenerationMessageText,
  parseImageMemoryGuardError
} from '@offgrid/application'
import type {
  GenerationMessage,
  GenerationProfileKind,
  GenerationResult,
  RuntimeModel
} from '@offgrid/application'
import type {
  DesktopImageGenerationResponse,
  DesktopImageMemoryRetry
} from './desktop-chat-session-contract'

export const DESKTOP_CHAT_ROUTE: RuntimeModel = {
  id: 'active-text',
  name: 'Active text model',
  kind: 'text',
  modality: 'text',
  source: 'local',
  adapterId: 'desktop-chat-ipc',
  capabilities: {},
  installed: true,
  ready: true,
  loaded: true
}

/**
 * The kind of work a chat turn is. Shared's profile table decides fallback, partial output, and
 * timeout from it; the app names the kind and nothing else.
 */
export function desktopChatTurnProfile(
  kind: 'chat' | 'tools' | 'image' | undefined
): GenerationProfileKind {
  if (kind === 'image') return 'image-generation'
  return kind === 'tools' ? 'tool-loop' : 'chat'
}

export interface DesktopImageMemoryRefusal {
  /** The shared admission message, without its wire code. */
  message: string
  retry: DesktopImageMemoryRetry
}

/**
 * The one reading of an image failure as the shared memory refusal. Both image paths (direct and
 * tool-owned) show the same message and the same "Run anyway" affordance from this.
 */
export function imageMemoryRefusal(
  error: unknown,
  retry: DesktopImageMemoryRetry
): DesktopImageMemoryRefusal | null {
  const guard = parseImageMemoryGuardError(error)
  return guard ? { message: guard.message, retry } : null
}

export function desktopImageResult(
  response: DesktopImageGenerationResponse,
  signal: AbortSignal | undefined
): GenerationResult {
  return {
    model: {
      ...DESKTOP_CHAT_ROUTE,
      id: response.model ?? 'active-image',
      kind: 'image',
      modality: 'image'
    },
    output: {
      type: 'image',
      images: [
        {
          id: response.syncId,
          uri: response.path,
          mimeType: DEFAULT_IMAGE_MIME,
          seed: response.seed
        }
      ]
    },
    content: '',
    reasoning: '',
    toolCalls: [],
    finishReason: signal?.aborted ? 'cancelled' : 'stop',
    attemptedModelIds: [response.model ?? 'active-image'],
    attemptedRouteIds: []
  }
}

export function desktopTextResult(
  content: string,
  signal: AbortSignal | undefined,
  model: RuntimeModel = DESKTOP_CHAT_ROUTE
): GenerationResult {
  return {
    model,
    output: { type: 'text', content },
    content,
    reasoning: '',
    toolCalls: [],
    finishReason: signal?.aborted ? 'cancelled' : 'stop',
    attemptedModelIds: [model.id],
    attemptedRouteIds: model.routeId ? [model.routeId] : []
  }
}

export function desktopHistory(messages: readonly GenerationMessage[]): Array<{
  role: string
  content: string
}> {
  return messages.slice(0, -1).flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return []
    return [{ role: message.role, content: generationMessageText(message) }]
  })
}

function generationMessageText(message: GenerationMessage): string {
  return sharedGenerationMessageText(message)
}
