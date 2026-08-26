// @vitest-environment jsdom
/**
 * The watched pane: nothing until a task runs, then the live browser + goal, and at
 * the identity boundary a takeover prompt whose Resume/Cancel resolve through the
 * browser IPC. Step narration now streams in the chat, not here. The preload feed is
 * the only fake; the component is real.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchedBrowserPane } from '../WatchedBrowserPane'

type Listener = (payload: unknown) => void

let emitState: Listener
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
      onStep: () => () => {},
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

  it('shows the goal once a task starts (steps stream in the chat, not here)', async () => {
    render(<WatchedBrowserPane />)
    emitState({ taskId: 't1', goal: 'check in for my flight', status: 'running' })
    await waitFor(() => screen.getByTestId('watched-browser-pane'))
    expect(screen.getByText('check in for my flight')).toBeTruthy()
    // No step feed here anymore - the narration goes to the chat turn.
    expect(screen.queryByTestId('watched-step-feed')).toBeNull()
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

  it('a finished task shows its status', async () => {
    render(<WatchedBrowserPane />)
    emitState({ taskId: 't4', goal: 'check in', status: 'done', summary: 'checked in, seat 14C' })
    await waitFor(() => screen.getByTestId('watched-browser-pane'))
    expect(screen.getByText('done')).toBeTruthy()
  })

  it('a new running task clears a stale takeover', async () => {
    render(<WatchedBrowserPane />)
    emitState({ taskId: 't5', goal: 'first', status: 'running' })
    await waitFor(() => screen.getByTestId('watched-browser-pane'))
    emitTakeover({ taskId: 't5', why: 'sign in' })
    await waitFor(() => screen.getByText(/sign in/))
    emitState({ taskId: 't6', goal: 'second', status: 'running' })
    await waitFor(() => screen.getByText('second'))
    expect(screen.queryByText(/sign in/)).toBeNull()
  })

  it('the close button stops the task and dismisses the pane', async () => {
    const control = vi.fn(async () => true)
    ;(window.api as unknown as { vision: unknown }).vision = { control }
    render(<WatchedBrowserPane />)
    emitState({ taskId: 't7', goal: 'x', status: 'running' })
    await waitFor(() => screen.getByTestId('watched-browser-pane'))
    fireEvent.click(screen.getByTestId('watched-close'))
    expect(control).toHaveBeenCalledWith('stop')
    await waitFor(() => expect(screen.queryByTestId('watched-browser-pane')).toBeNull())
  })

  it('the split is resizable by dragging its left edge', async () => {
    render(<WatchedBrowserPane />)
    emitState({ taskId: 't8', goal: 'x', status: 'running' })
    const pane = await waitFor(() => screen.getByTestId('watched-browser-pane'))
    const before = pane.style.width
    fireEvent.mouseDown(screen.getByTestId('watched-resize-handle'))
    fireEvent.mouseMove(window, { clientX: 300 })
    fireEvent.mouseUp(window)
    expect(pane.style.width).not.toBe(before) // the drag changed the split width
  })
})
