// @vitest-environment jsdom
/**
 * The inline action surface: a pending gate renders as a card whose Approve/
 * Edit/Reject resolve through the engine gate; outcomes land as verified
 * confirmations with Undo when the handler can reverse the effect. The
 * preload feed is the only fake - the component logic is real.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActionGateDock } from '../ActionGateDock'

type Listener = (payload: unknown) => void

let emitPending: Listener
let emitOutcome: Listener
const resolveGate = vi.fn(async () => true)
const undo = vi.fn(async () => ({ ok: true }))

beforeEach(() => {
  resolveGate.mockClear()
  undo.mockClear()
  window.api = {
    actions: {
      resolveGate,
      undo,
      onGatePending: (cb: Listener) => {
        emitPending = cb
        return () => {}
      },
      onOutcome: (cb: Listener) => {
        emitOutcome = cb
        return () => {}
      }
    }
  } as never
})

afterEach(cleanup)

const request = {
  actionId: 'act_1',
  actionType: 'message',
  title: 'Send a message to Ali',
  args: { to: 'ali@x.test', text: 'the deck is ready' },
  risk: 'irreversible'
}

describe('<ActionGateDock/>', () => {
  it('renders nothing until something needs attention', () => {
    const { container } = render(<ActionGateDock />)
    expect(container.firstChild).toBeNull()
  })

  it('a pending gate renders the card with resolved values and the risk', async () => {
    render(<ActionGateDock />)
    emitPending(request)
    await waitFor(() => expect(screen.getByTestId('gate-card')).toBeTruthy())
    expect(screen.getByText('Send a message to Ali')).toBeTruthy()
    expect(screen.getByText('ali@x.test')).toBeTruthy()
    expect(screen.getByText('irreversible')).toBeTruthy()
  })

  it('Approve resolves the gate with the approve decision', async () => {
    render(<ActionGateDock />)
    emitPending(request)
    await waitFor(() => screen.getByTestId('gate-card'))
    fireEvent.click(screen.getByText('Approve'))
    expect(resolveGate).toHaveBeenCalledWith('act_1', { kind: 'approve' })
  })

  it('Reject declines; the card clears when the outcome arrives', async () => {
    render(<ActionGateDock />)
    emitPending(request)
    await waitFor(() => screen.getByTestId('gate-card'))
    fireEvent.click(screen.getByText('Reject'))
    expect(resolveGate).toHaveBeenCalledWith('act_1', {
      kind: 'reject',
      reason: 'declined in chat'
    })
    emitOutcome({ id: 'act_1', outcome: 'rejected', record: { intent: 'Send a message to Ali' } })
    await waitFor(() => expect(screen.queryByTestId('gate-card')).toBeNull())
    expect(screen.getByText(/Declined/)).toBeTruthy()
  })

  it('Edit turns the args editable and Save sends the edited payload for re-gating', async () => {
    render(<ActionGateDock />)
    emitPending(request)
    await waitFor(() => screen.getByTestId('gate-card'))
    fireEvent.click(screen.getByText('Edit'))
    const field = screen.getByLabelText('edit text') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'the v2 deck is ready' } })
    fireEvent.click(screen.getByText('Save changes'))
    expect(resolveGate).toHaveBeenCalledWith('act_1', {
      kind: 'edit',
      args: { to: 'ali@x.test', text: 'the v2 deck is ready' }
    })
  })

  it('a done outcome shows the verified confirmation, and Undo reverses it', async () => {
    render(<ActionGateDock />)
    emitOutcome({
      id: 'act_2',
      outcome: 'done',
      undoable: true,
      record: { type: 'reminder', intent: 'Create the reminder "Send the deck"', effectId: 'rt1' }
    })
    await waitFor(() => screen.getByTestId('outcome-row'))
    expect(screen.getByText(/Done - verified/)).toBeTruthy()
    fireEvent.click(screen.getByText('Undo'))
    await waitFor(() => expect(screen.getByText(/Undone/)).toBeTruthy())
    expect(undo).toHaveBeenCalled()
  })

  it('a non-undoable outcome offers no Undo, and needs_help reads honestly', async () => {
    render(<ActionGateDock />)
    emitOutcome({ id: 'act_3', outcome: 'needs_help', undoable: false, record: {} })
    await waitFor(() => screen.getByTestId('outcome-row'))
    expect(screen.queryByText('Undo')).toBeNull()
    expect(screen.getByText(/needs your attention/)).toBeTruthy()
  })

  it('Dismiss clears an outcome row', async () => {
    render(<ActionGateDock />)
    emitOutcome({ id: 'act_4', outcome: 'done', undoable: false, record: {} })
    await waitFor(() => screen.getByTestId('outcome-row'))
    fireEvent.click(screen.getByLabelText('Dismiss'))
    await waitFor(() => expect(screen.queryByTestId('outcome-row')).toBeNull())
  })
})
