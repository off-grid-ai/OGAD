/**
 * Changing a connector over the real connector database and secret store. Electron's userData
 * directory and its encryption are the only boundaries replaced.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-mcp-update-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import { getDB } from '../database'
import { HOOKS, registerHook, unregisterHook } from '../bootstrap/hookRegistry'
import {
  addConnector,
  listConnectors,
  removeConnector,
  setConnectorSecrets,
  testConnector,
  updateConnector
} from '../mcp'
import { getSecret, setSecret } from '../secrets'

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

function connected(id: number): void {
  getDB()
    .prepare("UPDATE connectors SET status='ok', tools=? WHERE id=?")
    .run(JSON.stringify([{ name: 'search_notes' }]), id)
  setSecret(`connector:${id}:oauth:tokens`, '{"access_token":"synthetic"}')
  setSecret(`connector:${id}:API_TOKEN`, 'synthetic-token')
}

describe('updateConnector', () => {
  it('renames without signing out or forgetting tools', () => {
    const id = addConnector({ name: 'Notes', transport: 'http', url: 'https://a.example.test/mcp' })
    connected(id)

    updateConnector(id, { name: '  Team notes ', url: 'https://a.example.test/mcp' })

    const row = listConnectors().find((c) => c.id === id)!
    expect(row).toMatchObject({ name: 'Team notes', status: 'ok' })
    expect(row.tools).toContain('search_notes')
    expect(getSecret(`connector:${id}:oauth:tokens`)).not.toBeNull()
  })

  it('a new address signs out of the old server and waits for a new test, keeping the token', () => {
    const id = addConnector({ name: 'Notes', transport: 'http', url: 'https://a.example.test/mcp' })
    connected(id)

    updateConnector(id, { url: 'https://b.example.test/mcp' })

    const row = listConnectors().find((c) => c.id === id)!
    expect(row).toMatchObject({
      url: 'https://b.example.test/mcp',
      status: 'unknown',
      status_detail: 'Settings changed. Test the connection.',
      tools: null
    })
    expect(getSecret(`connector:${id}:oauth:tokens`)).toBeNull()
    expect(getSecret(`connector:${id}:API_TOKEN`)).toBe('synthetic-token')
  })

  it('changes the command and arguments of a local server', () => {
    const id = addConnector({ name: 'Local', transport: 'stdio', command: 'node', args: ['a.js'] })

    updateConnector(id, { command: 'npx', args: ['server', '--port', '0'] })
    expect(listConnectors().find((c) => c.id === id)).toMatchObject({
      command: 'npx',
      args: JSON.stringify(['server', '--port', '0']),
      url: null
    })
  })

  it("a new command does not inherit the old one's secrets", () => {
    // Review finding: the new command started with the old command's environment secrets.
    const id = addConnector({
      name: 'Local',
      transport: 'stdio',
      command: 'node',
      args: ['a.js'],
      envKeys: ['API_TOKEN']
    })
    connected(id)
    updateConnector(id, { name: 'Local notes' })
    expect(getSecret(`connector:${id}:API_TOKEN`)).toBe('synthetic-token')

    updateConnector(id, { command: 'npx', args: ['other-server'] })
    expect(getSecret(`connector:${id}:API_TOKEN`)).toBeNull()
    expect(listConnectors().find((c) => c.id === id)).toMatchObject({ env_keys: null })

    // Review finding: "Change token" saved the new token, but nothing passed it to the command.
    setConnectorSecrets(id, { API_TOKEN: 'new-synthetic-token', 'bad key': 'x' })
    expect(getSecret(`connector:${id}:API_TOKEN`)).toBe('new-synthetic-token')
    expect(listConnectors().find((c) => c.id === id)).toMatchObject({
      env_keys: JSON.stringify(['API_TOKEN'])
    })
  })

  it('refuses an empty name, an empty address, and a removed connector', () => {
    const id = addConnector({ name: 'Notes', transport: 'http', url: 'https://a.example.test/mcp' })
    expect(() => updateConnector(id, { name: ' ' })).toThrow('Enter a name.')
    expect(() => updateConnector(id, { url: '' })).toThrow('Enter the server address.')
    removeConnector(id)
    expect(() => updateConnector(id, { name: 'Back' })).toThrow('This connection no longer exists.')
  })
})

describe('testConnector', () => {
  it('saves the tools for the services granted at sign-in, not the ones it started with', async () => {
    // Review finding: the first test saved tools for services the user declined at consent.
    let granted = ['mail', 'files']
    registerHook(HOOKS.mcpConnectorToolSource, () => ({
      tools: granted.map((service) => ({ name: `${service}_search` })),
      authorize: async () => {
        granted = ['mail']
      },
      verify: async () => undefined,
      callTool: async () => ({ ok: true, text: '' })
    }))
    try {
      const id = addConnector({
        name: 'Work',
        transport: 'http',
        url: 'https://a.example.test/mcp'
      })
      expect(await testConnector(id)).toMatchObject({ ok: true, tools: [{ name: 'mail_search' }] })
      expect(JSON.parse(listConnectors().find((c) => c.id === id)!.tools!)).toEqual([
        { name: 'mail_search' }
      ])
    } finally {
      unregisterHook(HOOKS.mcpConnectorToolSource)
    }
  })
})
