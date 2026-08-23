// What this device is generating right now, as ONE fact other subsystems can observe.
//
// Chat tokens are streamed to the renderer for display and are accumulated there. Anything else that
// wants to follow a reply as it forms - live streaming to paired devices, most obviously - would
// otherwise have to re-accumulate them from its own tap on the same deltas, and would drift the first
// time a code path was added or a buffer reset.
//
// So the deltas are folded up here, once, and published as a snapshot: the conversation being
// answered and the cumulative text so far, or null when nothing is generating. Emitting the snapshot
// (not the delta) is what makes a consumer's job total - it cannot miss a "stream ended" event,
// because ending IS a snapshot.

import { callHook, HOOKS } from './bootstrap/hookRegistry'
import {
  completeChatStreamTool,
  startChatStreamTool,
  type ChatStreamCompletion,
  type ChatStreamPhase,
  type ChatStreamProgress,
  type ChatStreamTool
} from '@offgrid/sync'
import type { ActiveChatStreamContract } from '../shared/ipc-contracts'

interface ActiveStream {
  conversationId: string
  content: string
  reasoning: string
  phase: ChatStreamPhase
  progress?: ChatStreamProgress
  tools?: ChatStreamTool[]
  /**
   * The id this reply will be STORED under, when the caller named it before the first token.
   *
   * Published with every snapshot, so a paired device's live preview and the durable record that
   * follows share one identity - which is what lets the preview be retired the moment the record
   * lands instead of standing beside it until it times out.
   */
  messageId?: string
}

const active = new Map<string, ActiveStream>()

/** Current cumulative streams. Main owns them, so renderer navigation cannot erase them. */
export function activeChatStreamSnapshots(): ActiveChatStreamContract[] {
  return [...active.entries()].map(([streamId, stream]) => ({
    streamId,
    conversationId: stream.conversationId,
    messageId: stream.messageId,
    content: stream.content,
    reasoning: stream.reasoning,
    phase: stream.phase,
    ...(stream.tools?.length ? { tools: stream.tools.map((tool) => ({ ...tool })) } : {})
  }))
}

/**
 * The identity minted for a conversation's current reply, until its stored record claims it.
 *
 * Deliberately OUTLIVES the stream. The turn ends in this process the moment the model stops, while
 * the record is written afterwards by the renderer over IPC - so an identity discarded on `end` is
 * always gone before the thing that needs it asks. Keyed by conversation because chat generation is
 * serialised through one queue: a conversation has at most one reply forming at a time.
 */
const pendingMessageIds = new Map<string, string>()

/**
 * Attach a conversation to a stream id, before any delta arrives, and name the reply it will become.
 *
 * Deltas are keyed by stream id because that is all the streaming transport knows; the conversation
 * is known only by the handler that started the turn. A stream that is never bound simply publishes
 * nothing - an unattributed reply has no conversation to appear in.
 *
 * The id is minted HERE, in the one place that already knows a reply has started, rather than being
 * passed in by each caller that persists one. A caller that has to remember to thread an id is a
 * caller that can forget, and every site that forgot would silently go back to being drawn twice on
 * a paired device.
 */
export function bindChatStream(
  streamId: string | undefined,
  conversationId?: string,
  phase: ChatStreamPhase = 'waiting'
): void {
  if (!streamId || !conversationId) return
  // A new reply supersedes any identity still unclaimed for this conversation - the previous turn was
  // cancelled or failed before it ever became a record, so nothing is going to claim it.
  const messageId = crypto.randomUUID()
  pendingMessageIds.set(conversationId, messageId)
  active.set(streamId, { conversationId, content: '', reasoning: '', phase, messageId })
  publish(streamId)
}

/**
 * Claim the identity minted for this conversation's reply, so its record keeps the id its live
 * frames already carried on every paired device.
 *
 * Take-once: the first record to conclude the turn claims it, and anything written afterwards gets a
 * fresh id of its own. Returns undefined when nothing was streamed - a message typed into a
 * conversation with no generation behind it is simply new, and mints its own id as it always did.
 */
export function takeChatStreamMessageId(conversationId: string): string | undefined {
  const messageId = pendingMessageIds.get(conversationId)
  if (messageId !== undefined) pendingMessageIds.delete(conversationId)
  return messageId
}

/**
 * Read the identity of the reply that is still forming, without claiming it.
 *
 * Image generation needs this before it publishes the generated file. The later message write still
 * claims the same id through `takeChatStreamMessageId`, so the live preview, file control and durable
 * message all name one reply from the start.
 */
export function currentChatStreamMessageId(
  conversationId: string | null | undefined
): string | undefined {
  return conversationId ? pendingMessageIds.get(conversationId) : undefined
}

/** Fold one delta into the reply so far and publish the result. */
export function noteChatStreamDelta(
  streamId: string | undefined,
  text: string,
  kind: 'content' | 'reasoning'
): void {
  if (!streamId) return
  const stream = active.get(streamId)
  if (!stream) return
  if (kind === 'reasoning') {
    stream.reasoning += text
    stream.phase = 'thinking'
  } else {
    stream.content += text
    stream.phase = 'answering'
  }
  delete stream.progress
  publish(streamId)
}

