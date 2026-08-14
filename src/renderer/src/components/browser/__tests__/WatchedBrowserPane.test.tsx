// @vitest-environment jsdom
/**
 * The watched pane: nothing until a task runs, then the live step feed, and at
 * the identity boundary a takeover prompt whose Resume/Cancel resolve through
 * the browser IPC. The preload feed is the only fake; the component is real.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchedBrowserPane } from '../WatchedBrowserPane'

type Listener = (payload: unknown) => void

let emitState: Listener
let emitStep: Listener
let emitTakeover: Listener
const resolveTakeover = vi.fn(async () => true)

beforeEach(() => {
  resolveTakeover.mockClear()
  window.api = {
    browser: {
      resolveTakeover,
      onTaskState: (cb: Listener) => {
        emitState = cb
        return () => {}
      },
      onStep: (cb: Listener) => {
        emitStep = cb
        return () => {}
      },
      onTakeover: (cb: Listener) => {
        emitTakeover = cb
        return () => {}
      }
    }
  } as never
})

afterEach(cleanup)

describe('<WatchedBrowserPane/>', () => {
  it('renders nothing until a task is running', () => {
    const { container } = render(<WatchedBrowserPane />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the goal and the live step feed once a task starts', async () => {
    render(<WatchedBrowserPane />)
    emitState({ taskId: 't1', goal: 'check in for my flight', status: 'running' })
    await waitFor(() => screen.getByTestId('watched-browser-pane'))
    expect(screen.getByText('check in for my flight')).toBeTruthy()
    emitStep({ taskId: 't1', note: 'opened the airline site' })
    emitStep({ taskId: 't1', note: 'clicked [3] Check in' })
    await waitFor(() => expect(screen.getByText('clicked [3] Check in')).toBeTruthy())
  })

  it('a takeover prompt appears and Resume resolves it through IPC', async () => {
    render(<WatchedBrowserPane />)
    emitState({ taskId: 't2', goal: 'order lunch', status: 'running' })
    await waitFor(() => screen.getByTestId('watched-browser-pane'))
    emitTakeover({ taskId: 't2', why: 'sign in to your account to continue' })
    await waitFor(() => expect(screen.getByText(/sign in to your account/)).toBeTruthy())
    // The privacy promise is stated on the surface, not just in the code.
    expect(screen.getByText(/never sees your password/)).toBeTruthy()
    fireEvent.click(screen.getByText('Resume'))
    expect(resolveTakeover).toHaveBeenCalledWith('t2', 'resumed')
    await waitFor(() => expect(screen.queryByText(/sign in to your account/)).toBeNull())
  })

  it('Cancel task resolves the takeover as cancelled', async () => {
    render(<WatchedBrowserPane />)
    emitState({ taskId: 't3', goal: 'x', status: 'running' })
    await waitFor(() => screen.getByTestId('watched-browser-pane'))
    emitTakeover({ taskId: 't3', why: 'pay to confirm' })
    await waitFor(() => screen.getByText('Cancel task'))
    fireEvent.click(screen.getByText('Cancel task'))
    expect(resolveTakeover).toHaveBeenCalledWith('t3', 'cancelled')
  })

  it('a finished task shows its status and summary', async () => {
    render(<WatchedBrowserPane />)
    emitState({
      taskId: 't4',
      goal: 'check in',
      status: 'done',
      summary: 'checked in, seat 14C'
    })
    await waitFor(() => screen.getByText('checked in, seat 14C'))
    expect(screen.getByText('done')).toBeTruthy()
  })

  it('a new running task clears the previous run feed and any stale takeover', async () => {
    render(<WatchedBrowserPane />)
    emitState({ taskId: 't5', goal: 'first', status: 'running' })
    await waitFor(() => screen.getByTestId('watched-browser-pane'))
    emitStep({ taskId: 't5', note: 'step from the first task' })
    emitTakeover({ taskId: 't5', why: 'sign in' })
    await waitFor(() => screen.getByText(/sign in/))
    emitState({ taskId: 't6', goal: 'second', status: 'running' })
    await waitFor(() => screen.getByText('second'))
    expect(screen.queryByText('step from the first task')).toBeNull()
    expect(screen.queryByText(/sign in/)).toBeNull()
  })
})
