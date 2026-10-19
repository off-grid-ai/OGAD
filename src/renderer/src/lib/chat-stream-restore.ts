import type { ActiveChatStreamContract } from '../../../shared/ipc-contracts'
import type { ChatMessage } from '../components/MemoryChat/types'

/**
 * Rebuild a stream's message after the chat view remounts.
 *
 * Main knows only what the stream has said. Which saved answer it replaces, and that answer's
 * earlier versions, are known to the sender that started it; `live` is that sender's own view of
 * the same stream, which outlives the remount. Without it a regenerated answer would come back with
 * no versions and its replaced answer would be drawn beside it.
 */
export function restoredStreamMessage(
  stream: ActiveChatStreamContract,
  live?: ChatMessage
): ChatMessage {
  const toolCalls = (stream.tools ?? []).map((tool) => ({
    name: tool.name,
    result: tool.result ?? '',
    status: tool.status
  }))
  // In its image phase the stream no longer carries the answer: that is already saved, versions
  // and all, and the stream names the image row it will write instead.
  const answering = stream.phase !== 'loading_image_model' && stream.phase !== 'generating_image'
  const ownView = answering && live?.id === stream.streamId ? live : undefined
  const replaces = ownView?.replacementMessageId
  // A retry streams beside the saved answer it is a new version of, and is drawn in its place.
  const versionOf = ownView?.versionOf
  return {
    id: stream.streamId,
    replacementMessageId: replaces ?? stream.messageId,
    ...(versionOf ? { versionOf } : {}),
    role: 'assistant',
    content: stream.content,
    reasoning: stream.reasoning,
    reasoningRequested: stream.reasoningRequested,
    streaming: true,
    toolCalls,
    timeline: [
      ...(stream.reasoning.trim() ? [{ kind: 'thinking' as const, text: stream.reasoning }] : []),
      ...toolCalls.map((_, toolIndex) => ({ kind: 'tool' as const, toolIndex }))
    ],
    ...((replaces || versionOf) && live?.variants?.length
      ? { variants: live.variants, variantIndex: live.variantIndex ?? live.variants.length - 1 }
      : {})
  }
}

/** Put a restored stream into a conversation in place of the saved answer it replaces. */
export function withRestoredStream(previous: ChatMessage[], restored: ChatMessage): ChatMessage[] {
  const kept = previous.filter(
    (message) =>
      message.id === restored.id ||
      (message.id !== restored.replacementMessageId && message.id !== restored.versionOf)
  )
  const index = kept.findIndex((message) => message.id === restored.id)
  if (index < 0) return [...kept, restored]
  return kept.map((message, messageIndex) =>
    messageIndex === index ? { ...message, ...restored } : message
  )
}
