// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickConnections } from '../QuickConnections'
import { rowToReconnect } from '../useQuickConnection'

let records: Array<{ id: number; name: string; url: string; status: string; enabled: number }>
let testResult: { ok: boolean; error?: string }
let resolveTest: ((value: { ok: boolean }) => void) | undefined
let waitForLogin: boolean
const api = {
  mcpList: vi.fn(async () => [...records]),
  mcpAdd: vi.fn(async (entry) => {
    records.push({ ...entry, id: 7, status: 'unknown', enabled: 0 })
    return 7
  }),
  mcpTest: vi.fn(async () => {
    const result = waitForLogin
      ? await new Promise<{ ok: boolean }>((resolve) => {
          resolveTest = resolve
        })
      : testResult
    if (result.ok && records[0]) records[0].status = 'ok'
    return result
  }),
  mcpSetEnabled: vi.fn(async (_id, enabled) => {
    if (records[0]) records[0].enabled = Number(enabled)
  }),
  mcpRemove: vi.fn(async () => {
    records = []
  }),
  mcpCancel: vi.fn(async () => {
    resolveTest?.({ ok: false })
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  records = []
  testResult = { ok: true }
  waitForLogin = false
  resolveTest = undefined
  Object.defineProperty(window, 'api', { configurable: true, value: api })
})
afterEach(cleanup)
describe('quick connections', () => {
  it('connects directly once and shows verified success', async () => {
    const user = userEvent.setup()
    render(<QuickConnections />)
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Connect' })[0]?.hasAttribute('disabled')).toBe(
        false
      )
    )
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]!)
    await screen.findByText('1 connected')
    expect(api.mcpAdd).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://mcp.notion.com/mcp', liveOnly: true })
    )
    expect(api.mcpSetEnabled).toHaveBeenCalledWith(7, true)
    expect(api.mcpRemove).not.toHaveBeenCalled()
  })
  it('removes failed setup, shows the error, and permits retry', async () => {
    testResult = { ok: false, error: 'Access was denied.' }
    const user = userEvent.setup()
    render(<QuickConnections />)
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Connect' })[0]?.hasAttribute('disabled')).toBe(
        false
      )
    )
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]!)
    await screen.findByText('Access was denied.')
    expect(api.mcpRemove).toHaveBeenCalledWith(7)
    expect(api.mcpSetEnabled).not.toHaveBeenCalled()
    testResult = { ok: true }
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]!)
    await screen.findByText('1 connected')
  })
  it('cancels pending sign-in without marking the connection ready', async () => {
    waitForLogin = true
    const user = userEvent.setup()
    const onBusyChange = vi.fn()
    render(<QuickConnections onBusyChange={onBusyChange} />)
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Connect' })[0]?.hasAttribute('disabled')).toBe(
        false
      )
    )
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[0]!)
    await user.click(await screen.findByRole('button', { name: 'Cancel Notion sign-in' }))
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false))
    expect(api.mcpCancel).toHaveBeenCalledWith(7)
    expect(api.mcpSetEnabled).not.toHaveBeenCalled()
    expect(screen.queryByText('Connected')).toBeNull()
  })
})

describe('rowToReconnect', () => {
  const row = (
    id: number,
    status: string,
    enabled = 1
  ): { id: number; name: string; url: string; status: string; enabled: number } => ({
    id,
    name: `Notion ${id}`,
    url: 'https://mcp.notion.com/mcp',
    status,
    enabled
  })
  it('picks the account that needs it, not just the first', () => {
    expect(rowToReconnect([row(1, 'ok'), row(2, 'error')], 'https://mcp.notion.com/mcp')?.id).toBe(
      2
    )
    expect(rowToReconnect([row(1, 'ok'), row(2, 'ok', 0)], 'https://mcp.notion.com/mcp')?.id).toBe(
      2
    )
    expect(rowToReconnect([row(1, 'ok')], 'https://mcp.notion.com/mcp')?.id).toBe(1)
    expect(rowToReconnect([row(1, 'error')], 'https://mcp.linear.app/mcp')).toBeUndefined()
  })
})
