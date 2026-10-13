import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('../../mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp')>()),
  listConnectors: () => [{ id: 7, name: 'Test', enabled: true }],
  fetchTools: vi.fn(),
  callConnectorTool: vi.fn(),
  setConnectorStatus: vi.fn()
}))
vi.mock('../../database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../database')>()),
  getSetting: (_key: string, fallback: unknown) => fallback
}))
vi.mock('../../llm', () => ({ llm: { effectiveContextSize: () => 8192 } }))

import { McpConnectorToolExtension } from '../mcpConnectorToolExtension'
import {
  registerToolExtension,
  unregisterToolExtension,
  selectChatTools,
  runTool,
  type ToolContext,
  type ToolExtension
} from '../../tools'
import { PAIRED_BROWSER_AGENT_MODE_REFUSAL } from '../tool-origin'
import type { ConnectorToolDefinition } from '../../mcp'
import {
  buildConnectorToolSchema,
  formatConnectorToolResult,
  isActionTool,
  riskOf
} from '../mcpConnectorToolExtension-logic'
import { shouldGate } from '../../actions/approval'

describe('isActionTool', () => {
  it.each([
    'list_channels',
    'get_user',
    'search_docs',
    'read_file',
    'fetch_url',
    'whoami_now',
    'describe_table'
  ])('treats read-verb tool %s as a non-action', (tool) => {
    expect(isActionTool(tool)).toBe(false)
  })

  it.each([
    'whoami',
    'send_message',
    'create_issue',
    'delete_record',
    'update_row',
    'post_comment',
    'getter_run',
    'unlist_item'
  ])('treats tool %s as an action', (tool) => {
    expect(isActionTool(tool)).toBe(true)
  })

  it('matches read verbs case-insensitively with a hyphen separator', () => {
    expect(isActionTool('LIST-things')).toBe(false)
    expect(isActionTool('Get-Thing')).toBe(false)
  })
})

describe('riskOf', () => {
  it('maps read-verb tools to a non-gating read risk', () => {
    for (const tool of ['list_channels', 'get_user', 'search_docs', 'read_file']) {
      expect(riskOf(tool)).toBe('read')
      expect(shouldGate(riskOf(tool))).toBe(false)
    }
  })

  it('maps every other tool to a gating mutate risk', () => {
    for (const tool of ['send_message', 'create_issue', 'delete_record']) {
      expect(riskOf(tool)).toBe('mutate')
      expect(shouldGate(riskOf(tool))).toBe(true)
    }
  })

  it('agrees with isActionTool on which tools gate', () => {
    for (const tool of ['list_channels', 'send_message', 'get_user', 'delete_record']) {
      expect(shouldGate(riskOf(tool))).toBe(isActionTool(tool))
    }
  })
})

describe('buildConnectorToolSchema', () => {
  it('namespaces the tool and retains its description and input schema', () => {
    expect(
      buildConnectorToolSchema(
        { id: 7, name: 'Slack' },
        {
          name: 'send_message',
          description: 'Send a message',
          inputSchema: { type: 'object', required: ['text'] }
        }
      )
    ).toEqual({
      type: 'function',
      function: {
        name: 'mcp__7__send_message',
        description: '[Slack] Send a message',
        parameters: { type: 'object', required: ['text'] }
      }
    })
  })

  it('uses the tool name and an empty object schema when metadata is absent', () => {
    expect(buildConnectorToolSchema({ id: 1, name: 'Files' }, { name: 'get_file' })).toEqual({
      type: 'function',
      function: {
        name: 'mcp__1__get_file',
        description: '[Files] get_file',
        parameters: { type: 'object', properties: {} }
      }
    })
  })
})

describe('formatConnectorToolResult', () => {
  it('preserves strings and serializes structured results', () => {
    expect(formatConnectorToolResult('general, random')).toBe('general, random')
    expect(formatConnectorToolResult({ channel: 'general' })).toBe('{"channel":"general"}')
  })

  it('truncates only output longer than 8000 characters', () => {
    expect(formatConnectorToolResult('x'.repeat(8000))).toBe('x'.repeat(8000))
    expect(formatConnectorToolResult('x'.repeat(8001))).toBe(`${'x'.repeat(8000)}… (truncated)`)
  })
})

const connectorDefinitions: ConnectorToolDefinition[] = [
  { name: 'get_safe', annotations: { readOnlyHint: true } },
  { name: 'get_write', annotations: { readOnlyHint: false } },
  { name: 'get_unknown' },
  { name: 'get_missing_hint', annotations: {} },
  { name: 'get_destructive', annotations: { readOnlyHint: true, destructiveHint: true } }
]

function connectorFixture(): {
  extension: McpConnectorToolExtension
  fetchTools: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
} {
  const fetchTools = vi.fn(async () => connectorDefinitions)
  const callTool = vi.fn(async () => ({ ok: true, result: 'done' }))
  return {
    extension: new McpConnectorToolExtension({ fetchTools, callTool }),
    fetchTools,
    callTool
  }
}

