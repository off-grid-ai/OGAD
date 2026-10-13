// @vitest-environment jsdom

/**
 * A connector can be changed and removed from its detail view.
 *
 * The real connectors screen runs; the main-process connector service is the only fake, keeping
 * its connectors in memory and answering over the preload API the way it does in the app. The
 * test reads what the screen shows and what the service holds afterwards.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(() => {
  cleanup()
})

interface Row {
  id: number
  name: string
  transport: 'http' | 'stdio'
  command: string | null
  args: string | null
  url: string | null
  enabled: number
  status: string
  status_detail: string | null
  tools: string | null
  last_synced: null
  synced_count: number
}

// The screen reads window.api once, when it is first imported, so the service is one object
// whose connectors are reset for each test.
const rows: Row[] = []

function installConnectorService(): { rows: Row[] } {
  rows.splice(
    0,
    rows.length,
    ...([
      {
        id: 3,
        name: 'Team notes',
        transport: 'http',
        command: null,
        args: null,
        url: 'https://notes.example.test/mcp',
        enabled: 1,
        status: 'ok',
        status_detail: null,
        tools: JSON.stringify([{ name: 'search_notes' }]),
        last_synced: null,
        synced_count: 0
      }
    ] satisfies Row[])
  )
  ;(window as unknown as { api: unknown }).api = {
    mcpList: async () => rows.map((row) => ({ ...row })),
    mcpItems: async () => [],
    mcpUpdate: async (id: number, changes: { name?: string; url?: string }) => {
      const row = rows.find((r) => r.id === id)!
      if (!changes.name?.trim()) throw new Error('Enter a name.')
      const moved = changes.url !== undefined && changes.url !== row.url
      Object.assign(row, {
        name: changes.name.trim(),
        url: changes.url ?? row.url,
        ...(moved
          ? {
              tools: null,
              status: 'unknown',
              status_detail: 'Settings changed. Test the connection.'
            }
          : {})
      })
      return { ...row }
    },
    mcpRemove: async (id: number) => {
      rows.splice(
        rows.findIndex((r) => r.id === id),
        1
      )
    }
  }
  return { rows }
}

describe('connector edit and remove', () => {
  it('renames a connector and moves it to a new address, which needs a new test', async () => {
    const service = installConnectorService()
    const { ConnectorsScreen } = await import('../ConnectorsScreen')
    const user = userEvent.setup()
    render(<ConnectorsScreen />)

    await user.click(await screen.findByRole('button', { name: /Team notes.*connected/i }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('form', { name: 'Edit Team notes' })
    const name = within(form).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'Shared notes')
    const address = within(form).getByLabelText('Server address')
    await user.clear(address)
    await user.type(address, 'https://notes2.example.test/mcp')
    await user.click(within(form).getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('heading', { name: 'Shared notes' })).toBeTruthy()
    expect(screen.getByText('not tested')).toBeTruthy()
    expect(screen.queryByRole('form', { name: /Edit/ })).toBeNull()
    expect(service.rows[0]).toMatchObject({
      name: 'Shared notes',
      url: 'https://notes2.example.test/mcp',
      tools: null
    })
  })

  it('keeps the form open and says why when a change is refused', async () => {
    installConnectorService()
    const { ConnectorsScreen } = await import('../ConnectorsScreen')
    const user = userEvent.setup()
    render(<ConnectorsScreen />)

    await user.click(await screen.findByRole('button', { name: /Team notes.*connected/i }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('form', { name: 'Edit Team notes' })
    await user.clear(within(form).getByLabelText('Name'))
    await user.click(within(form).getByRole('button', { name: 'Save' }))

    expect(await within(form).findByText('Enter a name.')).toBeTruthy()
  })

  it('asks before removing, keeps the connector on Keep, and removes it on Remove', async () => {
    const service = installConnectorService()
    const { ConnectorsScreen } = await import('../ConnectorsScreen')
    const user = userEvent.setup()
    render(<ConnectorsScreen />)

    await user.click(await screen.findByRole('button', { name: /Team notes.*connected/i }))
    await user.click(screen.getByRole('button', { name: 'Remove Team notes' }))
    const confirm = screen.getByRole('alertdialog', { name: 'Remove Team notes?' })
    await user.click(within(confirm).getByRole('button', { name: 'Keep' }))
    expect(service.rows).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Remove Team notes' }))
    await user.click(
      within(screen.getByRole('alertdialog', { name: 'Remove Team notes?' })).getByRole('button', {
        name: 'Remove'
      })
    )
    await waitFor(() => expect(service.rows).toHaveLength(0))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Team notes/ })).toBeNull())
  })
})
