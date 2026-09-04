/**
 * MCP tool extension integration over the real connector database. Only the remote
 * MCP transport and private pro approval hook are faked boundaries.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUseApplication, parseActionProposal, type UseApplication } from '@offgrid/use'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-mcp-extension-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import { getDB } from '../database'
import { addConnector, listConnectors, setConnectorEnabled } from '../mcp'
import {
  McpConnectorToolExtension,
  type McpConnectorToolBoundary
} from '../tools/mcpConnectorToolExtension'
import type { ConnectorToolDefinition } from '../tools/mcpConnectorToolExtension-logic'
import { makeUseDriver } from '../actions/use-driver'
import { makeConnectorRailExecutor } from '../actions/connector-rail'
import type { ChatConnectorActionsPort } from '../actions/chat-connector-action'
import { gateHost, onActionParked } from '../actions/gate-host'
import { HOOKS, registerHook, unregisterHook } from '../bootstrap/hookRegistry'

interface ToolExecution {
  connectorId: number
  tool: string
  args: Record<string, unknown>
}

type ToolResult = { ok: boolean; result?: unknown; error?: string }

class FakeMcpBoundary implements McpConnectorToolBoundary {
  readonly tools = new Map<number, ConnectorToolDefinition[] | Error>()
  readonly results = new Map<string, ToolResult | Error>()
  readonly executions: ToolExecution[] = []
  actions?: ChatConnectorActionsPort

  async fetchTools(connectorId: number): Promise<ConnectorToolDefinition[]> {
    const tools = this.tools.get(connectorId) ?? []
    if (tools instanceof Error) {
      throw tools
    }
    return tools
  }

  async callTool(
    connectorId: number,
    tool: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    this.executions.push({ connectorId, tool, args })
    const result = this.results.get(tool) ?? { ok: true, result: null }
    if (result instanceof Error) {
      throw result
    }
    return result
  }
}

function realActionsPort(boundary: FakeMcpBoundary): ChatConnectorActionsPort {
  const execute = makeConnectorRailExecutor((connectorId, tool, args) =>
    boundary.callTool(connectorId, tool, args)
  )
  const application = createUseApplication({
    driver: makeUseDriver(getDB()),
    handlers: [
      {
        type: 'connector',
        rail: 'connector',
        defaultRisk: 'mutate',
        verification: 'none_fuzzy'
      }
    ],
    gate: gateHost,
    device: { execute },
    park: { onParked: () => () => {}, onActionParked: () => () => {} },
    scheduler: {
      every: (intervalMs, listener) => {
        const timer = setInterval(listener, intervalMs)
        timer.unref()
        return () => clearInterval(timer)
      },
      after: (delayMs, listener) => {
        const timer = setTimeout(listener, delayMs)
        timer.unref()
        return () => clearTimeout(timer)
      }
    },
    attemptTimeoutMs: 1_000
  })
  applications.push(application)
  return {
    async propose(input, meta) {
      const parsed = parseActionProposal(input)
      if (!parsed.ok) return { accepted: false, reason: parsed.error }
      return application.run({ proposal: parsed.value, ...meta })
    },
    waitForOutcome: (id, timeoutMs) => application.waitForOutcome(id, timeoutMs),
    onParked: onActionParked,
    kick: () => application.kick()
  }
}

let boundary: FakeMcpBoundary
let extension: McpConnectorToolExtension
const applications: UseApplication[] = []

beforeEach(() => {
  listConnectors()
  getDB().exec('DELETE FROM connectors')
  boundary = new FakeMcpBoundary()
  extension = new McpConnectorToolExtension(boundary)
})

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()))
})

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

function addHttpConnector(name: string): number {
  return addConnector({ name, transport: 'http', url: `https://${name.toLowerCase()}.example` })
}

describe('McpConnectorToolExtension with real connector state', () => {
  it('owns only namespaced MCP tools', () => {
    expect(extension.canHandle('mcp__3__list_x')).toBe(true)
    expect(extension.canHandle('generate_image')).toBe(false)
    expect(extension.canHandle('mcp_3_list_x')).toBe(false)
  })

  it('publishes schemas for enabled connectors and omits disabled connectors', async () => {
    const slackId = addHttpConnector('Slack')
    const disabledId = addHttpConnector('Disabled')
    setConnectorEnabled(disabledId, false)
    boundary.tools.set(slackId, [
      {
        name: 'send_message',
        description: 'Send a message',
        inputSchema: { type: 'object', required: ['text'] }
      }
    ])
    boundary.tools.set(disabledId, [{ name: 'should_not_appear' }])

    expect(await extension.schemas()).toEqual([
      {
        type: 'function',
        function: {
          name: `mcp__${slackId}__send_message`,
          description: '[Slack] Send a message',
          parameters: { type: 'object', required: ['text'] }
        }
      }
    ])
  })

  it('omits a failed connector while retaining healthy schemas', async () => {
    const failedId = addHttpConnector('Notion')
    const healthyId = addHttpConnector('Files')
    boundary.tools.set(failedId, new Error('Authorization required'))
    boundary.tools.set(healthyId, [{ name: 'read_file' }])

    const schemas = (await extension.schemas()) as { function: { name: string } }[]

    expect(schemas.map((schema) => schema.function.name)).toEqual([`mcp__${healthyId}__read_file`])
    const failed = listConnectors().find((connector) => connector.id === failedId)
    // The application service behind the production boundary owns discovery
    // persistence. This extension only projects the tools returned by its port.
    expect(failed?.status).toBe('unknown')
  })

  it('returns an error for a tool that was not registered by schema discovery', async () => {
    expect(await extension.execute('mcp__1__unknown', {})).toBe(
      'Error: unknown connector tool mcp__1__unknown'
    )
  })

  it('runs a Chat connector mutation through the durable engine while the Pro approval hook is active', async () => {
    const connectorId = addHttpConnector('Slack')
    boundary.tools.set(connectorId, [{ name: 'send_message' }])
    boundary.results.set('send_message', { ok: true, result: { messageId: 'slack-1' } })
    boundary.actions = realActionsPort(boundary)
    const proposeApproval = vi.fn(() => true)
    registerHook(HOOKS.actionsProposeApproval, proposeApproval)
    await extension.schemas()

    try {
      const output = await extension.execute(
        `mcp__${connectorId}__send_message`,
        { text: 'hi' },
        { conversationId: 'chat-slack-1' }
      )

      expect(output).toContain('"messageId":"slack-1"')
      expect(output).toContain('Action reference:')
      expect(output).not.toMatch(/queued|approval/i)
      expect(proposeApproval).not.toHaveBeenCalled()
      expect(boundary.executions).toEqual([
        { connectorId, tool: 'send_message', args: { text: 'hi' } }
      ])
    } finally {
      unregisterHook(HOOKS.actionsProposeApproval, proposeApproval)
    }
  })

  it('fails honestly when a Chat connector mutation has no durable engine', async () => {
    const connectorId = addHttpConnector('Slack')
    boundary.tools.set(connectorId, [{ name: 'send_message' }])
    await extension.schemas()

    const output = await extension.execute(
      `mcp__${connectorId}__send_message`,
      { text: 'hi' },
      { conversationId: 'chat-slack-2' }
    )

    expect(output).toContain('action engine')
    expect(output).toContain('No approval was created')
    expect(output).not.toContain('Queued')
    expect(boundary.executions).toEqual([])
  })

  it('runs read tools directly and returns the remote result', async () => {
    const connectorId = addHttpConnector('Slack')
    boundary.tools.set(connectorId, [{ name: 'list_channels' }])
    boundary.results.set('list_channels', { ok: true, result: { channels: ['general'] } })
    await extension.schemas()

    expect(await extension.execute(`mcp__${connectorId}__list_channels`, {})).toBe(
      '{"channels":["general"]}'
    )
    expect(boundary.executions).toEqual([{ connectorId, tool: 'list_channels', args: {} }])
  })

  it('returns connector failures and thrown transport errors as error strings', async () => {
    const connectorId = addHttpConnector('Files')
    boundary.tools.set(connectorId, [{ name: 'get_failed' }, { name: 'get_thrown' }])
    boundary.results.set('get_failed', { ok: false, error: 'remote failure' })
    boundary.results.set('get_thrown', new Error('network down'))
    await extension.schemas()

    expect(await extension.execute(`mcp__${connectorId}__get_failed`, {})).toBe(
      'Error: remote failure'
    )
    expect(await extension.execute(`mcp__${connectorId}__get_thrown`, {})).toBe(
      'Error: network down'
    )
  })
})
