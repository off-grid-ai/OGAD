// @vitest-environment jsdom
//
// The generation-details preference, end to end through the public renderer contracts: the REAL
// SettingsPanel writes it, the REAL chat reads it back and decides whether to print the numbers.
//
// Only the preload boundary is faked. Nothing here asserts on internal state - the questions are
// "did the switch persist" and "can the user see the numbers", which is what the feature IS.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'
import { TooltipProvider } from '../ui/tooltip'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

/** What a measured local run reports: a server rate, a token count, and our own TTFT. */
const MEASURED = {
  decodeTokensPerSecond: 42.5,
  prefillTokensPerSecond: 910,
  timeToFirstTokenSeconds: 0.37,
  completionTokens: 128,
  totalSeconds: 3.4
}

function boundaryWithSettings(stored: Record<string, unknown>): {
  boundary: ChatBoundary
  saveSetting: ReturnType<typeof vi.fn>
} {
  const boundary = new ChatBoundary()
  const settings = { ...stored }
  const saveSetting = vi.fn(async (key: string, value: unknown) => {
    settings[key] = value
    return true
  })
  Object.assign(boundary.api, {
    getSettings: async () => ({ ...settings }),
    saveSetting,
    getLlmSettings: async () => ({}),
    setLlmSettings: async () => ({}),
    ttsVoices: async () => [],
    prepareTtsVoice: async () => ({ ready: true }),
    onTtsVoiceProgress: () => () => {},
    listTools: async () => [],
    mcpList: async () => []
  })
  installBoundary(boundary)
  return { boundary, saveSetting }
}

async function answerWith(
  boundary: ChatBoundary,
  conversationId: string,
  user: ReturnType<typeof userEvent.setup>,
  metrics?: typeof MEASURED
): Promise<void> {
  renderChat({ conversationId })
  await send('how fast was that', user)
  await waitFor(() => expect(boundary.calls).toHaveLength(1))
  boundary.emit(0, 'the answer')
  boundary.resolve(0, 'the answer', metrics ? { metrics } : {})
  expect(await screen.findByText('the answer')).toBeTruthy()
}

describe('<MemoryChat/> generation details', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('hides the numbers until the preference is on, even when the run reported them', async () => {
    const { boundary } = boundaryWithSettings({})
    const user = userEvent.setup()

    await answerWith(boundary, 'conversation-off', user, MEASURED)

    // The measurement exists on the turn; the user just has not asked to see it.
    expect(screen.queryByTestId('generation-metrics')).toBeNull()
  })

  it('turns the preference on in Settings and prints the measured numbers under the answer', async () => {
    const { boundary, saveSetting } = boundaryWithSettings({})
    const user = userEvent.setup()

    const settingsView = render(
      <TooltipProvider>
        <SettingsPanel onClose={() => {}} />
      </TooltipProvider>
    )
    const toggle = await screen.findByRole('switch', { name: /generation details/i })
    await waitFor(() => expect(toggle).toHaveProperty('ariaChecked', 'false'))
    await user.click(toggle)
    await waitFor(() => expect(saveSetting).toHaveBeenCalledWith('showGenerationDetails', true))
    settingsView.unmount()

    await answerWith(boundary, 'conversation-on', user, MEASURED)

    const row = await screen.findByTestId('generation-metrics')
    // The server's own rates, our measured TTFT, and the token count - the whole point of the row.
    expect(row.textContent).toContain('42.5 tok/s')
    expect(row.textContent).toContain('prefill 910 tok/s')
    expect(row.textContent).toContain('TTFT 0.37s')
    expect(row.textContent).toContain('128 tokens')
  })

  it('prints nothing when the run reported no measurements, rather than a row of zeros', async () => {
    const { boundary } = boundaryWithSettings({ showGenerationDetails: true })
    const user = userEvent.setup()

    await answerWith(boundary, 'conversation-unmeasured', user)

    // A remote model that reports no usage must not render "0 tok/s" - absent is the honest answer.
    expect(screen.queryByTestId('generation-metrics')).toBeNull()
  })
})