/** Publish a tool row as soon as the model starts it, before its result exists. */
export function noteChatStreamToolStarted(streamId: string | undefined, name: string): void {
  if (!streamId || !name) return
  const stream = active.get(streamId)
  if (!stream) return
  stream.tools = startChatStreamTool(stream.tools, name)
  publish(streamId)
}

/** Complete the same tool row without changing its position below the reply. */
export function noteChatStreamToolCompleted(
  streamId: string | undefined,
  name: string,
  result: string
): void {
  if (!streamId || !name) return
  const stream = active.get(streamId)
  if (!stream) return
  stream.tools = completeChatStreamTool(stream.tools, name, result)
  publish(streamId)
}

/**
 * Start or continue the image phase for one conversation.
 *
 * Direct image mode has no text stream to bind first. Tool and classifier paths do. This function
 * hides that difference and preserves the same durable message identity in both cases.
 */
export function beginChatImageStream(conversationId: string | null | undefined): boolean {
  if (!conversationId) return false
  const existing = [...active.entries()].find(
    ([, stream]) => stream.conversationId === conversationId
  )
  if (existing) {
    const [streamId, stream] = existing
    // The text answer can already be durable while this stream remains alive for its deferred image
    // phase. `rag:add-message` takes the pending id once; reusing the ActiveStream's old id after that
    // would publish the image file with the text row's id, then persist the image under a different
    // one. Rotate at the start of the image job, before its sidecar/file control are written.
    if (!pendingMessageIds.has(conversationId)) {
      const messageId = crypto.randomUUID()
      pendingMessageIds.set(conversationId, messageId)
      stream.messageId = messageId
      // The completed answer now has its own durable row. The new identity is for one image row, so
      // its live preview contains lifecycle state only and does not repeat the answer or tool chips.
      stream.content = ''
      stream.reasoning = ''
      delete stream.tools
    }
    stream.phase = 'loading_image_model'
    delete stream.progress
    publish(streamId)
    return true
  }

  const streamId = `image:${conversationId}`
  const messageId = pendingMessageIds.get(conversationId) ?? crypto.randomUUID()
  pendingMessageIds.set(conversationId, messageId)
  active.set(streamId, {
    conversationId,
    content: '',
    reasoning: '',
    phase: 'loading_image_model',
    messageId
  })
  publish(streamId)
  return true
}

/**
 * Keep a tool-using turn open while its deferred image job runs.
 *
 * The text model and image model are two phases of ONE reply. Ending the stream between them makes
 * paired devices remove the first placeholder before the image record exists. This transition keeps
 * the original durable message id and changes only the live activity shown by peers.
 */
export function continueChatStreamWithImage(streamId: string | undefined): boolean {
  if (!streamId) return false
  const stream = active.get(streamId)
  if (!stream) return false
  stream.phase = 'loading_image_model'
  delete stream.progress
  publish(streamId)
  return true
}

/** Refresh the same live image activity as native generation advances. */
export function noteChatStreamImageProgress(
  conversationId: string | null | undefined,
  step?: number,
  total?: number
): boolean {
  if (!conversationId) return false
  const entry = [...active.entries()].find(
    ([, stream]) =>
      stream.conversationId === conversationId &&
      (stream.phase === 'loading_image_model' || stream.phase === 'generating_image')
  )
  if (!entry) return false
  const [streamId, stream] = entry
  if (step !== undefined && step > 0 && total !== undefined && total > 0) {
    stream.phase = 'generating_image'
    stream.progress = { current: Math.min(Math.max(step, 0), total), total }
  } else {
    stream.phase = 'loading_image_model'
    delete stream.progress
  }
  publish(streamId)
  return true
}

/** End the deferred image phase when its native job succeeds, fails, or is cancelled. */
export function endChatStreamForConversation(
  conversationId: string | null | undefined,
  completion: ChatStreamCompletion = 'record_pending'
): boolean {
  if (!conversationId) return false
  const streamId = [...active.entries()].find(
    ([, stream]) => stream.conversationId === conversationId
  )?.[0]
  if (!streamId) return false
  endChatStream(streamId, completion)
  return true
}

/**
 * The turn ended. A successful reply remains until its durable record arrives. Cancelled or failed
 * work is discarded now because no record is coming to replace it.
 */
export function endChatStream(
  streamId: string | undefined,
  completion: ChatStreamCompletion = 'record_pending'
): void {
  if (!streamId) return
  const stream = active.get(streamId)
  if (!stream || !active.delete(streamId)) return
  if (completion === 'discarded') pendingMessageIds.delete(stream.conversationId)
  callHook(HOOKS.syncStreamingState, {
    conversationId: stream.conversationId,
    completion
  })
}

function publish(streamId: string): void {
  const stream = active.get(streamId)
  if (!stream) return
  callHook(HOOKS.syncStreamingState, {
    conversationId: stream.conversationId,
    content: stream.content,
    reasoning: stream.reasoning,
    phase: stream.phase,
    ...(stream.progress ? { progress: stream.progress } : {}),
    ...(stream.tools?.length ? { tools: stream.tools } : {}),
    messageId: stream.messageId
  })
}
