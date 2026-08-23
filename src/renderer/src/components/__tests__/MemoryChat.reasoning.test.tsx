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

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'
import { readReasoning } from '@renderer/lib/message-persistence'

type StreamEvent = { streamId: string; type: 'content' | 'reasoning' | 'step'; text?: string }
type AddRagArgs = [convId: string, role: string, content: string, context?: unknown]
type AddRagMessageBoundary = Mock<(...args: AddRagArgs) => Promise<void>>

/** window.api where ragChat streams a reasoning event through the REAL onRagStream
 *  callback (keyed by the streamId it is handed), then resolves. addRagMessage is the
 *  assertion subject — its context arg is what persists / reloads. */
function installApi(): { addRagMessage: AddRagMessageBoundary } {
  let streamCb: ((e: StreamEvent) => void) | null = null
  const addRagMessage = vi.fn(async (..._a: AddRagArgs) => {})
  const api = {
    isPro: false,
    imageGenStatus: vi.fn(async () => ({ available: false, models: [], active: '' })),
    cancelImageGen: vi.fn(),
    onImageGenProgress: vi.fn(() => () => {}),
    getRagConversations: vi.fn(async () => []),
    getRagMessages: vi.fn(async () => []),
    createRagConversation: vi.fn(async () => {}),
    addRagMessage,
    saveArtifact: vi.fn(async () => {}),
    getSettings: vi.fn(async () => ({})),
    saveSetting: vi.fn(async () => {}),
    listProjects: vi.fn(async () => []),
    styleThumbs: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => []),
    onRagStream: vi.fn((cb: (e: StreamEvent) => void) => {
      streamCb = cb
      return () => {}
    }),
    // ragChat: 7th arg is the streamId. Stream a reasoning delta on it (the real handler
    // routes it), then return the final answer + a context object.
    ragChat: vi.fn(async (..._args: unknown[]) => {
      const streamId = _args[6] as string
      streamCb?.({ streamId, type: 'reasoning', text: 'weighing the options' })
      streamCb?.({ streamId, type: 'content', text: 'Here is the answer.' })
      return { answer: 'Here is the answer.', context: { unified: [] } }
    })
  }
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
  return { addRagMessage }
}

describe('<MemoryChat/> — streamed reasoning is persisted (survives reload)', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  it('reasoning streamed via onRagStream lands in the persisted context (readReasoning restores it)', async () => {
    const { addRagMessage } = installApi()
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <MemoryChat />
      </TooltipProvider>
    )

    const textarea = await screen.findByPlaceholderText(/ask anything/i, {}, { timeout: 3000 })
    fireEvent.change(textarea, { target: { value: 'what did I work on' } })
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    // Terminal artifact: the assistant turn persisted via addRagMessage carries the
    // streamed reasoning in its context — read through the SAME reader a reload uses.
    await waitFor(() => expect(addRagMessage).toHaveBeenCalled())
    const assistantCall = addRagMessage.mock.calls.find((c) => c[1] === 'assistant')
    expect(assistantCall).toBeTruthy()
    expect(readReasoning(assistantCall![3])).toBe('weighing the options')
  })
})
