import type { ChatMessage } from '../components/MemoryChat/types'
import type { AssistantTimelineEntry } from './message-persistence'
import type { ChatQueues, QueuedTurn } from './chat-queue-store'
import type { TurnPersistence } from './chat-turn-persistence'
import { clearQueue } from './chat-queue'
import { matchesRunCancel } from './chat-run-lifecycle'
export type RunEvent = {
  action: 'query' | 'attach' | 'detach' | 'cancel' | 'started' | 'settled'
  conversationId: string
  owner?: Map<string, string>
  claimed?: boolean
  conversations?: string[]
  preserveQueue?: boolean
  runId?: string
  messages?: ChatMessage[]
  queue?: QueuedTurn[]
  stream?: {
    id: string
    answer: string
    reasoning: string
    timeline?: AssistantTimelineEntry[]
    tools?: ChatMessage['toolCalls']
  }
}
export function observeOwnedRun(
  detail: RunEvent,
  convId: string,
  runId: string,
  dependencies: Pick<
    TurnPersistence,
    'answerByStream' | 'reasoningByStream' | 'timelineByStream' | 'toolCallsByStream'
  > & {
    cancelledRef: { current: Set<string> }
    queuedRef: { current: ChatQueues }
    setQueuedByConv: (queues: ChatQueues) => void
    cancelRag: (id: string) => void
    activeStream?: () => string | undefined
  }
): void {
  const {
    cancelledRef,
    queuedRef,
    setQueuedByConv,
    answerByStream,
    reasoningByStream,
    timelineByStream,
    toolCallsByStream,
    cancelRag,
    activeStream
  } = dependencies
  if (detail.action === 'query' && detail.conversationId === '*') {
    detail.conversations?.push(convId)
    return
  }
  if (
    detail.conversationId !== convId ||
    detail.action === 'settled' ||
    detail.action === 'started'
  )
    return
  // A remounted view knows the native stream id, not the sender reservation id.
  if (
    detail.action === 'cancel' &&
    !matchesRunCancel(detail.runId, runId) &&
    !matchesRunCancel(detail.runId, activeStream?.() ?? runId)
  )
    return
  detail.claimed = true
  // A reattached view must address the surviving sender, including image jobs
  // whose native image:<conversation> stream is not the sender's reservation.
  if (detail.action === 'attach') detail.owner?.set(runId, convId)
  if (detail.action !== 'cancel') return
  cancelledRef.current.add(convId)
  if (runId.startsWith('prepare-')) cancelledRef.current.add(runId)
  const streamId = activeStream?.()
  if (streamId) cancelRag(streamId)
  if (!detail.preserveQueue) {
    queuedRef.current = clearQueue(queuedRef.current, convId)
    setQueuedByConv({ ...queuedRef.current })
  }
  if (detail.stream) {
    const { id, answer, reasoning, timeline, tools } = detail.stream
    answerByStream.current[id] = answer
    reasoningByStream.current[id] = reasoning
    if (timeline) timelineByStream.current[id] = timeline
    if (tools) toolCallsByStream.current[id] = tools
  }
}
