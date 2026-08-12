// @vitest-environment jsdom
//
// Renderer-side adjacent evidence for RELEASE_TEST_CHECKLIST #49. The renderer stays on its
// public preload/stream contracts; the paired main-process integration test owns settings-file
// persistence, LLMService, and the native-model socket.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'
import { TooltipProvider } from '../ui/tooltip'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

const OLD_MAX_TOKENS = 2048
const RAISED_MAX_TOKENS = 4096

describe('<MemoryChat/> - response limit through public renderer contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('raises the setting, renders a long answer, and preserves its visible cutoff state', async () => {
    const boundary = new ChatBoundary()
    let maxTokens = OLD_MAX_TOKENS
    const setLlmSettings = vi.fn(async (patch: { maxTokens?: number }) => {
      maxTokens = patch.maxTokens ?? maxTokens
      return { maxTokens }
    })
    Object.assign(boundary.api, {
      getLlmSettings: async () => ({ maxTokens }),
      setLlmSettings,
      ttsVoices: async () => [],
      listTools: async () => [],
      mcpList: async () => []
    })
    installBoundary(boundary)

    const settingsView = render(
      <TooltipProvider>
        <SettingsPanel onClose={() => {}} />
      </TooltipProvider>
    )
    // Max output is now a select (Auto + hard-cap options), not a range slider.
    const responseLimit = settingsView.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Max output"]'
    )
    expect(responseLimit).not.toBeNull()
    await waitFor(() => expect(responseLimit!.value).toBe(String(OLD_MAX_TOKENS)))
    fireEvent.change(responseLimit!, { target: { value: String(RAISED_MAX_TOKENS) } })
    await waitFor(() =>
      expect(setLlmSettings).toHaveBeenCalledWith({ maxTokens: RAISED_MAX_TOKENS })
    )
    settingsView.unmount()

    const longAnswer = `${'x'.repeat(OLD_MAX_TOKENS + 2)} LIMIT-END`
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-b' })
    await send('Write beyond the previous response limit', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    for (const chunk of longAnswer.match(/.{1,512}/g) ?? []) boundary.emit(0, chunk)
    boundary.resolve(0, longAnswer, {
      cutoff: { reason: 'max_tokens', maxTokens: RAISED_MAX_TOKENS }
    })

    expect(await screen.findByText(/LIMIT-END/)).toBeTruthy()
    expect(
      await screen.findByText('Response stopped at the configured 4,096-token limit.')
    ).toBeTruthy()
    await waitFor(() => {
      const persisted = boundary.messages['conversation-b']!.find(
        (message) => message.role === 'assistant' && message.content === longAnswer
      )
      expect(persisted?.context).toMatchObject({
        cutoff: { reason: 'max_tokens', maxTokens: RAISED_MAX_TOKENS }
      })
    })

    cleanup()
    renderChat({ conversationId: 'conversation-b' })
    expect(
      await screen.findByText('Response stopped at the configured 4,096-token limit.')
    ).toBeTruthy()
  })

  it('shows the active model context contract and refetches the running value after a change', async () => {
    const boundary = new ChatBoundary()
    let settings = { ctxSize: 65536, effectiveCtxSize: 32768, modelMaxCtx: 262144 }
    const setLlmSettings = vi.fn(async (patch: { ctxSize?: number }) => {
      settings = {
        ...settings,
        ...patch,
        effectiveCtxSize: patch.ctxSize ?? settings.effectiveCtxSize
      }
    })
    Object.assign(boundary.api, {
      getModelCatalog: async () => ({
        kinds: ['vision'],
        models: [{ id: 'local/qwen', name: 'Qwen 3.5 2B' }]
      }),
      getActiveModel: async () => 'local/qwen',
      getLlmSettings: async () => settings,
      setLlmSettings,
      ttsVoices: async () => [],
      listTools: async () => [],
      mcpList: async () => []
    })
    installBoundary(boundary)

    render(
      <TooltipProvider>
        <SettingsPanel embedded onClose={() => {}} />
      </TooltipProvider>
    )

    const status = await screen.findByRole('status')
    await waitFor(() => expect(status.textContent).toContain('Qwen 3.5 2B'))
    expect(status.textContent).toContain('Configured64K')
    expect(status.textContent).toContain('Running32K')
    expect(status.textContent).toContain('Recommended16K')

    fireEvent.change(screen.getByRole('combobox', { name: 'Context window' }), {
      target: { value: '16384' }
    })
    await waitFor(() => expect(setLlmSettings).toHaveBeenCalledWith({ ctxSize: 16384 }))
    await waitFor(() => expect(status.textContent).toContain('Running16K'))
  })
})
