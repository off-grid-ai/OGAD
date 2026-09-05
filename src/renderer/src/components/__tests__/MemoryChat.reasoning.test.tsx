// @vitest-environment jsdom
//
// Terminal-artifact test for the reasoning-persistence fix (T1f + the Gitar/CodeRabbit
// review finding): reasoning that STREAMS in during a chat turn must ride the PERSISTED
// context blob, so the "Thinking" block survives a reload. The bug it guards: the persist
// sites used to read `message.reasoning` out of a setConvMessages UPDATER (a state-updater
// side effect) — unreliable, because React may defer the updater to render, so the read
// could be undefined and reasoning was silently dropped from the saved blob. The fix mirrors
// streamed reasoning into a ref and reads it deterministically.
//
// This drives the REAL seam: mount <MemoryChat/>, send a plain chat turn, let the fake
// ragChat fire a REAL onRagStream 'reasoning' event (via the captured callback, keyed by the
// streamId ragChat receives), then resolve. The terminal artifact is the `context` handed to
// window.api.addRagMessage — asserted through the REAL readReasoning reader (the exact path a
// reload uses to restore the block), not an intermediate field.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'
import { readReasoning } from '@renderer/lib/message-persistence'

describe('<MemoryChat/> — streamed reasoning is persisted (survives reload)', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  it('reasoning streamed via onRagStream lands in the persisted context (readReasoning restores it)', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })
    await send('what did I work on', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    boundary.emitReasoning(0, 'weighing the options')
    boundary.emit(0, 'Here is the answer.')
    boundary.resolve(0, 'Here is the answer.')

    // Terminal artifact: the assistant turn persisted via addRagMessage carries the
    // streamed reasoning in its context — read through the SAME reader a reload uses.
    await waitFor(() => expect(boundary.addRagMessage).toHaveBeenCalled())
    const assistantCall = boundary.addRagMessage.mock.calls.find((c) => c[1] === 'assistant')
    expect(assistantCall).toBeTruthy()
    expect(readReasoning(assistantCall![3])).toBe('weighing the options')
  })
})
