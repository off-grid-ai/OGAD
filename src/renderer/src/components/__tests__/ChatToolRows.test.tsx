// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatToolRows, taskReferenceFromResult } from '../ChatToolRows'
import { resetTaskSessionStoreForTests } from '@renderer/lib/task-session-store'

beforeEach(() => {
  resetTaskSessionStoreForTests()
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      tasks: {
        list: vi.fn(async () => []),
        onChanged: vi.fn(() => () => undefined)
      }
    }
  })
})

afterEach(() => {
  cleanup()
  resetTaskSessionStoreForTests()
})

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

  it('shows persisted redacted Computer Use evidence inside the assistant turn', async () => {
    const user = userEvent.setup()
    window.api.tasks!.list = vi.fn(async () => [
      {
        taskId: 'act_1',
        kind: 'computer_use' as const,
        title: 'Prepare slides',
        status: 'done' as const,
        steps: ['Opened Keynote'],
        startedAt: 1,
        finishedAt: 2,
        updatedAt: 2,
        stepDetails: [
          {
            stepId: 'open-keynote',
            at: 1,
            modelInput: 'Open Keynote',
            screenshot: {
              originalWidth: 3024,
              originalHeight: 1964,
              inferenceWidth: 1512,
              inferenceHeight: 982
            },
            mappedAction: 'Click Keynote',
            execution: {
              status: 'complete' as const,
              durationMs: 24,
              result: 'Opened Keynote'
            }
          }
        ]
      }
    ])

    render(
      <ChatToolRows
        tools={[
          {
            name: 'computer_task',
            status: 'completed',
            result: 'Done. Task reference: act_1.'
          }
        ]}
      />
    )

    expect(taskReferenceFromResult('Done. Task reference: act_1.')).toBe('act_1')
    await user.click(screen.getByRole('button', { name: /Work done/ }))
    await user.click(screen.getByRole('button', { name: 'Computer Use, complete' }))
    expect(await screen.findByText('Computer Use details')).toBeTruthy()
    expect(screen.queryByText(/Task reference/)).toBeNull()
    await user.click(screen.getByRole('button', { name: /Click Keynote/ }))
    expect(await screen.findByText('Open Keynote')).toBeTruthy()
    expect(screen.getByText('Opened Keynote')).toBeTruthy()
  })
})
