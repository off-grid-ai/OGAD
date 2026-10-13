import type { ActiveChatStreamContract } from '../../../shared/ipc-contracts'
import type { ChatMessage } from '../components/MemoryChat/types'

export function restoredStreamMessage(stream: ActiveChatStreamContract): ChatMessage {
  const toolCalls = (stream.tools ?? []).map((tool) => ({
    name: tool.name,
    result: tool.result ?? '',
    status: tool.status
  }))
  return {
    id: stream.streamId,
    replacementMessageId: stream.messageId,
    role: 'assistant',
    content: stream.content,
    reasoning: stream.reasoning,
    reasoningRequested: stream.reasoningRequested,
    streaming: true,
    toolCalls,
    timeline: [
      ...(stream.reasoning.trim() ? [{ kind: 'thinking' as const, text: stream.reasoning }] : []),
      ...toolCalls.map((_, toolIndex) => ({ kind: 'tool' as const, toolIndex }))
    ]
  }
}
