// @vitest-environment jsdom
/**
 * RELEASE_TEST_CHECKLIST #71 - connector setup through the real product seam.
 *
 * The real Integrations screen drives production connector persistence, production MCP discovery,
 * and a real stdio MCP child process. Electron IPC is the native boundary, represented only by a
 * direct bridge to the same functions its handlers invoke. Closing and reopening SQLite proves the
 * connected row and discovered tools survive exactly once.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fs from 'fs'
import os from 'os'
import path from 'path'
import React from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-mcp-setup-'))
const MCP_SERVER = path.resolve(
  process.cwd(),
  'src/main/__tests__/fixtures/mcp-reachable-server.mjs'
)

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  shell: { openExternal: async () => {} }
}))

beforeEach(async () => {
  const { getDB } = await import('@offgrid/core/main/database')
  const { listConnectors } = await import('@offgrid/core/main/mcp')
  listConnectors()
  getDB().exec('DELETE FROM connectors')
})

afterEach(() => cleanup())

afterAll(async () => {
  const { getDB } = await import('@offgrid/core/main/database')
  try {
    getDB().close()
  } catch {
    // The persistence assertion deliberately closes the first connection.
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('<ConnectorsScreen/> connector setup', () => {
  it('persists one reachable connector and reports its discovered connected state (#71)', async () => {
    const connectorRepository = await import('@offgrid/core/main/mcp')
    Object.assign(window, {
      api: {
        mcpList: async () => connectorRepository.listConnectors(),
        mcpAdd: connectorRepository.addConnector,
        mcpTest: connectorRepository.testConnector,
        mcpSetEnabled: connectorRepository.setConnectorEnabled,
        mcpRemove: connectorRepository.removeConnector,
        mcpItems: async () => [],
        mcpIngest: async () => ({ ok: true, count: 0 })
      }
    })

    const { ConnectorsScreen } = await import('@renderer/components/ConnectorsScreen')
    const user = userEvent.setup()
    render(React.createElement(ConnectorsScreen))

    await screen.findByText('Nothing connected yet. Pick one above.')
    await user.click(screen.getByRole('button', { name: /custom/i }))
    await user.click(screen.getByRole('button', { name: 'stdio (local)' }))
    await user.type(screen.getByPlaceholderText('Name'), 'Reachable synthetic MCP')
    await user.type(screen.getByPlaceholderText('command (e.g. npx)'), process.execPath)
    await user.type(screen.getByPlaceholderText('args'), MCP_SERVER)
    await user.click(screen.getByRole('button', { name: 'Add' }))

    const installedRow = await screen.findByRole('button', { name: /Reachable synthetic MCP/ })
    expect(within(installedRow).getByText('not tested')).not.toBeNull()
    await user.click(installedRow)
    await user.click(await screen.findByRole('button', { name: 'Test' }))

    await waitFor(() => {
      expect(screen.getByText('connected')).not.toBeNull()
      expect(screen.getByText('read_status')).not.toBeNull()
    })
    expect(screen.queryByText('not tested')).toBeNull()

    const { getDB } = await import('@offgrid/core/main/database')
    getDB().close()
    vi.resetModules()

    const reopenedDatabase = await import('@offgrid/core/main/database')
    const reopenedRepository = await import('@offgrid/core/main/mcp')
    const persisted = reopenedRepository.listConnectors()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      name: 'Reachable synthetic MCP',
      status: 'ok'
    })
    expect(JSON.parse(persisted[0]!.tools!)).toEqual([
      expect.objectContaining({
        name: 'read_status',
        description: 'Returns the synthetic connector status.'
      })
    ])
    const count = reopenedDatabase
      .getDB()
      .prepare('SELECT COUNT(*) AS count FROM connectors WHERE name = ?')
      .get('Reachable synthetic MCP') as { count: number }
    expect(count.count).toBe(1)
    reopenedDatabase.getDB().close()
  })
})
