// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'
import { ChatBoundary, installBoundary } from './harness/chat-boundary'

function SkillMentionJourney(): React.ReactElement {
  const [chatTarget, setChatTarget] = useState<
    { conversationId?: string; presetId?: string } | undefined
  >({ conversationId: 'conversation-a' })

  return (
    <TooltipProvider>
      <MemoryChat
        openTarget={chatTarget}
        onTargetConsumed={() => setChatTarget(undefined)}
        onOpenSkillPreset={(preset) => setChatTarget({ presetId: preset.id })}
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

  it('keeps the removed proposal deck command as plain text', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      {
        id: 1,
        role: 'user',
        content: '/proposal-deck **Start a new client proposal.**'
      }
    ]
    installBoundary(boundary)
    render(<SkillMentionJourney />)

    const proposalMessage = await screen.findByTestId('chat-message-1')
    expect(within(proposalMessage).getByText('Start a new client proposal.').tagName).toBe('STRONG')
    expect(
      within(proposalMessage).queryByRole('button', {
        name: /open \/proposal-deck skill/i
      })
    ).toBeNull()
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
