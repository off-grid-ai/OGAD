// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatToolRows } from '../ChatToolRows'

afterEach(cleanup)

describe('<ChatToolRows/> work timeline', () => {
  it('uses one customer-facing timeline for every ordered execution step', async () => {
    const user = userEvent.setup()
    render(
      <ChatToolRows
        tools={[
          { name: 'list_folder', status: 'completed', result: 'investor-relations\nnotes.md' },
          {
            name: 'read_file',
            status: 'completed',
            result: 'Private source text from /Users/mac/private/notes.md'
          },
          {
            name: 'proposal_deck',
            arguments: '{"action":"save_skeleton"}',
            status: 'completed',
            result: 'The slide plan is ready.'
          },
          { name: 'web_task', status: 'completed', result: 'Website research complete.' },
          { name: 'computer_use', status: 'running' }
        ]}
      />
    )

    expect(screen.getByRole('button', { name: /Work done/ }).textContent).toContain(
      '5 steps · running'
    )
    expect(screen.getByText('Listed folder')).toBeTruthy()
    expect(screen.getByText('Read file')).toBeTruthy()
    expect(screen.getByText('Built slide plan')).toBeTruthy()
    expect(screen.getByText('Web Use')).toBeTruthy()
    expect(screen.getByText('Computer Use')).toBeTruthy()
    expect(screen.queryByText(/Private source text/)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Read file, complete' }))
    expect(await screen.findByText(/Private source text/)).toBeTruthy()
  })

  it('uses product names for legacy calls and keeps exact failures behind disclosure', async () => {
    const user = userEvent.setup()
    render(
      <ChatToolRows
        tools={[
          { name: 'web_task', status: 'failed', result: 'Error: browser timed out' },
          { name: 'mcp__31__search_messages', status: 'completed', result: '3 messages found' }
        ]}
      />
    )
    await user.click(screen.getByRole('button', { name: /Work done/ }))
    expect(screen.getByText('Web Use')).toBeTruthy()
    expect(screen.getByText('Searched messages')).toBeTruthy()
    expect(screen.queryByText(/web_task/)).toBeNull()
    expect(screen.queryByText('Error: browser timed out')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Web Use, failed' }))
    expect(await screen.findByText('Error: browser timed out')).toBeTruthy()
  })
})
