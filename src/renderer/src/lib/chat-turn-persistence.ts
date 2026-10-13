import type { ChatMessage, RagContext } from '../components/MemoryChat/types'
import type { ResponseCutoffContract } from '../../../shared/ipc-contracts'
import { buildAssistantContext, type AssistantTimelineEntry } from './message-persistence'
import { answerVersion } from './chat-versions'
type Ref<T> = { current: T }
export interface TurnPersistence {
  streamConvRef: Ref<Map<string, string>>
  messagesByConvRef: Ref<Record<string, ChatMessage[]>>
  reasoningByStream: Ref<Record<string, string>>
  timelineByStream: Ref<Record<string, AssistantTimelineEntry[]>>
  toolCallsByStream: Ref<Record<string, NonNullable<ChatMessage['toolCalls']>>>
  answerByStream: Ref<Record<string, string>>
  setConvMessages: (cid: string, update: (previous: ChatMessage[]) => ChatMessage[]) => void
  api: Pick<Window['api'], 'updateRagMessage' | 'addRagMessage'>
}
export interface TurnSettlement {
  answer?: string
  context?: RagContext
  persistContext?: Record<string, unknown>
  cutoff?: ResponseCutoffContract
  toolCalls?: ChatMessage['toolCalls']
  toolsOffered?: ChatMessage['toolsOffered']
}

/** Pure projection shared by Stop and terminal streams reattached without a sender. */
export function observedAnswer(
  current: ChatMessage | undefined,
  snapshot: Pick<ChatMessage, 'id' | 'content' | 'reasoning' | 'timeline' | 'toolCalls'>,
  settled: TurnSettlement = {},
  status: ChatMessage['turnStatus'] = 'cancelled'
): ChatMessage {
  const answer: ChatMessage = {
    ...current,
    id: snapshot.id,
    role: 'assistant',
    content: (settled.answer ?? snapshot.content).trim(),
    reasoning: snapshot.reasoning?.trim() || undefined,
    timeline: snapshot.timeline ?? current?.timeline,
    context: settled.context ?? current?.context,
    cutoff: settled.cutoff ?? current?.cutoff,
    toolCalls: settled.toolCalls ?? snapshot.toolCalls ?? current?.toolCalls,
    toolsOffered: settled.toolsOffered ?? current?.toolsOffered,
    turnStatus: status,
    streaming: false,
    activity: undefined
  }
  const variants = current?.variants
    ? [...current.variants.slice(0, -1), answerVersion(answer)]
    : undefined
  const variantIndex = variants ? variants.length - 1 : undefined
  const context = buildAssistantContext(
    {
      ...(settled.persistContext ?? answer.context),
      ...(answer.toolCalls?.length ? { toolCalls: answer.toolCalls } : {}),
      ...(answer.toolsOffered?.length ? { toolsOffered: answer.toolsOffered } : {}),
      status
    },
    {
      reasoning: answer.reasoning,
      timeline: answer.timeline,
      cutoff: answer.cutoff,
      metrics: answer.metrics,
      variants,
      variantIndex
    }
  )
  return { ...answer, variants, variantIndex, context }
}

// The API is shared by mounted views and senders that survive navigation. Local
// stream maps are routing state; they cannot arbitrate two observers of one run.
const finalizedTurns = new WeakMap<TurnPersistence['api'], Map<string, Promise<ChatMessage>>>()
const FINALIZED_TURN_GRACE_MS = 5_000

/** Inspect retained claims without exposing their messages or allowing mutation. */
export function retainedFinalizedTurnCount(api: TurnPersistence['api']): number {
  return finalizedTurns.get(api)?.size ?? 0
}

export async function persistObservedTurn(
  dependencies: TurnPersistence,
  convId: string,
  streamId: string,
  settled?: TurnSettlement,
  status: ChatMessage['turnStatus'] = 'cancelled'
): Promise<void> {
  const d = dependencies
  let turns = finalizedTurns.get(d.api)
  if (!turns) {
    turns = new Map()
    finalizedTurns.set(d.api, turns)
  }
  const key = JSON.stringify([convId, streamId])
  const existing = turns.get(key)
  if (existing) {
    d.streamConvRef.current.delete(streamId)
    const answer = await existing
    // A separate view can still have the temporary row. Retire it without
    // appending another copy of the saved answer.
    d.setConvMessages(convId, (previous) => {
      if (!previous.some((message) => message.id === streamId)) return previous
      const withoutStream = previous.filter((message) => message.id !== streamId)
      return withoutStream.some((message) => message.id === answer.id)
        ? withoutStream
        : previous.map((message) => (message.id === streamId ? answer : message))
    })
    return
  }
  if (d.streamConvRef.current.get(streamId) !== convId) return
  // Claim synchronously before any persistence or message update can notify peers.
  const finalizing = Promise.resolve().then(() =>
    saveObservedTurn(d, convId, streamId, settled, status)
  )
  turns.set(key, finalizing)
  try {
    await finalizing
  } finally {
    // Keep the claim while saving and briefly after settlement so Stop and the
    // terminal observer share one save, including across a remount.
    setTimeout(() => {
      if (turns.get(key) === finalizing) turns.delete(key)
    }, FINALIZED_TURN_GRACE_MS)
  }
}

async function saveObservedTurn(
  d: TurnPersistence,
  convId: string,
  streamId: string,
  settled: TurnSettlement | undefined,
  status: ChatMessage['turnStatus']
): Promise<ChatMessage> {
  d.streamConvRef.current.delete(streamId)
  const current = (d.messagesByConvRef.current[convId] ?? []).find(
    (message) => message.id === streamId
  )
  const answer = observedAnswer(
    current,
    {
      id: streamId,
      content: d.answerByStream.current[streamId] ?? '',
      reasoning: d.reasoningByStream.current[streamId],
      timeline: d.timelineByStream.current[streamId],
      toolCalls: d.toolCallsByStream.current[streamId]
    },
    settled,
    status
  )
  delete d.reasoningByStream.current[streamId]
  delete d.timelineByStream.current[streamId]
  delete d.toolCallsByStream.current[streamId]
  delete d.answerByStream.current[streamId]
  d.setConvMessages(convId, (previous) =>
    previous.some((message) => message.id === streamId)
      ? previous.map((message) => (message.id === streamId ? answer : message))
      : [...previous, answer]
  )
  try {
    const savedId = current?.replacementMessageId ?? streamId
    const updated = await d.api.updateRagMessage(convId, savedId, answer.content, answer.context)
    const storedId = updated
      ? savedId
      : (await d.api.addRagMessage(convId, 'assistant', answer.content, answer.context)).uuid
    const storedAnswer = { ...answer, id: storedId, replacementMessageId: undefined }
    d.setConvMessages(convId, (previous) =>
      previous.map((message) => (message.id === streamId ? storedAnswer : message))
    )
    return storedAnswer
  } catch (error) {
    console.error('Failed to persist observed assistant message:', error)
    return answer
  }
}
