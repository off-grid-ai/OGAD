// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { closeTaskWorkspace, onOpenTaskSidePanel } from '@renderer/lib/task-side-panel'
import { resetTaskSessionStoreForTests } from '@renderer/lib/task-session-store'
import { TaskPanelTrigger } from '../TaskPanelTrigger'

let emitTask: (task: unknown) => void

beforeEach(() => {
  closeTaskWorkspace()
  resetTaskSessionStoreForTests()
  window.api = {
    tasks: {
      list: vi.fn(async () => []),
      onChanged: (listener: (task: unknown) => void) => {
        emitTask = listener
        return () => {}
      }
    }
  } as never
})

afterEach(cleanup)

describe('<TaskPanelTrigger/>', () => {
  it('toggles the complete task workspace from the Chat header', () => {
    const open = vi.fn()
    const off = onOpenTaskSidePanel(open)
    render(
      <TooltipProvider>
        <TaskPanelTrigger />
      </TooltipProvider>
    )
    const trigger = screen.getByLabelText('Tasks')
    expect(trigger.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(trigger)
    expect(open).toHaveBeenCalledWith({})
    const close = screen.getByLabelText('Close Tasks')
    expect(close.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(close)
    expect(screen.getByLabelText('Tasks').getAttribute('aria-pressed')).toBe('false')
    expect(open).toHaveBeenCalledTimes(1)
    off()
  })

  it('shows one badge for running and needs-attention runs', async () => {
    render(
      <TooltipProvider>
        <TaskPanelTrigger />
      </TooltipProvider>
    )
    emitTask({
      taskId: 'web-failed',
      kind: 'web_use',
      title: 'Research',
      status: 'failed',
      steps: [],
      startedAt: 1,
      updatedAt: 2
    })
    await waitFor(() => expect(screen.getByTestId('task-attention-badge').textContent).toBe('1'))
    expect(screen.getByLabelText('Tasks, 1 need attention')).toBeTruthy()
  })

  it('counts only tasks owned by the current Chat', async () => {
    render(
      <TooltipProvider>
        <TaskPanelTrigger conversationId="chat-current" />
      </TooltipProvider>
    )
    emitTask({
      taskId: 'web-other',
      journeyId: 'chat-other',
      kind: 'web_use',
      title: 'Other task',
      status: 'failed',
      steps: [],
      startedAt: 1,
      updatedAt: 2
    })
    await waitFor(() => expect(screen.queryByTestId('task-attention-badge')).toBeNull())

    emitTask({
      taskId: 'web-current',
      journeyId: 'chat-current',
      kind: 'web_use',
      title: 'Current task',
      status: 'running',
      steps: [],
      startedAt: 3,
      updatedAt: 4
    })
    await waitFor(() => expect(screen.getByTestId('task-attention-badge').textContent).toBe('1'))
  })
})
