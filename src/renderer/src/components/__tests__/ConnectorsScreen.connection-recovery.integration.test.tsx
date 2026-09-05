// @vitest-environment jsdom

/**
 * Connector recovery through the real Integrations screen. The Electron MCP bridge is the only
 * fake boundary; Shared owns the failure sentence and the screen owns the retry transition.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

interface ConnectorRow {
  id: number
  name: string
  transport: 'http'
  command: null
  args: null
  url: string
  enabled: number
  status: string
  status_detail: null
  tools: null
  last_synced: null
  synced_count: number
}

class ConnectorBoundary {
  private attempts = 0
  private connected = false

  readonly row: ConnectorRow = {
    id: 17,
    name: 'Notion',
    transport: 'http',
    command: null,
    args: null,
    url: 'https://mcp.notion.com/mcp',
    enabled: 1,
    status: 'ok',
    status_detail: null,
    tools: null,
    last_synced: null,
    synced_count: 0
  }

  readonly api = {
    mcpList: async (): Promise<ConnectorRow[]> => (this.connected ? [this.row] : []),
    mcpAdd: async (): Promise<number> => this.row.id,
    mcpTest: async (): Promise<{ ok: boolean; error?: string }> => {
      this.attempts += 1
      if (this.attempts === 1) return { ok: false, error: 'network fetch failed' }
      this.connected = true
      return { ok: true }
    },
    mcpRemove: async (): Promise<void> => undefined
  }
}

afterEach(cleanup)

describe('<ConnectorsScreen/> connection recovery', () => {
  it('explains an unreachable service and shows the connector as connected after retry', async () => {
    const boundary = new ConnectorBoundary()
    Object.defineProperty(window, 'api', { configurable: true, value: boundary.api })
    const { ConnectorsScreen } = await import('../ConnectorsScreen')
    const user = userEvent.setup()
    render(<ConnectorsScreen />)

    const notionCard = (await screen.findByText('Notion')).closest('div.flex.flex-col')
    expect(notionCard).toBeTruthy()
    await user.click(
      within(notionCard as HTMLElement).getByRole('button', { name: 'Connect with OAuth' })
    )

    expect(
      await within(notionCard as HTMLElement).findByText('Could not reach the server.')
    ).toBeTruthy()
    await user.click(
      within(notionCard as HTMLElement).getByRole('button', { name: 'Connect with OAuth' })
    )

    const connected = await screen.findByRole('button', { name: /Notion.*connected/i })
    expect(connected).toBeTruthy()
    expect(screen.queryByText('Could not reach the server.')).toBeNull()
  })
})
