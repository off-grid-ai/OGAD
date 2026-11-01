/**
 * Connector rail adapter for the durable action engine.
 *
 * The engine owns identity, idempotency, state and audit. This adapter owns only
 * validation of the connector payload and one call through the existing connector
 * transport boundary.
 */
import type { ActionRecord, ExecuteResult } from '@offgrid/use'

interface ConnectorCallResult {
  ok: boolean
  result?: unknown
  error?: string
}

export type CallConnector = (
  connectorId: number,
  tool: string,
  args: Record<string, unknown>
) => Promise<ConnectorCallResult>

export interface ConnectorActionArgs {
  connectorId: number
  tool: string
  args: Record<string, unknown>
}

export function connectorActionArgs(value: Record<string, unknown>): ConnectorActionArgs | null {
  const connectorId = value.connectorId
  const tool = value.tool
  const args = value.args
  if (
    !Number.isSafeInteger(connectorId) ||
    Number(connectorId) <= 0 ||
    typeof tool !== 'string' ||
    !tool.trim() ||
    typeof args !== 'object' ||
    args === null ||
    Array.isArray(args)
  ) {
    return null
  }
  return {
    connectorId: Number(connectorId),
    tool,
    args: args as Record<string, unknown>
  }
}

function resultDetail(value: unknown): string {
  let output: string
  if (typeof value === 'string') output = value
  else if (value === undefined) output = 'Connector action completed.'
  else {
    try {
      output = JSON.stringify(value)
    } catch {
      output = 'Connector action completed.'
    }
  }
  return output.length > 8_000 ? `${output.slice(0, 8_000)}… (truncated)` : output
}

/** The tool's own report of failure (MCP `isError`), as words a person can read. Null when it acted. */
function toolFailure(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const reply = value as { isError?: unknown; content?: unknown }
  if (reply.isError !== true) return null
  const parts = (Array.isArray(reply.content) ? reply.content : []) as Array<{
    type?: unknown
    text?: unknown
  } | null>
  const text = parts
    .filter(
      (part): part is { type: 'text'; text: string } =>
        part?.type === 'text' && typeof part.text === 'string'
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join(' ')
  return text ? resultDetail(text) : 'The connector reported that the action failed.'
}

export function makeConnectorRailExecutor(callConnector: CallConnector) {
  return async (action: ActionRecord): Promise<ExecuteResult> => {
    const parsed = connectorActionArgs(action.args)
    if (!parsed) {
      return { ok: false, detail: 'invalid connector action payload' }
    }
    try {
      const result = await callConnector(parsed.connectorId, parsed.tool, parsed.args)
      if (!result.ok) return { ok: false, detail: result.error ?? 'connector call failed' }
      // A tool can answer and still say it failed; that is not an executed action.
      const failure = toolFailure(result.result)
      return failure
        ? { ok: false, detail: failure }
        : { ok: true, detail: resultDetail(result.result) }
    } catch (error) {
      return { ok: false, detail: `connector rail failed: ${(error as Error).message}` }
    }
  }
}
