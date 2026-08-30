// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatToolRows } from '../ChatToolRows'
import { taskReferenceFromResult } from '../chat-tool-projection'
import { resetTaskSessionStoreForTests } from '@renderer/lib/task-session-store'
import {
  closeTaskWorkspace,
  onOpenTaskSidePanel,
  type OpenTaskPanelRequest
} from '@renderer/lib/task-side-panel'

beforeEach(() => {
  resetTaskSessionStoreForTests()
  closeTaskWorkspace()
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      tasks: {
        list: vi.fn(async () => []),
        retryAvailability: vi.fn(async () => ({ available: false, reason: 'Not retryable.' })),
        retry: vi.fn(async () => ({ available: false, reason: 'Not retryable.' })),
        onChanged: vi.fn(() => () => undefined)
      }
    }
  })
})

afterEach(() => {
  cleanup()
  closeTaskWorkspace()
  resetTaskSessionStoreForTests()
})

describe('<ChatToolRows/> work timeline', () => {
  it('uses the meeting search result for the collapsed summary', async () => {
    const user = userEvent.setup()
    render(
      <ChatToolRows
        tools={[
          {
            name: 'search_meetings',
            status: 'completed',
            result: 'No matching recorded meetings were found.'
          }
        ]}
      />
    )

    await user.click(screen.getByRole('button', { name: /Work done/ }))
    expect(screen.getByText('No matching recorded meetings were found.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Searched meetings, complete' }))
    expect(screen.getAllByText('No matching recorded meetings were found.')).toHaveLength(2)
    expect(screen.queryByText('Found matching items.')).toBeNull()
  })

  it('shows and opens a live Web Use task before its durable tool call arrives', async () => {
    const requests: OpenTaskPanelRequest[] = []
    const offOpen = onOpenTaskSidePanel((request) => requests.push(request))
    const user = userEvent.setup()

    render(
      <ChatToolRows
        liveTask={{
          taskId: 'web-live-before-result',
          journeyId: 'conversation-a',
          kind: 'web_use',
          title: 'Research flights',
          status: 'running',
          currentAction: 'Entering the destination airport',
          steps: [],
          startedAt: 1,
          updatedAt: 2
        }}
      />
    )

    expect(screen.getByRole('button', { name: /Working/ })).toBeTruthy()
    expect(screen.getByText('Entering the destination airport')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Web Use, running' }))
    expect(requests.at(-1)).toEqual({
      taskId: 'web-live-before-result',
      kind: 'web_use',
      detail: true
    })
    offOpen()
  })

  it('opens an old stored web_use row as canonical Web Use detail', async () => {
    const requests: OpenTaskPanelRequest[] = []
    const offOpen = onOpenTaskSidePanel((request) => requests.push(request))
    window.api.tasks!.list = vi.fn(async () => [
      {
        taskId: 'web-keyboard',
        kind: 'web_use' as const,
        title: 'Research flights',
        status: 'done' as const,
        steps: ['Opened results'],
        startedAt: 1,
        finishedAt: 2,
        updatedAt: 2
      }
    ])
    const user = userEvent.setup()
    render(
      <ChatToolRows
        tools={[{ name: 'web_use', status: 'completed', result: 'Task reference: web-keyboard.' }]}
      />
    )

    const card = await screen.findByRole('button', { name: /Work done/ })
    card.focus()
    await user.keyboard('{Enter}')
    expect(requests).toEqual([])

    const row = screen.getByRole('button', { name: 'Web Use, complete' })
    await user.click(row)
    expect(requests.at(-1)).toEqual({ taskId: 'web-keyboard', kind: 'web_use', detail: true })

    const toggle = screen.getByRole('button', { name: 'Close task details' })
    await user.click(toggle)
    expect(await screen.findByRole('button', { name: 'Open task details' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Open task details' }))
    expect(requests.at(-1)).toEqual({ taskId: 'web-keyboard', kind: 'web_use', detail: true })
    offOpen()
  })

  it('opens a linked Web Use row with Space when the work card is already open', async () => {
    const requests: OpenTaskPanelRequest[] = []
    const offOpen = onOpenTaskSidePanel((request) => requests.push(request))
    window.api.tasks!.list = vi.fn(async () => [
      {
        taskId: 'web-space',
        kind: 'web_use' as const,
        title: 'Watch a run',
        status: 'running' as const,
        currentAction:
          'Judge incomplete: The destination is empty. Next: Enter Pune in the destination field.',
        steps: [],
        startedAt: 1,
        updatedAt: 2
      }
    ])
    const user = userEvent.setup()
    render(
      <ChatToolRows
        tools={[{ name: 'web_use', status: 'running', result: 'Task reference: web-space.' }]}
      />
    )
    const row = await screen.findByRole('button', { name: 'Web Use, running' })
    expect(
      screen.getByText(
        'Judge incomplete: The destination is empty. Next: Enter Pune in the destination field.'
      )
    ).toBeTruthy()
    row.focus()
    await user.keyboard(' ')
    expect(requests.at(-1)).toEqual({ taskId: 'web-space', kind: 'web_use', detail: true })
    offOpen()
  })

  it('keeps a live Web Use task as a sibling row with one short update', () => {
    render(
      <ChatToolRows
        tools={[
          { name: 'web_search', status: 'completed', result: 'Search results are ready.' },
          { name: 'web_use', status: 'running', result: '' }
        ]}
        liveTask={{
          taskId: 'web-reasoning',
          journeyId: 'conversation-a',
          kind: 'web_use',
          title: 'Research flights',
          status: 'running',
          currentAction: 'Reviewing the flight form',
          currentReasoning: 'The one-way option is visible beside the trip type control.',
          reasoningLive: true,
          steps: [],
          startedAt: 1,
          updatedAt: 2
        }}
      />
    )

    expect(screen.getByRole('button', { name: /Working/ }).textContent).toContain(
      '2 steps · running'
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Searched the web, complete' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Web Use, running' })).toBeTruthy()
    expect(screen.getByText('Reviewing the flight form')).toBeTruthy()
    expect(
      screen.queryByText('The one-way option is visible beside the trip type control.')
    ).toBeNull()
    expect(screen.queryByRole('button', { name: /Web Use (?:thinking|reasoning)/ })).toBeNull()
  })

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
          { name: 'web_use', status: 'completed', result: 'Website research complete.' },
          { name: 'computer_use', status: 'running' }
        ]}
      />
    )

    expect(screen.getByRole('button', { name: /Working/ }).textContent).toContain(
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
          { name: 'web_use', status: 'failed', result: 'Error: browser timed out' },
          { name: 'mcp__31__search_messages', status: 'completed', result: '3 messages found' }
        ]}
      />
    )
    await user.click(screen.getByRole('button', { name: /Work failed/ }))
    expect(screen.getByText('Web Use')).toBeTruthy()
    expect(screen.getByText('Searched messages')).toBeTruthy()
    expect(screen.queryByText(/web_use/)).toBeNull()
    expect(screen.queryByText('Error: browser timed out')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Web Use, failed' }))
    expect(await screen.findByText('Error: browser timed out')).toBeTruthy()
  })

  it('names work that needs the user without calling it done', () => {
    render(<ChatToolRows tools={[{ name: 'action_approval', status: 'pending', result: '' }]} />)

    const heading = screen.getByRole('button', { name: /Action needed/ })
    expect(heading.textContent).toContain('1 step · needs attention')
    expect(screen.queryByRole('button', { name: /Work done/ })).toBeNull()
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
            name: 'computer_use',
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
    // The prompt echo (modelInput) is no longer persisted or shown - it was 73% of the task
    // payload on every list poll. The decision and result below are what the row is for.
    expect(screen.queryByText('Open Keynote')).toBeNull()
    expect(screen.getByText('Opened Keynote')).toBeTruthy()
  })

  it('projects a linked Web Use failure into the originating Chat work card', async () => {
    let changed: ((task: unknown) => void) | undefined
    window.api.tasks!.onChanged = vi.fn((listener) => {
      changed = listener
      return () => undefined
    })
    window.api.tasks!.retryAvailability = vi.fn(async () => ({ available: true }))
    window.api.tasks!.retry = vi.fn(async () => ({
      available: true,
      taskId: 'web-flight-retry',
      journeyId: 'chat-flight'
    }))

    render(
      <ChatToolRows
        tools={[
          {
            name: 'web_use',
            status: 'completed',
            result: 'The task is in progress. Task reference: web-flight.'
          }
        ]}
      />
    )

    await waitFor(() => expect(changed).toBeTypeOf('function'))
    act(() => {
      changed?.({
        taskId: 'web-flight',
        journeyId: 'chat-flight',
        kind: 'web_use',
        title: 'Find a flight',
        status: 'failed',
        summary: 'The traveler control could not be completed.',
        steps: [],
        startedAt: 1,
        finishedAt: 2,
        updatedAt: 2
      })
    })

    expect(screen.getByRole('button', { name: /Work failed/ }).textContent).toContain('failed')
    await userEvent.click(screen.getByRole('button', { name: /Work failed/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Web Use, failed' }))
    expect(screen.getAllByText('The traveler control could not be completed.')).toHaveLength(2)
    const retry = await screen.findByRole('button', { name: 'Retry' })
    await userEvent.click(retry)
    expect(window.api.tasks!.retry).toHaveBeenCalledWith('web-flight')

    act(() => {
      changed?.({
        taskId: 'web-flight-retry',
        journeyId: 'chat-flight',
        kind: 'web_use',
        title: 'Find a flight',
        status: 'running',
        summary: 'Taking a fresh look before continuing.',
        steps: ['Taking a fresh observation.'],
        startedAt: 3,
        updatedAt: 3
      })
    })
    expect(screen.getByRole('button', { name: /Working/ }).textContent).toContain('running')

    act(() => {
      changed?.({
        taskId: 'web-flight-retry',
        journeyId: 'chat-flight',
        kind: 'web_use',
        title: 'Find a flight',
        status: 'done',
        summary: 'The flight options are ready.',
        steps: ['Took a fresh observation.', 'Found the flight options.'],
        startedAt: 3,
        finishedAt: 4,
        updatedAt: 4
      })
    })
    expect(screen.getByRole('button', { name: /Work done/ }).textContent).toContain('complete')
  })

  it('shows the execution device when a synced task cannot retry here', async () => {
    window.api.tasks!.list = vi.fn(async () => [
      {
        taskId: 'remote-task',
        journeyId: 'remote-chat',
        kind: 'computer_use' as const,
        title: 'Edit the deck',
        status: 'failed' as const,
        summary: 'Keynote closed.',
        steps: [],
        startedAt: 1,
        finishedAt: 2,
        updatedAt: 2,
        executionDeviceId: 'studio-mac',
        executionDeviceName: 'Studio Mac'
      }
    ])
    window.api.tasks!.retryAvailability = vi.fn(async () => ({
      available: false,
      reason: 'Retry this task on Studio Mac.',
      executionDeviceId: 'studio-mac',
      executionDeviceName: 'Studio Mac'
    }))

    render(
      <ChatToolRows
        tools={[
          {
            name: 'computer_use',
            status: 'failed',
            result: 'Task reference: remote-task.'
          }
        ]}
      />
    )

    await userEvent.click(await screen.findByRole('button', { name: /Work failed/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Computer Use, failed' }))
    const retry = await screen.findByRole('button', { name: 'Retry on Studio Mac' })
    expect((retry as HTMLButtonElement).disabled).toBe(true)
  })
})
