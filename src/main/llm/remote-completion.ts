import {
  maxTokensForLlamaServer,
  resolveMaxTokens,
  type ReasoningWireFragment
} from '@offgrid/models'
import { streamRemoteChatCompletion, type RemoteTextModelConnection } from './remote-chat'
import type { StreamResult } from './stream'

export function completeRemoteChat(input: {
  remote: RemoteTextModelConnection
  messages: unknown[]
  onDelta: (text: string, kind: 'content' | 'reasoning') => void
  options: {
    timeoutMs?: number
    maxTokens?: number
    temperature?: number
    topP?: number
    thinking?: boolean
    reasoningWire?: ReasoningWireFragment
    signal?: AbortSignal
    responseFormat?: unknown
    tools?: unknown[]
    toolChoice?: unknown
  }
  settings: {
    maxTokens: number
    temperature: number
    topP?: number
    reasoningBudget: number
  }
}): Promise<StreamResult> {
  return streamRemoteChatCompletion({
    remote: input.remote,
    request: {
      messages: input.messages,
      maxTokens: maxTokensForLlamaServer(
        resolveMaxTokens(input.options.maxTokens, input.settings.maxTokens)
      ),
      temperature: input.options.temperature ?? input.settings.temperature,
      topP: input.options.topP ?? input.settings.topP,
      thinking: input.options.thinking,
      reasoningWire: input.options.reasoningWire,
      reasoningBudget: input.settings.reasoningBudget,
      responseFormat: input.options.responseFormat,
      tools: input.options.tools,
      toolChoice: input.options.toolChoice
    },
    onDelta: input.onDelta,
    options: { signal: input.options.signal, timeoutMs: input.options.timeoutMs }
  })
}
