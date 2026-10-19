import type { ChatMessage } from '../components/MemoryChat/types'
import { selectAnswerVersion } from './chat-versions'

/**
 * The version arrows belong to the reply that closes a turn whenever it has more than one version,
 * including while its newest version is still streaming and after a Stop that kept only thinking.
 */
export function answerVersionsNavigable(
  message: ChatMessage,
  nextMessageRole: string | undefined
): boolean {
  return (
    message.role === 'assistant' &&
    !message.notice &&
    (message.threadVersions?.count ?? message.variants?.length ?? 0) > 1 &&
    nextMessageRole !== 'assistant' &&
    nextMessageRole !== 'tool'
  )
}

/** Index of the version being generated: the newest one. */
function liveVersionIndex(message: ChatMessage): number {
  return message.variantIndex ?? (message.variants?.length ?? 1) - 1
}

/**
 * The version a reader is looking at while the newest one streams. Earlier versions are read-only
 * projections; the streaming row itself is never rewritten, so tokens keep filling the live version.
 */
export function liveAnswerVersionView(
  message: ChatMessage,
  viewedIndex: number | null
): ChatMessage {
  if (!message.streaming || !message.variants?.length || viewedIndex === null) return message
  const liveIndex = liveVersionIndex(message)
  if (viewedIndex >= liveIndex) return message
  const earlier = selectAnswerVersion(message, Math.max(0, viewedIndex) - liveIndex)
  return { ...earlier, streaming: false, activity: undefined, reasoningRequested: undefined }
}

/** The next version to show while the newest one streams; `null` means the live version. */
export function nextLiveVersionIndex(
  message: ChatMessage,
  viewedIndex: number | null,
  direction: -1 | 1
): number | null {
  const liveIndex = liveVersionIndex(message)
  const next = Math.max(0, Math.min(liveIndex, (viewedIndex ?? liveIndex) + direction))
  return next >= liveIndex ? null : next
}
