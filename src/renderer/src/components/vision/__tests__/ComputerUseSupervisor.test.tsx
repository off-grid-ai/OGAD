// @vitest-environment jsdom
/**
 * The floating computer-use supervisor panel: idle until a task runs, then the
 * goal + truthful phase, current action, device warning, and live step feed,
 * with explicit controls routed through the vision IPC. Same feed as the
 * in-app overlay; the preload feed is the only fake.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputerUseSupervisor } from '../ComputerUseSupervisor'

type Listener = (payload: unknown) => void

let emitState: Listener
let emitStep: Listener
const control = vi.fn(async () => true)
let getCurrent = vi.fn(async () => ({ state: null as unknown, steps: [] as string[] }))

beforeEach(() => {
  control.mockClear()
  getCurrent = vi.fn(async () => ({ state: null as unknown, steps: [] as string[] }))
  window.api = {
    vision: {
      control,
      getCurrent,
      onTaskState: (cb: Listener) => {
        emitState = cb
        return () => {}
      },
      onStep: (cb: Listener) => {
        emitStep = cb
        return () => {}
      }
    }
  } as never
})

afterEach(cleanup)

describe('<ComputerUseSupervisor/>', () => {
  it('shows a waiting state before any task', () => {
    render(<ComputerUseSupervisor />)
    expect(screen.getByText(/Waiting for a task/)).toBeTruthy()
  })

  it('shows which device it controls and the truthful live step state', async () => {
    render(<ComputerUseSupervisor />)
    emitState({
      taskId: 'v1',
      goal: 'send hi to Dishit on Slack',
      status: 'running',
      phase: 'thinking',
      currentStep: 2,
      currentAction: 'Choosing the next action',
      executionDeviceName: 'Studio Mac'
    })
    await waitFor(() => expect(screen.getByText('send hi to Dishit on Slack')).toBeTruthy())
    expect(screen.getByText(/Controls Studio Mac/)).toBeTruthy()
    expect(screen.getByText('Do not use its mouse or keyboard while this task runs.')).toBeTruthy()
    expect(screen.getByText('Choosing the next action')).toBeTruthy()
    expect(screen.getAllByText('thinking')).toHaveLength(2)
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('Esc stops the task')).toBeTruthy()
    expect(screen.queryByText(/move the mouse/i)).toBeNull()
    emitStep({ taskId: 'v1', note: 'typed into [67] Message to Dishit' })
    await waitFor(() => expect(screen.getByText('typed into [67] Message to Dishit')).toBeTruthy())
  })

  it('offers Pause, Take Over, Resume, and Stop as explicit controls', async () => {
    render(<ComputerUseSupervisor />)
    emitState({ taskId: 'controls', goal: 'Update the file', status: 'running' })
    await waitFor(() => screen.getByText('Take Over'))

    fireEvent.click(screen.getByText('Pause'))
    fireEvent.click(screen.getByText('Take Over'))
    expect(control).toHaveBeenCalledWith('pause', 'controls')
    expect(control).toHaveBeenCalledWith('takeover', 'controls')

    emitState({ taskId: 'controls', goal: 'Update the file', status: 'paused', phase: 'paused' })
    await waitFor(() => screen.getByText('Resume'))
    fireEvent.click(screen.getByText('Resume'))
    expect(control).toHaveBeenCalledWith('resume', 'controls')
  })

  it('does not claim Esc works when runtime registration failed', async () => {
    render(<ComputerUseSupervisor />)
    emitState({
      taskId: 'no-esc',
      goal: 'Update the file',
      status: 'running',
      notice: 'Esc is unavailable. Use Stop or Take Over in the task controls.'
    })
    expect(await screen.findByText('Esc unavailable. Use task controls.')).toBeTruthy()
    expect(screen.queryByText('Esc stops the task')).toBeNull()
  })

  it('Stop routes to the vision control IPC', async () => {
    render(<ComputerUseSupervisor />)
    emitState({ taskId: 'v2', goal: 'x', status: 'running' })
    await waitFor(() => screen.getByText('Stop'))
    fireEvent.click(screen.getByText('Stop'))
    expect(control).toHaveBeenCalledWith('stop', 'v2')
  })

  it('seeds from getCurrent when it mounts mid-task (catches missed steps)', async () => {
    // The window opened after the rail already ran a few steps; the buffered
    // history must appear, not just live events from here on.
    getCurrent.mockResolvedValue({
      state: { taskId: 'v9', goal: 'play Drake on Spotify', status: 'running' },
      steps: ['key cmd k', 'typed "Drake" into [3]']
    })
    render(<ComputerUseSupervisor />)
    await waitFor(() => expect(screen.getByText('play Drake on Spotify')).toBeTruthy())
    expect(screen.getByText('typed "Drake" into [3]')).toBeTruthy()
  })

  it('shows the final summary and no controls when the task ends', async () => {
    render(<ComputerUseSupervisor />)
    emitState({ taskId: 'v3', goal: 'x', status: 'running' })
    await waitFor(() => screen.getByText('Stop'))
    emitState({ taskId: 'v3', goal: 'x', status: 'done', summary: 'Sent the message.' })
    await waitFor(() => expect(screen.getByText('Sent the message.')).toBeTruthy())
    expect(screen.queryByText('Stop')).toBeNull()
  })
})
