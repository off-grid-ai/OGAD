import type { ChatMessage, RagContext } from '../components/MemoryChat/types'
import type { AnswerVersion, ResponseVersion } from '../../../shared/chat-versions'
import {
  buildAssistantContext,
  readAssistantTimeline,
  readGenerationMetrics,
  readReasoning,
  readResponseCutoff
} from './message-persistence'

export function answerVersion(message: ChatMessage): AnswerVersion {
  const context = buildAssistantContext(
    {
      ...message.context,
      toolCalls: message.toolCalls,
      toolsOffered: message.toolsOffered,
      status: message.turnStatus,
      reasoningLabel: message.reasoningLabel,
      generationTimeMs: message.generationTimeMs
    },
    {
      reasoning: message.reasoning,
      timeline: message.timeline,
      metrics: message.metrics,
      cutoff: message.cutoff
    }
  )!
  delete context.variants
  delete context.variantIndex
  const {
    id: _id,
    role: _role,
    content: _content,
    variants: _variants,
    variantIndex: _index,
    streaming: _streaming,
    activity: _activity,
    replacementMessageId: _replacement,
    ...fields
  } = message
  return { content: message.content, context, fields: { ...fields, context } }
}

/** Capture the current answer too, including legacy text-only versions. */
export function priorAnswerVersions(
  message: ChatMessage | undefined
): ResponseVersion[] | undefined {
  if (!message) return undefined
  const versions = [...(message.variants ?? [message.content])]
  versions[message.variantIndex ?? versions.length - 1] = answerVersion(message)
  return versions
}

export function appendAnswerVersion(
  prior: ResponseVersion[] | undefined,
  message: ChatMessage
): ResponseVersion[] | undefined {
  return prior ? [...prior, answerVersion(message)] : undefined
}

/** One projection supplies UI, durable content, and model history. */
export function selectAnswerVersion(message: ChatMessage, direction: number): ChatMessage {
  if (!message.variants?.length) return message
  const variants = [...message.variants]
  const currentIndex = message.variantIndex ?? variants.length - 1
  // Capture fields added after the model ended (for example deferred images).
  variants[currentIndex] = answerVersion(message)
  const variantIndex = Math.max(0, Math.min(message.variants.length - 1, currentIndex + direction))
  const version = variants[variantIndex]!
  // Old versions have no metadata; do not show the newest answer's metadata under them.
  const context =
    typeof version === 'string'
      ? version === message.content
        ? (answerVersion(message).context ?? {})
        : {}
      : (version.context ?? {})
  return {
    ...message,
    image: undefined,
    imagePath: undefined,
    imageMetadata: undefined,
    attachments: undefined,
    audioUrl: undefined,
    audioDuration: undefined,
    ...(typeof version === 'string'
      ? version === message.content
        ? message
        : {}
      : (version.fields as Partial<ChatMessage>)),
    content: typeof version === 'string' ? version : version.content,
    context: { ...context, variants, variantIndex } as RagContext,
    variants,
    variantIndex,
    reasoning: readReasoning(context),
    timeline: readAssistantTimeline(context),
    metrics: readGenerationMetrics(context),
    cutoff: readResponseCutoff(context),
    toolCalls: context.toolCalls as ChatMessage['toolCalls'],
    toolsOffered: context.toolsOffered as ChatMessage['toolsOffered'],
    turnStatus: context.status as ChatMessage['turnStatus'],
    reasoningLabel: context.reasoningLabel as ChatMessage['reasoningLabel'],
    generationTimeMs: context.generationTimeMs as ChatMessage['generationTimeMs']
  }
}

/** Failed replacement adds a version without losing the saved answer's context. */
export function failedAnswerVersion(
  previous: ChatMessage | undefined,
  content: string,
  prior?: ResponseVersion[]
): ChatMessage {
  const failed: ChatMessage = { id: previous?.id ?? '', role: 'assistant', content }
  const variants = appendAnswerVersion(prior, failed)
  if (previous && variants) {
    return {
      ...previous,
      variants,
      streaming: false,
      context: buildAssistantContext(answerVersion(previous).context, {
        variants,
        variantIndex: previous.variantIndex ?? prior!.length - 1
      }),
      variantIndex: previous.variantIndex ?? prior!.length - 1
    }
  }
  return {
    ...failed,
    variants,
    variantIndex: variants ? variants.length - 1 : undefined,
    context: buildAssistantContext(undefined, {
      variants,
      variantIndex: variants ? variants.length - 1 : undefined
    })
  }
}
