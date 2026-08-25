// @vitest-environment jsdom
/**
 * The vision supervisor overlay: nothing until a task runs, then the live step
 * feed with Stop/Pause routed through the vision IPC, a Resume when paused, and
 * an honest final state. The preload feed is the only fake.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VisionSupervisorOverlay } from '../VisionSupervisorOverlay'

type Listener = (payload: unknown) => void

let emitState: Listener
let emitStep: Listener
const control = vi.fn(async () => true)

beforeEach(() => {
  control.mockClear()
  window.api = {
    vision: {
      control,
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

describe('<VisionSupervisorOverlay/>', () => {
  it('renders nothing until a task is running', () => {
    const { container } = render(<VisionSupervisorOverlay />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the goal, the takeover hint, and the live step feed', async () => {
    render(<VisionSupervisorOverlay />)
    emitState({ taskId: 'v1', goal: 'share the deck over WhatsApp', status: 'running' })
    await waitFor(() => screen.getByTestId('vision-supervisor-overlay'))
    expect(screen.getByText('share the deck over WhatsApp')).toBeTruthy()
    expect(screen.getByText(/Move the mouse or press Esc to take over/)).toBeTruthy()
    emitStep({ taskId: 'v1', note: 'clicked at (500, 400)' })
    await waitFor(() => expect(screen.getByText('clicked at (500, 400)')).toBeTruthy())
  })

  it('Stop routes to the vision control IPC', async () => {
    render(<VisionSupervisorOverlay />)
    emitState({ taskId: 'v2', goal: 'x', status: 'running' })
    await waitFor(() => screen.getByTestId('vision-supervisor-overlay'))
    fireEvent.click(screen.getByText('Stop'))
    expect(control).toHaveBeenCalledWith('stop')
  })

  it('Pause is shown while running and becomes Resume when paused', async () => {
    render(<VisionSupervisorOverlay />)
    emitState({ taskId: 'v3', goal: 'x', status: 'running' })
    await waitFor(() => screen.getByText('Pause'))
    fireEvent.click(screen.getByText('Pause'))
    expect(control).toHaveBeenCalledWith('pause')
    emitState({ taskId: 'v3', goal: 'x', status: 'paused' })
    await waitFor(() => screen.getByText('Resume'))
    fireEvent.click(screen.getByText('Resume'))
    expect(control).toHaveBeenCalledWith('resume')
  })

  it('a finished task shows its status and summary and drops the controls', async () => {
    render(<VisionSupervisorOverlay />)
    emitState({ taskId: 'v4', goal: 'x', status: 'done', summary: 'shared the file' })
    await waitFor(() => screen.getByText('shared the file'))
    expect(screen.getByText('done')).toBeTruthy()
    expect(screen.queryByText('Stop')).toBeNull()
  })

  it('shows the grounder notice when the model is not a grounder, without blocking', async () => {
    render(<VisionSupervisorOverlay />)
    emitState({
      taskId: 'v7',
      goal: 'share the deck',
      status: 'running',
      notice:
        'The current model is not a grounding model, so computer use may click the wrong place.'
    })
    await waitFor(() => screen.getByTestId('vision-model-notice'))
    expect(screen.getByText(/may click the wrong place/)).toBeTruthy()
    // The task still runs - the controls are present, nothing is blocked.
    expect(screen.getByText('Stop')).toBeTruthy()
  })

  it('shows no notice when the model is a grounder', async () => {
    render(<VisionSupervisorOverlay />)
    emitState({ taskId: 'v8', goal: 'x', status: 'running' })
    await waitFor(() => screen.getByTestId('vision-supervisor-overlay'))
    expect(screen.queryByTestId('vision-model-notice')).toBeNull()
  })

  it('a new task clears the previous run feed', async () => {
    render(<VisionSupervisorOverlay />)
    emitState({ taskId: 'v5', goal: 'first', status: 'running' })
    await waitFor(() => screen.getByTestId('vision-supervisor-overlay'))
    emitStep({ taskId: 'v5', note: 'step from the first task' })
    await waitFor(() => screen.getByText('step from the first task'))
    emitState({ taskId: 'v6', goal: 'second', status: 'running' })
    await waitFor(() => screen.getByText('second'))
    expect(screen.queryByText('step from the first task')).toBeNull()
  })
})
