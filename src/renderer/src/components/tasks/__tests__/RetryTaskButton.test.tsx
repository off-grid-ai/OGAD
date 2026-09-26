// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskSession } from '@renderer/lib/task-session-store'
import { RetryTaskButton } from '../RetryTaskButton'

const task: TaskSession = {
  taskId: 'failed-web-task',
  journeyId: 'journey-a',
  kind: 'web_use',
  title: 'Find nearby restaurants',
  status: 'failed',
  steps: [],
  startedAt: 1,
  updatedAt: 2
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('<RetryTaskButton/>', () => {
  it('enables retry when the earlier run finishes stopping', async () => {
    const retryAvailability = vi
      .fn()
      .mockResolvedValueOnce({
        available: false,
        reason: 'The earlier run is still stopping.'
      })
      .mockResolvedValueOnce({ available: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        tasks: {
          retryAvailability,
          retry: vi.fn()
        }
      }
    })

    render(<RetryTaskButton task={task} />)
    await act(async () => Promise.resolve())
    expect(
      (screen.getByRole('button', { name: 'Continue unavailable' }) as HTMLButtonElement).disabled
    ).toBe(true)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    expect(retryAvailability).toHaveBeenCalledTimes(2)
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })
})
