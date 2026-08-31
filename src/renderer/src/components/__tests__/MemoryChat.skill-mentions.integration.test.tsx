// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { ALL_PRESETS, type DemoPreset } from '../explore/presetCatalog'
import { TooltipProvider } from '../ui/tooltip'
import { ChatBoundary, installBoundary } from './harness/chat-boundary'

const requiredAnswer = (preset: DemoPreset, fieldId: string): string =>
  `${preset.id}-${fieldId}-approved`

async function completeRequiredFields(
  preset: DemoPreset,
  _user: ReturnType<typeof userEvent.setup>
): Promise<void> {
  for (const field of preset.intake.fields) {
    if (!field.required || field.defaultValue?.trim()) continue
    const control = screen.getByLabelText(`${field.label} *`, {
      selector: 'input, textarea, select'
    })
    fireEvent.change(control, { target: { value: requiredAnswer(preset, field.id) } })
    expect((control as HTMLInputElement).value).toBe(requiredAnswer(preset, field.id))
  }
}

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

    expect(await screen.findByTestId('preset-intake-proposal-deck')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Company/), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText(/Meeting context/), {
      target: { value: 'The team needs a launch plan.' }
    })
    fireEvent.change(screen.getByLabelText(/Content folder/, { selector: 'input' }), {
      target: { value: '/tmp/client-material' }
    })
    fireEvent.change(screen.getByLabelText(/Save under/, { selector: 'input' }), {
      target: { value: '/tmp/client-output' }
    })
    await user.click(screen.getByRole('button', { name: 'Start in chat' }))

    await waitFor(() =>
      expect(boundary.addRagMessage.mock.calls.some((call) => call[1] === 'user')).toBe(true)
    )
    const submittedMessage = boundary.addRagMessage.mock.calls.find((call) => call[1] === 'user')
    expect(submittedMessage?.[2]).toContain('A: /tmp/client-material')
    expect(submittedMessage?.[2]).toContain('A: /tmp/client-output')
    expect(submittedMessage?.[2]).toContain('Do not ask for them again')
    if (boundary.calls.length > 0) boundary.resolve(0, 'Proposal started.')
  })

  it.each(ALL_PRESETS)(
    '$id opens its form in Chat and sends one complete brief only after submit',
    async (preset) => {
      const boundary = new ChatBoundary()
      installBoundary(boundary)
      const user = userEvent.setup()
      render(
        <TooltipProvider>
          <MemoryChat openTarget={{ presetId: preset.id }} />
        </TooltipProvider>
      )

      const intake = await screen.findByTestId(`preset-intake-${preset.id}`)
      expect(intake).toBeTruthy()
      expect(boundary.calls).toHaveLength(0)
      expect(boundary.addRagMessage).not.toHaveBeenCalled()

      await completeRequiredFields(preset, user)
      const start = screen.getByRole('button', { name: 'Start in chat' })
      expect(start.hasAttribute('disabled')).toBe(false)
      expect(boundary.calls).toHaveLength(0)

      await user.click(start)
      await waitFor(() => expect(boundary.calls).toHaveLength(1))

      const submittedMessage = boundary.addRagMessage.mock.calls.find((call) => call[1] === 'user')
      const submittedPrompt = submittedMessage?.[2] ?? ''
      expect(submittedPrompt).toContain('Required method:')
      expect(submittedPrompt).toContain('Execution rules:')
      expect(submittedPrompt).toContain('User-approved inputs:')
      expect(submittedPrompt).toContain('Do not repeat these questions. Begin the run now.')
      for (const field of preset.intake.fields) {
        expect(submittedPrompt).toContain(`Q: ${field.label}`)
        if (field.required && !field.defaultValue?.trim()) {
          expect(submittedPrompt).toContain(`A: ${requiredAnswer(preset, field.id)}`)
        }
      }

      const userBubble = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="chat-message-"]')
      ).find((element) => element.textContent?.includes('User-approved inputs:'))
      expect(userBubble?.textContent).toContain('Required method:')

      boundary.resolve(0, `${preset.title} started.`)
      expect(await screen.findByText(`${preset.title} started.`)).toBeTruthy()
    }
  )

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
