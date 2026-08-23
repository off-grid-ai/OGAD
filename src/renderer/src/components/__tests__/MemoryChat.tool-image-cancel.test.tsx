// @vitest-environment jsdom
//
// D12 — a tool turn that requested an image, whose image generation is then
// CANCELLED, must still persist the text answer. The renderer finalized the answer
// in state (shown on screen) but, on a cancel of the deferred image gen, skipped
// addRagMessage entirely — so the assistant turn was never persisted and vanished
// on the next reload (only the user turn survived).
//
// Mounts the real screen with tools on (loaded from the persisted setting), sends a
// message, and drives the tool path where toolChat returns an imageRequest and
// generateImage rejects 'cancelled'. Terminal artifact: the assistant answer is
// PERSISTED via addRagMessage (the row a reload re-renders) — asserted on its
// content, the same way the reasoning-persistence test asserts the persisted blob.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'

type AddRag = ReturnType<typeof vi.fn>

function installApi(): { addRagMessage: AddRag } {
  const addRagMessage = vi.fn(async () => {})
  const api = {
    isPro: false,
    imageGenStatus: vi.fn(async () => ({ available: true, models: ['sd'], active: 'sd' })),
    cancelImageGen: vi.fn(),
    cancelRag: vi.fn(),
    onImageGenProgress: vi.fn(() => () => {}),
    onRagStream: vi.fn(() => () => {}),
    getRagConversations: vi.fn(async () => []),
    getRagMessages: vi.fn(async () => []),
    createRagConversation: vi.fn(async () => {}),
    addRagMessage,
    saveArtifact: vi.fn(async () => {}),
    // Tools ON via the persisted setting (how a returning user reaches this state).
    getSettings: vi.fn(async () => ({ composerToolsOn: true })),
    saveSetting: vi.fn(async () => {}),
    listProjects: vi.fn(async () => []),
    styleThumbs: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => []),
    listTools: vi.fn(async () => []),
    mcpList: vi.fn(async () => []),
    // The tool turn requests an image; image generation then CANCELS.
    toolChat: vi.fn(async () => ({
      answer: 'Here is your weekly summary.',
      imageRequest: { prompt: 'a chart' },
      unified: [],
      toolCalls: []
    })),
    generateImage: vi.fn(async () => {
      throw new Error('cancelled')
    })
  }
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
  return { addRagMessage }
}

describe('<MemoryChat/> — tool-image cancel keeps the text answer (D12)', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  it('persists the assistant text turn even when the deferred image gen is cancelled', async () => {
    const { addRagMessage } = installApi()
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <MemoryChat />
      </TooltipProvider>
    )

    const textarea = await screen.findByPlaceholderText(/ask anything/i, {}, { timeout: 3000 })
    fireEvent.change(textarea, { target: { value: 'summarize my week' } })
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    // Terminal artifact: the assistant answer was PERSISTED (survives a reload),
    // not dropped because the image was cancelled.
    await waitFor(() => {
      const persistedAssistant = addRagMessage.mock.calls.find(
        (c) => c[1] === 'assistant' && c[2] === 'Here is your weekly summary.'
      )
      expect(persistedAssistant).toBeTruthy()
    })
  })
})
