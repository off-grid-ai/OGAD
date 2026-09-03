// Pure reducer for a streaming chat message: given the message and one stream event,
// return the updated message. Extracted from the onRagStream handler so every arm —
// including tool_result (completed tool calls accumulate live + persist) — is unit-tested
// without mounting the chat.

import {
  completeChatStreamTool,
  startChatStreamTool,
  type ChatStreamTool
} from '@offgrid/application'

export interface StreamEvent {
  type: 'content' | 'reasoning' | 'step' | 'tool_result' | 'route' | 'fallback' | 'done'
  text?: string
  step?: unknown
  call?: { name: string; result: string; status: 'completed' | 'failed' | 'pending' }
}

export interface StreamedMessage {
  content?: string
  reasoning?: string
  toolCalls?: {
    name: string
    result: string
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  }[]
  activity?: unknown
}

/** A completed tool result can arrive before the chat model writes its final
 * sentence. Do not present the completed tool as live work during that phase. */
export function hasLiveStreamActivity(message: StreamedMessage): boolean {
  const activity = message.activity as { kind?: unknown } | undefined
  if (activity?.kind === 'running_tool') return true
  const tools = message.toolCalls ?? []
  if (tools.length === 0) return true
  return tools.some((tool) => tool.status === 'pending' || tool.status === 'running')
}

export function applyStreamEvent<T extends StreamedMessage>(m: T, e: StreamEvent): T {
  if (e.type === 'done') return m
  if (e.type === 'content') {
    // Answer tokens clear the live "Running…" activity as the reply takes over.
    return { ...m, content: (m.content || '') + (e.text || ''), activity: undefined }
  }
  if (e.type === 'reasoning') {
    return { ...m, reasoning: (m.reasoning || '') + (e.text || '') }
  }
  if (e.type === 'tool_result' && e.call) {
    return {
      ...m,
      activity: undefined,
      toolCalls: fromPortableTools(
        completeChatStreamTool(
          toPortableTools(m.toolCalls),
          e.call.name,
          e.call.result,
          e.call.status
        )
      )
    }
  }
  // 'step' — publish the tool row before it has a result. This is the first event that says the
  // model chose a tool, so waiting for tool_result makes the UI appear late by definition.
  const toolName = runningToolName(e.step)
  return {
    ...m,
    activity: e.step,
    ...(toolName
      ? {
          toolCalls: fromPortableTools(startChatStreamTool(toPortableTools(m.toolCalls), toolName))
        }
      : {})
  }
}

function runningToolName(step: unknown): string | null {
  if (!step || typeof step !== 'object') return null
  const record = step as { kind?: unknown; name?: unknown }
  return record.kind === 'running_tool' && typeof record.name === 'string' && record.name
    ? record.name
    : null
}

function toPortableTools(tools: StreamedMessage['toolCalls']): ChatStreamTool[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    status:
      tool.status === 'running'
        ? 'running'
        : tool.status === 'failed'
          ? 'failed'
          : tool.status === 'pending' || tool.status === 'cancelled'
            ? 'pending'
            : 'completed',
    ...(tool.result ? { result: tool.result } : {})
  }))
}

function fromPortableTools(
  tools: readonly ChatStreamTool[]
): NonNullable<StreamedMessage['toolCalls']> {
  return tools.map((tool) => ({
    name: tool.name,
    result: tool.result ?? '',
    status: tool.status
  }))
}