describe('paired-browser connector admission', () => {
  afterEach(() => {
    unregisterToolExtension('mcp-connectors')
    unregisterToolExtension('pro-like')
  })

  it.each([
    { origin: 'bridge' as const, assistantOnly: false, all: false },
    { origin: 'bridge' as const, assistantOnly: true, all: true },
    { origin: 'desktop' as const, assistantOnly: false, all: true },
    { origin: undefined, assistantOnly: false, all: true }
  ])('selects declared reads for $origin acting=$assistantOnly', async (opts) => {
    const { extension } = connectorFixture()
    registerToolExtension(extension)
    const selected = await selectChatTools(undefined, { ...opts, connectors: true })
    const connectorSchemas = selected.tools.filter((schema) =>
      (schema as { function: { name: string } }).function.name.startsWith('mcp__')
    )
    expect(connectorSchemas).toEqual(
      connectorDefinitions
        .filter((tool) => opts.all || tool.name === 'get_safe')
        .map((tool) => buildConnectorToolSchema({ id: 7, name: 'Test' }, tool))
    )
    expect(JSON.stringify(connectorSchemas)).not.toContain('annotations')
  })

  it.each(['get_write', 'get_unknown', 'get_missing_hint', 'get_destructive'])(
    'refuses %s before dispatch and at direct execution',
    async (tool) => {
      const { extension, callTool } = connectorFixture()
      await extension.schemas()
      const execute = vi.spyOn(extension, 'execute')
      const name = `mcp__7__${tool}`
      const context: ToolContext = { origin: 'bridge', acting: false }
      const refused = {
        text: PAIRED_BROWSER_AGENT_MODE_REFUSAL,
        status: 'failed',
        authoritative: true
      }
      expect(await runTool(name, {}, context, [extension])).toEqual(refused)
      expect(execute).not.toHaveBeenCalled()
      expect(await extension.execute(name, {}, context)).toEqual(refused)
      expect(callTool).not.toHaveBeenCalled()
    }
  )

  it.each<ToolContext>([{ origin: 'bridge', acting: true }, { origin: 'desktop' }, {}])(
    'allows writes in an authorized context %j',
    async (context) => {
      const { extension, callTool } = connectorFixture()
      await extension.schemas()
      expect(await runTool('mcp__7__get_write', {}, context, [extension])).toEqual({ text: 'done' })
      expect(callTool).toHaveBeenCalledOnce()
    }
  )

  it('executes a declared read in plain browser chat', async () => {
    const { extension, callTool } = connectorFixture()
    await extension.schemas()
    expect(await runTool('mcp__7__get_safe', {}, { origin: 'bridge' }, [extension])).toEqual({
      text: 'done'
    })
    expect(callTool).toHaveBeenCalledOnce()
  })

  it('clears old read declarations when schemas reload', async () => {
    const { extension, fetchTools } = connectorFixture()
    await extension.schemas()
    fetchTools.mockResolvedValue([{ name: 'get_safe' }])
    await extension.schemas()
    expect(extension.isReadOnlyTool('mcp__7__get_safe')).toBe(false)
    expect(extension.isReadOnlyTool('mcp__7__absent')).toBe(false)
  })

  it.each(['tool', 'connector', undefined] as const)(
    'refuses category %s without a read-only declaration',
    async (category) => {
      const execute = vi.fn(() => 'done')
      const extension: ToolExtension = {
        id: 'pro-like',
        category,
        schemas: () => [{ type: 'function', function: { name: 'schedule_task' } }],
        canHandle: (name) => name === 'schedule_task',
        execute
      }
      registerToolExtension(extension)
      const selected = await selectChatTools(undefined, { origin: 'bridge', connectors: true })
      const offered = selected.tools.some(
        (schema) => (schema as { function: { name: string } }).function.name === 'schedule_task'
      )
      expect(offered).toBe(false)
      const result = await runTool('schedule_task', {}, { origin: 'bridge' }, [extension])
      expect(result.text).toBe(PAIRED_BROWSER_AGENT_MODE_REFUSAL)
      expect(execute).not.toHaveBeenCalled()
    }
  )
})

describe('builtin bridge admission', () => {
  it.each([
    { origin: 'bridge' as const, assistantOnly: false, writeAllowed: false },
    { origin: 'bridge' as const, assistantOnly: true, writeAllowed: true },
    { origin: 'desktop' as const, assistantOnly: false, writeAllowed: true }
  ])('filters schemas and dispatches for %j', async ({ writeAllowed, ...opts }) => {
    const selected = await selectChatTools(undefined, {
      ...opts,
      imageAvailable: true,
      allTools: true
    })
    const names = selected.tools.map(
      (schema) => (schema as { function: { name: string } }).function.name
    )
    expect(names).toContain('calculator')
    expect(names.includes('generate_image')).toBe(writeAllowed)
    const context: ToolContext = { origin: opts.origin, acting: opts.assistantOnly }
    expect(await runTool('calculator', { expression: '2+3' }, context, [])).toEqual({ text: '5' })
    const result = await runTool('generate_image', { prompt: 'A tree' }, context, [])
    if (writeAllowed) expect(result.imageRequest).toEqual({ prompt: 'A tree' })
    else
      expect(result).toEqual({
        text: PAIRED_BROWSER_AGENT_MODE_REFUSAL,
        status: 'failed',
        authoritative: true
      })
    if (!writeAllowed) {
      expect(await runTool('unknown_tool', {}, context, [])).toEqual({
        text: PAIRED_BROWSER_AGENT_MODE_REFUSAL,
        status: 'failed',
        authoritative: true
      })
    }
  })
})
