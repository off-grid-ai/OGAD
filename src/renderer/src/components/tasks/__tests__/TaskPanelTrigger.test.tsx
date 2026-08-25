// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { onOpenTaskSidePanel } from '@renderer/lib/task-side-panel'
import { resetTaskSessionStoreForTests } from '@renderer/lib/task-session-store'
import { TaskPanelTrigger } from '../TaskPanelTrigger'

let emitTask: (task: unknown) => void

beforeEach(() => {
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
  it('is always visible and reopens the unified task panel', () => {
    const open = vi.fn()
    const off = onOpenTaskSidePanel(open)
    render(
      <TooltipProvider>
        <TaskPanelTrigger />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByLabelText('Tasks'))
    expect(open).toHaveBeenCalledWith({})
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
})
