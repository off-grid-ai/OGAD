// @vitest-environment jsdom

/**
 * One pull at a time from a connector's detail view.
 *
 * While a pull is running, pressing Enter in the "Ask … for" field must not start a second one:
 * the Pull button is disabled then, and Enter follows the same rule. The real connectors screen
 * runs; the main-process connector service is the only fake, answering over the preload API the
 * way it does in the app, and its record of started pulls is what the test reads.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(() => {
  cleanup()
})

function installConnectorService(): { pulls: Array<string | undefined>; finishPull: () => void } {
  const pulls: Array<string | undefined> = []
  let finish: (() => void) | undefined
  ;(window as unknown as { api: unknown }).api = {
    mcpList: async () => [
      {
        id: 7,
        name: 'Gmail',
        transport: 'http',
        command: null,
        args: null,
        url: 'https://gmail.example/mcp',
        enabled: 1,
        status: 'ok',
        status_detail: null,
        tools: null,
        last_synced: null,
        synced_count: 0
      }
    ],
    mcpItems: async () => [],
    mcpIngest: (_id: number, query?: string) => {
      pulls.push(query)
      return new Promise<{ ok: true; count: number }>((resolve) => {
        finish = () => resolve({ ok: true, count: 1 })
      })
    }
  }
  return { pulls, finishPull: () => finish?.() }
}

describe('connector pull while a pull is running', () => {
  it('ignores Enter until the running pull finishes', async () => {
    const service = installConnectorService()
    const { ConnectorsScreen } = await import('../ConnectorsScreen')
    const user = userEvent.setup()
    render(<ConnectorsScreen />)

    await user.click(await screen.findByRole('button', { name: /Gmail.*connected/i }))
    const field = await screen.findByPlaceholderText(/Ask Gmail for/i)
    await user.type(field, 'invoices{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Pull' })).toHaveProperty('disabled', true)
    )

    await user.type(field, '{Enter}')
    await user.type(field, '{Enter}')
    expect(service.pulls).toEqual(['invoices'])

    service.finishPull()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Pull' })).toHaveProperty('disabled', false)
    )
    await user.type(field, '{Enter}')
    expect(service.pulls).toEqual(['invoices', 'invoices'])
  })
})
