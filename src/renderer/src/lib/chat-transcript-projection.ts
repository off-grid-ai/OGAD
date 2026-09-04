// Durable chat records -> transcript messages. The shared projection
// (projectSyncedMessageTurn) decides what a synced turn IS; this module reads the desktop
// row shape around it and rebuilds the session turns a resend replays. Pure: no React, no
// window, no state, so both the reload path and the tests exercise the same functions.
import {
  isPromptEnhancementStatus,
  projectSyncedMessageTurn,
  type ChatTurn,
  type SyncedMessageRole
} from '@offgrid/application'
import { captureUrlForPath } from '../../../shared/ogcapture-url'
import { readGeneratedImageReference } from '../../../shared/generated-image-reference'
import {
  readGenerationMetrics,
  readPersistedChatSessionTurn,
  readReasoning,
  readResponseCutoff
} from './message-persistence'
import { desktopChatTurnProfile } from './desktop-chat-session-policy'
import type { ChatMessage, RagContext } from './chat-transcript-types'

export function parseRagContext(context: unknown): RagContext | undefined {
  if (typeof context === 'string') {
    try {
      return JSON.parse(context) as RagContext
    } catch {
      return undefined
    }
  }
  return context && typeof context === 'object' ? (context as RagContext) : undefined
}

export type RawRagMessage = {
  uuid?: unknown
  id?: unknown
  role: SyncedMessageRole
  content: string
  context?: unknown
  created_at?: string
  origin_device_id?: unknown
  origin_device_name?: unknown
}

export function readRagProvenance(message: RawRagMessage): ChatMessage['provenance'] {
  if (
    typeof message.origin_device_id !== 'string' ||
    typeof message.origin_device_name !== 'string'
  ) {
    return undefined
  }
  return {
    originDeviceId: message.origin_device_id,
    originDeviceName: message.origin_device_name
  }
}

export function promptEnhancementMessage(
  message: RawRagMessage,
  provenance: ChatMessage['provenance']
): ChatMessage | undefined {
  if (message.role !== 'assistant' || !isPromptEnhancementStatus(message.content)) return undefined
  const id = String(message.uuid ?? message.id ?? '')
  return id ? { id, role: 'assistant', content: message.content, provenance } : undefined
}

export function shouldHideProjectedTurn(
  turn: ReturnType<typeof projectSyncedMessageTurn>
): boolean {
  return Boolean(
    turn &&
    turn.role === 'assistant' &&
    !(turn.answer ?? turn.content).trim() &&
    turn.reasoning === undefined
  )
}

export type ProjectedTurn = NonNullable<ReturnType<typeof projectSyncedMessageTurn>>

export function projectedTurnContent(turn: ProjectedTurn): string {
  if (turn.role !== 'assistant') return turn.content
  return turn.answer ?? turn.content
}

export function projectedTurnTools(turn: ProjectedTurn): Partial<ChatMessage> {
  if (turn.role === 'assistant') {
    return {
      toolCalls: turn.tools.length > 0 ? turn.tools : undefined,
      generationTimeMs: turn.durationMs
    }
  }
  if (turn.role === 'tool') {
    return {
      toolName: turn.tools[0]?.name,
      toolCallId: turn.tools[0]?.id,
      generationTimeMs: turn.tools[0]?.durationMs
    }
  }
  return { generationTimeMs: turn.durationMs }
}

export function projectChatMessage(turn: ProjectedTurn, context?: RagContext): ChatMessage {
  const imageReference = readGeneratedImageReference(context)
  return {
    id: turn.id,
    role: turn.role,
    content: projectedTurnContent(turn),
    context,
    reasoning: turn.reasoning ?? readReasoning(context),
    cutoff: readResponseCutoff(context),
    metrics: readGenerationMetrics(context),
    ...projectedTurnTools(turn),
    turnStatus: turn.status,
    notice: turn.notice,
    reasoningLabel: turn.reasoningLabel,
    provenance: turn.provenance,
    image: imageReference ? captureUrlForPath(imageReference.path) : undefined,
    imagePath: imageReference?.path,
    imageMetadata: context?.imageMetadata,
    attachments: Array.isArray(context?.attachments) ? context.attachments : undefined
  }
}

export function mapRagMessage(message: RawRagMessage): ChatMessage[] {
  const context = parseRagContext(message.context)
  const provenance = readRagProvenance(message)
  // Shared excludes this temporary row from the portable answer projection. Desktop still needs
  // the local row until the same UUID becomes the durable Enhanced prompt disclosure.
  const promptEnhancement = promptEnhancementMessage(message, provenance)
  if (promptEnhancement) return [promptEnhancement]
  const turn = projectSyncedMessageTurn({
    id: String(message.uuid ?? message.id),
    role: message.role,
    content: message.content,
    context: message.context,
    createdAt: message.created_at,
    provenance
  })
  if (!turn || shouldHideProjectedTurn(turn)) return []
  // Mobile tool turns can persist a delimiter-only intermediate assistant row before the
  // tool result and final answer. It carries no thought content and must not become a visible
  // "<think> </think>" bubble on Desktop.
  // A turn with nothing in it is not a bubble. Mobile's tool loop persists a delimiter-only
  // assistant row before the tool result and the final answer; it used to arrive as the literal
  // "<think></think>" and was matched as that string. The shared projection now splits inline
  // reasoning out, so the same row arrives empty instead - test emptiness, which covers both and
  // any other way a turn can carry nothing.
  return [projectChatMessage(turn, context)]
}

export function mapRagMessages(raw: RawRagMessage[]): ChatMessage[] {
  return raw.flatMap<ChatMessage>(mapRagMessage)
}

export function restoredChatSessionTurns(
  conversationId: string,
  raw: readonly RawRagMessage[]
): ChatTurn[] {
  let userMessage: RawRagMessage | undefined
  return raw.flatMap((message) => {
    if (message.role === 'user') {
      userMessage = message
      return []
    }
    if (message.role !== 'assistant' || !userMessage) return []
    const session = readPersistedChatSessionTurn(parseRagContext(message.context))
    if (!session) return []
    const imageOperation = session.responseMessages.some(
      (response) =>
        Array.isArray(response.content) && response.content.some((part) => part.type === 'image')
    )
    return [
      {
        id: session.turnId,
        conversationId,
        userMessage: { role: 'user', content: userMessage.content },
        responseMessages: session.responseMessages,
        status: session.status,
        request: {
          operation: imageOperation
            ? { type: 'image', prompt: userMessage.content }
            : { type: 'text' },
          request: { profile: desktopChatTurnProfile(imageOperation ? 'image' : 'chat') }
        }
      }
    ]
  })
}

/** Durable reloads replace durable rows but cannot erase a main-owned active stream. */
export function mergeDurableAndStreaming(
  durable: ChatMessage[],
  current: ChatMessage[]
): ChatMessage[] {
  const durableIds = new Set(durable.map((message) => message.id))
  const active = current.filter(
    (message) => message.streaming === true && !durableIds.has(message.id)
  )
  return [...durable, ...active]
}
