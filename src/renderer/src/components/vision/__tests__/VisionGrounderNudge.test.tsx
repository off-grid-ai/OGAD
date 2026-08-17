// @vitest-environment jsdom
/**
 * The grounder nudge in the chat: renders nothing until a computer-use run
 * reports a non-grounder notice, then shows it via the shared MessageNudge look
 * (the max-token cutoff bar). Deterministic - driven by the vision feed, not the
 * model's phrasing - dismissable, and cleared by a run with no notice.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VisionGrounderNudge } from '../VisionGrounderNudge'

type Listener = (payload: unknown) => void
let emitState: Listener

beforeEach(() => {
  window.api = {
    vision: {
      control: async () => true,
      onStep: () => () => {},
      onTaskState: (cb: Listener) => {
        emitState = cb
        return () => {}
      }
    }
  } as never
})

afterEach(cleanup)

describe('<VisionGrounderNudge/>', () => {
  it('renders nothing until a run reports a notice', () => {
    const { container } = render(<VisionGrounderNudge />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the notice (in the shared nudge look) when the model is not a grounder', async () => {
    render(<VisionGrounderNudge />)
    emitState({
      taskId: 'v1',
      goal: 'x',
      status: 'running',
      notice:
        'The current model is not a grounding model, so computer use may click the wrong place.'
    })
    await waitFor(() => screen.getByRole('status'))
    expect(screen.getByText(/may click the wrong place/)).toBeTruthy()
  })

  it('is dismissable', async () => {
    render(<VisionGrounderNudge />)
    emitState({ taskId: 'v2', goal: 'x', status: 'running', notice: 'load a grounder' })
    await waitFor(() => screen.getByRole('status'))
    fireEvent.click(screen.getByLabelText('Dismiss'))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('a run with no notice (a grounder is loaded) clears any stale nudge', async () => {
    render(<VisionGrounderNudge />)
    emitState({ taskId: 'v3', goal: 'x', status: 'running', notice: 'load a grounder' })
    await waitFor(() => screen.getByRole('status'))
    emitState({ taskId: 'v4', goal: 'x', status: 'running' })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })
})
