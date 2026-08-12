import { beforeEach, describe, expect, it } from 'vitest'
import { registerHook, HOOKS } from '../bootstrap/hookRegistry'
import {
  bindChatStream,
  noteChatStreamDelta,
  endChatStream
} from '../chat-stream-state'

/**
 * What this device is generating right now, as the one fact other subsystems observe.
 *
 * The point of this module is that a consumer - live streaming a reply to a paired phone, above all -
 * never has to re-accumulate deltas from its own tap, and never has to infer that a turn ended from
 * silence. So these tests watch the published SNAPSHOTS through the real hook registry rather than
 * poking at internals: the sequence a consumer would actually see is the behaviour worth protecting.
 *
 * Nothing is faked. The hook registry is the app's own, and the only collaborator.
 */

type Snapshot = { conversationId: string; content: string; reasoning: string } | null

describe('the reply being generated, as published to anything that follows it', () => {
  let published: Snapshot[]

  beforeEach(() => {
    published = []
    registerHook(HOOKS.syncStreamingState, (snapshot) => {
      published.push(snapshot as Snapshot)
    })
    // Streams from an earlier test must not leak into this one. Ending an unbound id is a no-op, so
    // this is safe whether or not the id is live.
    for (const id of ['stream-a', 'stream-b', 'stream-c']) endChatStream(id)
    published = []
  })

  it('announces a conversation as generating the moment the turn is bound, before any token', () => {
    bindChatStream('stream-a', 'conversation-1')

    // Empty content, not absent: a consumer can show "generating" immediately, rather than waiting for
    // the first token to learn a turn exists at all.
    expect(published).toEqual([{ conversationId: 'conversation-1', content: '', reasoning: '' }])
  })

  it('publishes the reply so far, not the delta, so a late consumer is never behind', () => {
    bindChatStream('stream-a', 'conversation-1')
    noteChatStreamDelta('stream-a', 'Hello', 'content')
    noteChatStreamDelta('stream-a', ' world', 'content')

    // Cumulative. A consumer that missed the first delta still has the whole reply from the snapshot it
    // does see - which is the entire reason this module exists instead of each consumer accumulating.
    expect(published.at(-1)).toEqual({
      conversationId: 'conversation-1',
      content: 'Hello world',
      reasoning: ''
    })
  })

  it('keeps thinking apart from the answer', () => {
    bindChatStream('stream-a', 'conversation-1')
    noteChatStreamDelta('stream-a', 'let me think', 'reasoning')
    noteChatStreamDelta('stream-a', 'the answer', 'content')
    noteChatStreamDelta('stream-a', ' — more thought', 'reasoning')

    // Two accumulators, one snapshot. Folding reasoning into content would put the model's private
    // deliberation into the reply a paired device displays as the answer.
    expect(published.at(-1)).toEqual({
      conversationId: 'conversation-1',
      content: 'the answer',
      reasoning: 'let me think — more thought'
    })
  })

  it('ends with a null snapshot rather than falling silent', () => {
    bindChatStream('stream-a', 'conversation-1')
    noteChatStreamDelta('stream-a', 'done', 'content')

    endChatStream('stream-a')

    // The end IS an event. A consumer that had to infer it from silence would need a timeout, and would
    // show a phone "still generating" forever whenever a turn failed.
    expect(published.at(-1)).toBeNull()
  })

  it('says nothing more once a turn has ended, even if a late delta arrives', () => {
    bindChatStream('stream-a', 'conversation-1')
    endChatStream('stream-a')
    const afterEnd = published.length

    noteChatStreamDelta('stream-a', 'straggler', 'content')

    // A delta arriving after cancellation must not resurrect the turn - that would leave a consumer
    // showing a reply the user already stopped.
    expect(published).toHaveLength(afterEnd)
  })

  it('ends only once, so a repeated end cannot look like a second turn', () => {
    bindChatStream('stream-a', 'conversation-1')
    endChatStream('stream-a')
    const afterFirstEnd = published.length

    endChatStream('stream-a')

    // Cancel and completion can both fire for one turn. The second end is silent because the stream is
    // already gone, rather than publishing another null that reads as a new turn ending.
    expect(published).toHaveLength(afterFirstEnd)
  })

  it('follows two conversations at once without mixing their replies', () => {
    bindChatStream('stream-a', 'conversation-1')
    bindChatStream('stream-b', 'conversation-2')
    noteChatStreamDelta('stream-a', 'first', 'content')
    noteChatStreamDelta('stream-b', 'second', 'content')

    // Keyed by stream id, because that is all the transport knows. Sharing one accumulator would splice
    // two users' replies together the moment a second turn started anywhere.
    expect(published.at(-2)).toEqual({
      conversationId: 'conversation-1',
      content: 'first',
      reasoning: ''
    })
    expect(published.at(-1)).toEqual({
      conversationId: 'conversation-2',
      content: 'second',
      reasoning: ''
    })
    endChatStream('stream-b')
    expect(published.at(-1)).toBeNull()

    // Ending one leaves the other running: its next delta still publishes, with its own text.
    noteChatStreamDelta('stream-a', ' more', 'content')
    expect(published.at(-1)).toEqual({
      conversationId: 'conversation-1',
      content: 'first more',
      reasoning: ''
    })
  })

  it('publishes nothing for a turn it cannot attribute to a conversation', () => {
    bindChatStream('stream-c', undefined)
    noteChatStreamDelta('stream-c', 'orphan', 'content')
    endChatStream('stream-c')

    // An unattributed reply has no conversation to appear in, so there is nothing to say about it -
    // better than publishing a snapshot a consumer cannot place, or inventing a conversation id.
    expect(published).toEqual([])
  })

  it('publishes nothing when the transport gave no stream id', () => {
    bindChatStream(undefined, 'conversation-1')
    noteChatStreamDelta(undefined, 'nowhere', 'content')
    endChatStream(undefined)

    expect(published).toEqual([])
  })

  it('ignores deltas for a stream that was never bound', () => {
    noteChatStreamDelta('stream-never-bound', 'text', 'content')
    noteChatStreamDelta('stream-never-bound', 'thought', 'reasoning')

    // Deltas can outlive their binding (a retry, a stale transport). Accumulating them under an unknown
    // id would publish a conversation-less snapshot, or worse, grow unbounded.
    expect(published).toEqual([])
  })
})
