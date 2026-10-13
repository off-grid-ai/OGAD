// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatDraftInput } from '../ChatDraftInput'
import { createChatDraftStore } from '../chat-draft-store'

afterEach(cleanup)

function Composer({
  attachmentPending = false,
  busy = true,
  suggestion,
  mode = 'ask'
}: {
  attachmentPending?: boolean
  busy?: boolean
  suggestion?: string
  mode?: 'ask' | 'image'
}): React.JSX.Element {
  const [store] = useState(() => createChatDraftStore())
  const [result, setResult] = useState('')
  const submit = (mode: string): void => {
    setResult(`${mode}: ${store.getSnapshot()}`)
    store.set('')
  }
  return (
    <>
      <ChatDraftInput
        store={store}
        skills={[{ name: 'summarize', description: 'Summarize text' }]}
        mode={mode}
        busy={busy}
        suggestion={suggestion}
        attachmentPending={attachmentPending}
        onPaste={() => {}}
        onSubmit={() => submit('Queued')}
        onSendNow={() => submit('Send now')}
      />
      <output>{result}</output>
    </>
  )
}

describe('chat composer keyboard', () => {
  it('accepts a suggested message with Tab without sending it', async () => {
    const user = userEvent.setup()
    render(<Composer busy={false} suggestion="Compare the two options" />)
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    expect(input.placeholder).toBe('Compare the two options (Tab)')
    await user.click(input)
    await user.keyboard('{Tab}')
    expect(input.value).toBe('Compare the two options')
    expect(screen.getByRole('status').textContent).toBe('')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('status').textContent).toBe('Queued: Compare the two options')
  })

  it('keeps typed text and skill completion ahead of a suggestion', async () => {
    const user = userEvent.setup()
    render(<Composer busy={false} suggestion="Compare the two options" />)
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    await user.type(input, 'My question')
    await user.keyboard('{Tab}')
    expect(input.value).toBe('My question')
    await user.clear(input)
    await user.type(input, '/summ')
    await user.keyboard('{Tab}')
    expect(input.value).toBe('/summarize ')
  })

  it.each([
    { busy: true },
    { busy: false, attachmentPending: true },
    { busy: false, mode: 'image' as const }
  ])('does not offer a suggestion in an unavailable state: %o', async (props) => {
    const user = userEvent.setup()
    render(<Composer {...props} suggestion="Compare the two options" />)
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    expect(input.placeholder).not.toContain('Compare the two options')
    await user.click(input)
    await user.keyboard('{Tab}')
    expect(input.value).toBe('')
  })

  it('keeps Shift+Tab as reverse focus navigation', async () => {
    const user = userEvent.setup()
    render(<Composer busy={false} suggestion="Compare the two options" />)
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    await user.click(input)
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(input.value).toBe('')
    expect(document.activeElement).not.toBe(input)
  })

  it('queues with Enter and sends now with Command or Control plus Enter', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const input = screen.getByRole('textbox', { name: 'Message' })
    await user.type(input, 'First{Enter}')
    expect(screen.getByRole('status').textContent).toBe('Queued: First')
    await user.type(input, 'Priority')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(screen.getByRole('status').textContent).toBe('Send now: Priority')
    await user.type(input, 'Control')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(screen.getByRole('status').textContent).toBe('Send now: Control')
  })

  it('keeps Shift+Enter as a new line and Enter as skill completion', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    await user.type(input, '/summ{Enter}')
    expect(input.value).toBe('/summarize ')
    expect(screen.getByRole('status').textContent).toBe('')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(input.value).toBe('/summarize \n')
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('keeps a draft while its attachment is being read', async () => {
    const user = userEvent.setup()
    render(<Composer attachmentPending />)
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    await user.type(input, 'Attached{Enter}')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(input.value).toBe('Attached')
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
