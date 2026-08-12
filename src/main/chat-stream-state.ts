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

interface ActiveStream {
  conversationId: string
  content: string
  reasoning: string
}

const active = new Map<string, ActiveStream>()

/**
 * Attach a conversation to a stream id, before any delta arrives.
 *
 * Deltas are keyed by stream id because that is all the streaming transport knows; the conversation
 * is known only by the handler that started the turn. A stream that is never bound simply publishes
 * nothing - an unattributed reply has no conversation to appear in.
 */
export function bindChatStream(streamId: string | undefined, conversationId?: string): void {
  if (!streamId || !conversationId) return
  active.set(streamId, { conversationId, content: '', reasoning: '' })
  publish(streamId)
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
  if (kind === 'reasoning') stream.reasoning += text
  else stream.content += text
  publish(streamId)
}

/**
 * The turn ended, however it ended - completed, cancelled, or failed.
 *
 * Always publishes null, so a consumer never has to infer the end from silence.
 */
export function endChatStream(streamId: string | undefined): void {
  if (!streamId || !active.delete(streamId)) return
  callHook(HOOKS.syncStreamingState, null)
}

function publish(streamId: string): void {
  const stream = active.get(streamId)
  if (!stream) return
  callHook(HOOKS.syncStreamingState, {
    conversationId: stream.conversationId,
    content: stream.content,
    reasoning: stream.reasoning
  })
}
