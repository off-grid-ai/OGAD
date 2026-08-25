// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { ExploreScreen } from '../explore/ExploreScreen'
import type { DemoPreset } from '../explore/presetCatalog'
import { TooltipProvider } from '../ui/tooltip'
import { ChatBoundary, installBoundary } from './harness/chat-boundary'

function SkillMentionJourney(): React.ReactElement {
  const [surface, setSurface] = useState<'chat' | 'explore'>('chat')
  const [presetId, setPresetId] = useState<string>()
  const [chatTarget, setChatTarget] = useState<
    { conversationId?: string; seedPrompt?: string } | undefined
  >({ conversationId: 'conversation-a' })

  const runPreset = (preset: DemoPreset): void => {
    setChatTarget({ seedPrompt: preset.prompt })
    setSurface('chat')
  }

  return surface === 'explore' ? (
    <ExploreScreen onRunPreset={runPreset} initialPresetId={presetId} />
  ) : (
    <TooltipProvider>
      <MemoryChat
        openTarget={chatTarget}
        onTargetConsumed={() => setChatTarget(undefined)}
        onOpenSkillPreset={(preset) => {
          setPresetId(preset.id)
          setSurface('explore')
        }}
      />
    </TooltipProvider>
  )
}

describe('<MemoryChat/> clickable skill mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens a catalog skill setup and starts its configured prompt in a new chat', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      {
        id: 1,
        role: 'user',
        content: '/proposal-deck **Start a new client proposal.**'
      },
      { id: 2, role: 'user', content: '/not-a-skill stays ordinary text.' }
    ]
    installBoundary(boundary)
    const user = userEvent.setup()
    render(<SkillMentionJourney />)

    const proposalMessage = await screen.findByTestId('chat-message-1')
    expect(within(proposalMessage).getByText('Start a new client proposal.').tagName).toBe('STRONG')
    expect(
      within(screen.getByTestId('chat-message-2')).queryByRole('button', {
        name: /open \/not-a-skill skill/i
      })
    ).toBeNull()

    await user.click(
      within(proposalMessage).getByRole('button', { name: 'Open /proposal-deck skill' })
    )

    expect(await screen.findByRole('heading', { name: 'Explore' })).toBeTruthy()
    expect(screen.getByTestId('proposal-deck-setup')).toBeTruthy()
    await user.type(screen.getByLabelText('Content folder'), '/tmp/client-material')
    await user.type(screen.getByLabelText('Save under'), '/tmp/client-output')
    await user.click(screen.getByRole('button', { name: 'Start in chat' }))

    await waitFor(() => {
      expect(screen.getAllByText(/A: \/tmp\/client-material/)).toHaveLength(2)
      expect(screen.getByText(/A: \/tmp\/client-output/)).toBeTruthy()
    })
  })

  it('opens the exact installed skill and keeps unknown slash text plain', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      { id: 1, role: 'user', content: '/proofread Make this clearer.' },
      { id: 2, role: 'user', content: '/usr/local/bin is a path.' }
    ]
    boundary.api.listSkills.mockResolvedValue([
      { name: 'proofread', description: 'Make writing clearer' }
    ])
    Object.assign(boundary.api, {
      getSkill: vi.fn(async (name: string) =>
        name === 'proofread'
          ? {
              name: 'proofread',
              description: 'Make writing clearer',
              instructions: 'Preserve the meaning.',
              trigger: null
            }
          : null
      )
    })
    installBoundary(boundary)
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'conversation-a' }} />
      </TooltipProvider>
    )

    await user.click(await screen.findByRole('button', { name: 'Open /proofread skill' }))

    const panel = await screen.findByRole('dialog', { name: 'Skills' })
    expect(within(panel).getByDisplayValue('proofread')).toBeTruthy()
    expect(within(panel).getByDisplayValue('Preserve the meaning.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open /usr skill' })).toBeNull()
  })
})
