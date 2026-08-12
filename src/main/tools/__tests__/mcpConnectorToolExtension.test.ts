import { describe, expect, it } from 'vitest'
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
